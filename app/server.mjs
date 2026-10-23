import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProject, action, configStatus, answerClarification, selectConcept, beginRevision, beginPendingFeedback,
  finishRevisionRequest, decideRevision } from './state.mjs';
import { createProductRuntime } from './runtime.mjs';
import { createHttpBudget, bindDatabaseBudget, validationRun, stopLiveRun, safeRuntimeFailure } from './transport.mjs';
import { pendingReference, respondToReference, referenceQuestion } from './references.mjs';
import { interruptProject } from './store.mjs';

const publicRoot = fileURLToPath(new URL('../public', import.meta.url));
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
let databaseExecutionActive = false;

function publicProject(project) {
  const safe = structuredClone(project);
  delete safe.guestOwner;
  safe.runtime = Object.fromEntries(['sessionId', 'toolNames', 'modelResultReads', 'feedback', 'failure', 'localFailure',
    'queryStopped', 'totalLatencyMs', 'generationBudget', 'httpAttempts'].filter(key => Object.hasOwn(project.runtime, key))
    .map(key => [key, structuredClone(project.runtime[key])]));
  if (project.runtime.runs) safe.runtime.runs = project.runtime.runs.map(({ status, startedAt, deadline, finishedAt }) => ({ status, startedAt, deadline, finishedAt }));
  return safe;
}

async function body(request) {
  if (request.body !== undefined) {
    const data = typeof request.body === 'object' && !Buffer.isBuffer(request.body) ? JSON.stringify(request.body) : String(request.body);
    if (Buffer.byteLength(data) > 32768) throw new Error('输入超过本地演示上限');
    try { return JSON.parse(data); } catch { throw new Error('请求须为有效的 JSON 数据'); }
  }
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 32768) throw new Error('输入超过本地演示上限');
  }
  try { return JSON.parse(data || '{}'); } catch { throw new Error('请求须为有效的 JSON 数据'); }
}

export function createAppServer({ env = process.env, dataDir = resolve(publicRoot, '..', '.art-runtime', 'projects'),
  runtimeOptions = {}, store = null, functionMode = false, maxRunMs = 250000, runtimeFactory = createProductRuntime } = {}) {
  const projects = new Map();
  const runtimes = new Map();
  function saveProject(project) {
    if (store) return store.save(project).then(saved => { projects.set(saved.id, saved); return saved; });
    if (!project || !/^[a-zA-Z0-9_-]+$/.test(project.id)) throw new Error('项目标识无效');
    const path = resolve(dataDir, `${project.id}.json`);
    const temporary = `${path}.tmp`;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, project }), 'utf8');
      renameSync(temporary, path);
    } catch {
      try { unlinkSync(temporary); } catch { /* A leftover candidate is never loaded as a project. */ }
      throw Object.assign(new Error('项目未保存；上次已保存的状态保持不变，本次输入可重新提交。'),
        { statusCode: 503, code: 'PROJECT_SAVE_FAILED' });
    }
    const authority = projects.get(project.id);
    if (authority && authority !== project) {
      for (const key of Object.keys(authority)) delete authority[key];
      Object.assign(authority, structuredClone(project));
    } else projects.set(project.id, project);
    return authority ?? project;
  }
  const httpBudget = store ? { limits: store.limits, sharedLimits: store.sharedLimits,
    bind() {}, persist() {}, release() {} } : createHttpBudget({ env, dataDir, onReserve: saveProject });
  try {
  if (!store && existsSync(dataDir)) for (const file of readdirSync(dataDir).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))) {
    const saved = JSON.parse(readFileSync(resolve(dataDir, file), 'utf8'));
    const project = saved.project;
    if (!project || `${project.id}.json` !== file) throw new Error('项目快照标识不匹配');
    httpBudget.bind(project);
    projects.set(project.id, project);
    if (project.status?.phase === 'busy' || project.revisionRequest?.status === 'running') {
      if (project.revisionRequest?.status === 'running') {
        finishRevisionRequest(project, project.revisionRequest, 'interrupted', '服务重启中断了处理；正式内容和已保存待审内容保持不变，可重新提交。');
      }
      project.status = { phase: 'interrupted', detail: '服务重启中断了处理；没有自动重试、确认修改或发出请求。' };
      saveProject(project);
    }
  }
  } catch (error) { httpBudget.release(); throw error; }
  let queue = Promise.resolve();
  let closing = false;
  async function executeStored(project, text) {
    if (databaseExecutionActive) throw Object.assign(new Error('已有任务执行中；未加入后台队列。'), { code: 'RUNTIME_BUSY', statusCode: 409 });
    databaseExecutionActive = true;
    let runtime, temporary, timer, saved, operation, settled = false;
    const controller = new AbortController();
    try {
      saved = await store.save(project, { start: true, leaseMs: maxRunMs + 20000 });
      project = saved.project;
      projects.set(project.id, structuredClone(project));
      bindDatabaseBudget(project, store, saved.token, controller.signal, saved.usage);
      const expired = new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        void runtime?.abort().catch(() => {});
        reject(Object.assign(new Error('本轮达到函数处理时限；保留已保存内容和预留额度，未自动重发请求。'), { code: 'RUN_INTERRUPTED' }));
      }, maxRunMs); });
      operation = (async () => {
        temporary = await mkdtemp(resolve(tmpdir(), 'art-function-'));
        runtime = await runtimeFactory(project, { ...runtimeOptions, env, memorySession: true, runtimeRoot: temporary });
        if (controller.signal.aborted) { await runtime.abort(); return; }
        await runtime.submit(text);
      })();
      operation.finally(() => { settled = true; databaseExecutionActive = false; }).catch(() => {});
      try { await Promise.race([operation, expired]); }
      catch (error) {
        if (error.code === 'RUN_INTERRUPTED') interruptProject(project, error.message);
        else {
          project.runtime.failure ??= safeRuntimeFailure(project, 'model');
          project.status = { phase: 'error', detail: project.runtime.failure.summary };
          if (project.revisionRequest?.status === 'running') finishRevisionRequest(project, project.revisionRequest, 'error', project.status.detail);
        }
      }
      clearTimeout(timer);
      const run = project.runtime.runs.at(-1);
      Object.assign(run, { status: project.status.phase === 'interrupted' ? 'interrupted' : project.status.phase === 'error' ? 'error' : 'completed',
        finishedAt: new Date().toISOString() });
      const final = await store.save(structuredClone(project), { token: saved.token });
      projects.set(final.id, final);
      return final;
    } finally {
      clearTimeout(timer);
      if (!operation || settled) {
        databaseExecutionActive = false;
        await runtime?.dispose();
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } else {
        // An uncooperative tool keeps this process busy until it settles. No second SDK can borrow its environment.
        void operation.catch(() => {}).finally(async () => {
          await runtime?.dispose();
          if (temporary) await rm(temporary, { recursive: true, force: true });
        }).catch(() => {});
      }
    }
  }
  async function schedule(project, text) {
    project.status = { phase: 'busy', detail: '官方会话正在处理；行动与证据将持续更新' };
    if (store) return executeStored(project, text);
    saveProject(project);
    const candidate = structuredClone(project);
    // The SDK's environment helpers are process-scoped. Serialize submissions
    // to keep concurrent projects from borrowing one another's private path.
    queue = queue.then(async () => {
      let entry = runtimes.get(candidate.id);
      if (entry) {
        for (const key of Object.keys(entry.project)) delete entry.project[key];
        Object.assign(entry.project, candidate);
      }
      const project = entry?.project ?? candidate;
      if (project.mode === 'live' && validationRun.liveStopped) {
        project.runtime.failure = { kind: 'runtime', code: 'VALIDATION_RUN_STOPPED', status: null, stopReason: 'error',
          summary: '此前真实案例已停止；本项目排队任务未执行，也未发出模型或文化查询请求。' };
        project.status = { phase: 'error', detail: project.runtime.failure.summary };
        action(project, 'runtime', '排队任务停止', project.status.detail, 'error');
        if (project.revisionRequest?.status === 'running') finishRevisionRequest(project, project.revisionRequest, 'error', project.status.detail);
        saveProject(project);
        return;
      }
      try {
        if (!entry) {
          httpBudget.bind(project);
          entry = { project, runtime: await createProductRuntime(project, { ...runtimeOptions, env }) };
          runtimes.set(project.id, entry);
        }
        await entry.runtime.submit(text);
      } catch {
        project.runtime.failure ??= safeRuntimeFailure(project, 'model');
        stopLiveRun(project, project.runtime.failure);
        project.status = { phase: 'error', detail: project.runtime.failure.summary };
        action(project, 'runtime', '本轮暂停', '没有将失败标记为成功，也没有生成替代证据。', 'error');
        if (project.revisionRequest?.status === 'running') {
          finishRevisionRequest(project, project.revisionRequest, 'error', project.status.detail);
        }
      } finally {
        saveProject(project);
      }
    }).catch(async () => {
      const entry = runtimes.get(candidate.id);
      runtimes.delete(candidate.id);
      try { await entry?.runtime.dispose(); } catch { /* A failed save must not stop later queue entries or shutdown. */ }
    });
  }
  const loadProject = async (id, guestOwner) => {
    const project = store ? await store.get(id, { guestOwner }) : projects.get(id);
    return guestOwner === undefined || (guestOwner && project?.guestOwner === guestOwner) ? project : null;
  };
  const handler = async (request, response) => {
    try {
      const judge = functionMode && env.VERCEL_ENV === 'production' && request.headers.host === 'art-lovat-two.vercel.app';
      let guestToken = /(?:^|;\s*)__Host-art-guest=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
      const owner = () => judge ? (guestToken ? createHash('sha256').update(guestToken).digest('hex') : null) : undefined;
      if (closing) return json(response, 503, { error: '服务正在关闭，未接受新的任务。' });
      if (functionMode) {
        if (!['preview', 'production'].includes(env.VERCEL_ENV) || !store || !env.ART_PREVIEW_ACCESS_KEY)
          return json(response, 503, { error: '仅允许配置数据库和访问密钥的预览或生产环境。', code: 'PREVIEW_CONFIGURATION_REQUIRED' });
        const supplied = Buffer.from(String(request.headers.authorization ?? ''));
        const expected = Buffer.from(`Basic ${Buffer.from(`preview:${env.ART_PREVIEW_ACCESS_KEY}`).toString('base64')}`);
        if (!judge && (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))) {
          response.setHeader('WWW-Authenticate', 'Basic realm="Art protected preview", charset="UTF-8"');
          return json(response, 401, { error: '需要预览访问凭据。', code: 'PREVIEW_AUTHENTICATION_REQUIRED' });
        }
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (functionMode && request.method === 'POST' && url.pathname.startsWith('/api/')) {
        const origin = request.headers.origin;
        const sameOrigin = origin === undefined || (URL.canParse(origin) && new URL(origin).protocol === 'https:'
          && new URL(origin).host === request.headers.host);
        if (!sameOrigin || request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
          return json(response, 403, { error: '变更接口只接受同源 JSON 请求。', code: 'CROSS_ORIGIN_REQUEST_BLOCKED' });
      }
      if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, {
        ...configStatus(env), limits: httpBudget.limits, serverLimits: httpBudget.sharedLimits });
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(request);
        if (closing) return json(response, 503, { error: '服务正在关闭，未接受新的任务。' });
        if (input.mode === 'live' && validationRun.liveStopped)
          return json(response, 409, { error: '本轮真实验证已因错误停止；不能启动后续真实案例。' });
        if (input.mode === 'live' && !configStatus(env).modes.live.available)
          return json(response, 409, { error: '真实模式未单独启用或缺少明确配置；离线演示无需密钥。' });
        const project = createProject(input);
        if (judge) {
          if (!guestToken) {
            guestToken = randomBytes(32).toString('hex');
            response.setHeader('Set-Cookie', `__Host-art-guest=${guestToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`);
          }
          project.guestOwner = owner();
        }
        httpBudget.bind(project, true);
        const saved = await schedule(project, project.brief.request);
        return json(response, store ? 200 : 202, { project: store ? publicProject(saved) : project });
      }
      const match = /^\/api\/projects\/([^/]+)(?:\/(messages|select|revisions)(?:\/([^/]+)\/(accept|reject|feedback))?)?$/.exec(url.pathname);
      if (match) {
        let project = await loadProject(match[1], owner());
        if (!project) return json(response, 404, { error: '项目不存在；请检查当前本地项目存储。' });
        if (request.method === 'GET' && !match[2]) return json(response, 200, { project: store ? publicProject(project) : project });
        if (request.method === 'POST' && match[2]) {
          const input = await body(request);
          if (closing) return json(response, 503, { error: '服务正在关闭，未接受新的任务。' });
          project = await loadProject(match[1], owner());
          if (!project) return json(response, 404, { error: '项目不存在；请检查当前浏览器的项目。' });
          if (project.status.phase === 'busy') return json(response, 409, { error: '当前任务仍在处理，请稍后补充。', code: 'PROJECT_BUSY' });
          project = structuredClone(project);
          if (match[2] === 'select' && !match[3]) {
            selectConcept(project, input); project = await saveProject(project);
            return json(response, 200, { project: store ? publicProject(project) : project });
          }
          if (match[2] === 'revisions' && match[3] && match[4] !== 'feedback') {
            decideRevision(project, match[3], match[4], input); project = await saveProject(project);
            return json(response, 200, { project: store ? publicProject(project) : project });
          }
          if (project.mode === 'live' && validationRun.liveStopped)
            return json(response, 409, { error: '本轮真实验证已因错误停止；不能追加真实请求。' });
          if (match[2] === 'messages' && (pendingReference(project) || input.referenceResolution)) {
            if (!input.referenceResolution) {
              referenceQuestion(project); await saveProject(project);
              return json(response, 409, { error: '请在当前候选中明确选择，或使用补充信息表单；文字回复不会默认选择任何实体。', code: 'REFERENCE_SELECTION_REQUIRED' });
            }
            const continuation = respondToReference(project, input.referenceResolution);
            project.messages.push({ role: 'user', text: continuation ?? '取消实体选择；原文化参考尚未解决，等待补充信息。' });
            if (continuation) project = await schedule(project, continuation) ?? project;
            else project = await saveProject(project);
            return json(response, continuation && !store ? 202 : 200, { project: store ? publicProject(project) : project });
          }
          if (typeof input.text !== 'string' || !input.text.trim()) return json(response, 400, { error: '请输入补充说明' });
          const text = input.text.trim();
          if (match[2] === 'revisions' && match[4] === 'feedback') {
            beginPendingFeedback(project, match[3], input);
            project.messages.push({ role: 'user', text });
            project = await schedule(project, text) ?? project;
            return json(response, store ? 200 : 202, { project: store ? publicProject(project) : project });
          }
          if (match[2] === 'revisions' || project.concepts.length) {
            // No legacy message can overwrite confirmed concepts. The browser
            // must explicitly choose the target and send the confirmed version.
            beginRevision(project, input);
            project.messages.push({ role: 'user', text });
            project = await schedule(project, text) ?? project;
            return json(response, store ? 200 : 202, { project: store ? publicProject(project) : project });
          }
          if (project.status.phase === 'needs_input' || input.clarification || input.briefUpdate) answerClarification(project, input);
          project.messages.push({ role: 'user', text: input.text });
          project = await schedule(project, input.text) ?? project;
          return json(response, store ? 200 : 202, { project: store ? publicProject(project) : project });
        }
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
      if (request.method !== 'GET') return json(response, 405, { error: '不支持的请求方式' });
      const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!path.startsWith(publicRoot + sep)) return json(response, 404, { error: '文件不存在' });
      try {
        const data = await readFile(path);
        const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
        response.writeHead(200, { 'Content-Type': `${types[extname(path)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
        response.end(data);
      } catch { json(response, 404, { error: '文件不存在' }); }
    } catch (error) { json(response, error.statusCode ?? 400, { error: error.code ? error.message
      : ['请先描述项目需求', '不支持的运行模式', '不支持的离线场景', '输入超过本地演示上限', '请求须为有效的 JSON 数据'].includes(error.message) ? error.message : '输入格式无效',
      ...(error.code ? { code: error.code, path: error.path } : {}) }); }
  };
  const server = createServer(handler);
  return { server, handler, projects, saveProject, async dispose() {
    closing = true;
    const closed = server.listening ? new Promise((done, reject) => server.close(error => error ? reject(error) : done())) : Promise.resolve();
    await queue;
    await Promise.all([...runtimes.values()].map(entry => entry.runtime.dispose()));
    await closed;
    httpBudget.persist(); httpBudget.release();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createAppServer();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '127.0.0.1', () => console.log(`本地工作空间：http://127.0.0.1:${port}（默认离线合成演示）`));
  process.on('SIGINT', async () => { await app.dispose(); process.exit(0); });
}
