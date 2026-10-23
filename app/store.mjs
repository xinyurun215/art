import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { LIMITS, SERVER_LIMITS, finishRevisionRequest } from './state.mjs';

const failure = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
const conflict = () => failure('PROJECT_STORAGE_CONFLICT', '项目已变化或执行许可已失效；请重新读取，未覆盖已保存内容。', 409);
const keys = Object.keys(LIMITS);

export function interruptProject(project, detail) {
  if (project.revisionRequest?.status === 'running') finishRevisionRequest(project, project.revisionRequest, 'interrupted', detail);
  project.status = { phase: 'interrupted', detail };
  const run = project.runtime.runs?.at(-1);
  if (run?.status === 'running') Object.assign(run, { status: 'interrupted', finishedAt: new Date().toISOString() });
}

// One database run owns the demo-wide cap and one execution lease. No queue or replay.
export function createPostgresStore({ connectionString, pool = new pg.Pool({ connectionString, max: 2,
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 }), runId = 'protected-preview-v1', env = {} } = {}) {
  const names = ['ART_MODEL_HTTP_LIMIT', 'ART_QLOO_HTTP_LIMIT'];
  const limits = Object.fromEntries(keys.map((key, index) => {
    const value = env[names[index]] === undefined ? LIMITS[key] : Number(env[names[index]]);
    if (!Number.isSafeInteger(value) || value < 0 || String(env[names[index]] ?? value).trim() === '')
      throw failure('HTTP_BUDGET_CONFIG_INVALID', 'HTTP 预算配置无效；未启用请求。');
    return [key, value];
  }));
  const sharedLimits = names.some(name => env[name] !== undefined) ? { ...limits } : { ...SERVER_LIMITS };
  async function transaction(operation) {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(`INSERT INTO art_budget_runs(id, limits, shared_limits) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [runId, limits, sharedLimits]);
      const run = (await client.query('SELECT * FROM art_budget_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
      if (keys.some(key => run.limits[key] !== limits[key] || run.shared_limits[key] !== sharedLimits[key]))
        throw failure('HTTP_BUDGET_CONFIG_INVALID', '共享预算与已保存配置不同；不能重置或扩大额度。');
      const value = await operation(client, run);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { /* Commit uncertainty never permits HTTP or an automatic retry. */ }
      if (error.statusCode) throw error;
      throw failure('PROJECT_STORE_UNAVAILABLE', '数据库操作未确认成功；未发布候选状态或自动重试，请重新读取核对。');
    } finally { client?.release(); }
  }
  const rowFor = async (client, id) => {
    const row = (await client.query('SELECT * FROM art_projects WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (row && row.run_id !== runId) throw conflict();
    return row;
  };
  function current(row, project) {
    if (!row || row.revision !== project.storageVersion) throw conflict();
  }
  async function write(client, project, token, leaseUntil = null) {
    const next = structuredClone(project);
    next.storageVersion = (project.storageVersion ?? 0) + 1;
    const parameters = [next.id, runId, next.storageVersion, next, token, leaseUntil];
    if (project.storageVersion === undefined) await client.query(
      'INSERT INTO art_projects(id,run_id,revision,state,lease_token,lease_until) VALUES($1,$2,$3,$4,$5,$6)', parameters);
    else if (!(await client.query(`UPDATE art_projects SET revision=$3,state=$4,lease_token=$5,lease_until=$6
      WHERE id=$1 AND run_id=$2 AND revision=$7`, [...parameters, project.storageVersion])).rowCount) throw conflict();
    return next;
  }
  async function stopped(client, project) {
    if (project.mode !== 'live') return;
    await client.query(`UPDATE art_budget_runs SET live_stopped=live_stopped OR $2,query_stopped=query_stopped OR $3 WHERE id=$1`,
      [runId, Boolean(project.runtime.infrastructureStopped || (project.runtime.failure && project.runtime.failure.kind !== 'qloo')
        || (project.runtime.localFailure && project.runtime.localFailure.kind !== 'qloo') || project.status.phase === 'interrupted'),
      Boolean(project.runtime.queryStopped || project.runtime.failure?.kind === 'qloo' || project.runtime.localFailure?.kind === 'qloo')]);
  }
  return { limits, sharedLimits,
    async get(id, { guestOwner } = {}) {
      if (guestOwner === null) return null;
      return transaction(async (client, run) => {
        const row = await rowFor(client, id);
        if (!row) return null;
        if (guestOwner !== undefined && row.state.guestOwner !== guestOwner) return null;
        const attempts = (await client.query('SELECT detail FROM art_http_attempts WHERE project_id=$1 AND run_id=$2', [id, runId])).rows;
        const confirmed = new Map(attempts.map(({ detail }) => [detail.id, detail]));
        if (row.state.runtime.httpAttempts) row.state.runtime.httpAttempts = row.state.runtime.httpAttempts.map(attempt => confirmed.get(attempt.id) ?? attempt);
        if (row.lease_token && new Date(row.lease_until) <= new Date()) {
          interruptProject(row.state, '执行许可已过期，上一轮可能被平台中断；已预留请求不退款、不自动重复。');
          const next = await write(client, row.state, null);
          await stopped(client, next);
          if (run.lease_token === row.lease_token) await client.query('UPDATE art_budget_runs SET lease_token=NULL,lease_project=NULL,lease_until=NULL WHERE id=$1', [runId]);
          return next;
        }
        return row.state;
      });
    },
    async save(project, { token = null, start = false, leaseMs = 270000 } = {}) {
      return transaction(async (client, run) => {
        const row = await rowFor(client, project.id);
        if (project.storageVersion === undefined) { if (row) throw conflict(); }
        else current(row, project);
        if (start) {
          if (run.lease_token && new Date(run.lease_until) <= new Date())
            throw failure('RUN_RECOVERY_REQUIRED', '上一轮执行许可已过期；请先读取原项目核对中断状态和请求账本，未启动新轮次。', 409);
          if (row?.lease_token || (run.lease_token && new Date(run.lease_until) > new Date()))
            throw failure('RUNTIME_BUSY', '已有任务执行中；没有将本请求加入后台队列。', 409);
          if (project.mode === 'live' && run.live_stopped) throw failure('VALIDATION_RUN_STOPPED', '共享真实运行已停止；没有发出请求。', 409);
          token = randomUUID();
          const deadline = new Date(Date.now() + leaseMs);
          const candidate = structuredClone(project);
          if (candidate.mode === 'live' && run.query_stopped) candidate.runtime.queryStopped = true;
          (candidate.runtime.runs ??= []).push({ id: token, status: 'running', startedAt: new Date().toISOString(), deadline: deadline.toISOString() });
          await client.query('UPDATE art_budget_runs SET lease_token=$2,lease_project=$3,lease_until=$4 WHERE id=$1', [runId, token, project.id, deadline]);
          return { project: await write(client, candidate, token, deadline), token, usage: run.usage };
        }
        if ((row?.lease_token ?? null) !== token || (token && new Date(row.lease_until) <= new Date())) throw conflict();
        await stopped(client, project);
        const next = await write(client, project, null);
        if (token) await client.query('UPDATE art_budget_runs SET lease_token=NULL,lease_project=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2', [runId, token]);
        return next;
      });
    },
    async reserve(project, token, detail) {
      return transaction(async (client, run) => {
        const row = await rowFor(client, project.id);
        current(row, project);
        if (row.lease_token !== token || run.lease_token !== token || new Date(row.lease_until) <= new Date()) throw conflict();
        const key = detail.kind === 'model' ? 'modelHttpAttempts' : 'qlooHttpAttempts';
        if (run.live_stopped || project.runtime.infrastructureStopped || (project.runtime.failure && project.runtime.failure.kind !== 'qloo') || project.status.phase === 'interrupted'
          || (detail.kind === 'qloo' && (run.query_stopped || project.runtime.queryStopped)))
          throw failure('VALIDATION_RUN_STOPPED', '共享真实运行已停止；没有发出请求。', 409);
        if (row.state.usage[key] >= limits[key] || run.usage[key] >= sharedLimits[key])
          throw failure('HTTP_BUDGET_EXHAUSTED', '共享或项目 HTTP 总额度已用尽；没有发出请求。', 409);
        if ((await client.query('SELECT id FROM art_http_attempts WHERE id=$1', [detail.id])).rowCount) throw conflict();
        const next = structuredClone(project);
        next.usage[key] = row.state.usage[key] + 1;
        (next.runtime.httpAttempts ??= []).push(detail);
        const usage = { ...run.usage, [key]: run.usage[key] + 1 };
        await client.query('UPDATE art_budget_runs SET usage=$2,query_stopped=query_stopped OR $3 WHERE id=$1', [runId, usage, Boolean(project.runtime.queryStopped)]);
        await client.query('INSERT INTO art_http_attempts(id,run_id,project_id,run_token,kind,detail) VALUES($1,$2,$3,$4,$5,$6)',
          [detail.id, runId, project.id, token, detail.kind, detail]);
        return { project: await write(client, next, token, row.lease_until), usage };
      });
    },
    async finishAttempt(id, detail) {
      return transaction(async client => {
        await client.query('UPDATE art_http_attempts SET detail=$3 WHERE id=$1 AND run_id=$2', [id, runId, detail]);
      });
    },
    close: () => pool.end(),
  };
}
