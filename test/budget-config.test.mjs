import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from '../app/state.mjs';
import { wrapProjectExecutor } from '../app/runtime.mjs';
import { createAppServer } from '../app/server.mjs';
import * as transport from '../app/transport.mjs';

const configured = { ART_MODEL_HTTP_LIMIT: '30', ART_QLOO_HTTP_LIMIT: '20' };
const counts = (modelHttpAttempts, qlooHttpAttempts) => ({ modelHttpAttempts, qlooHttpAttempts });
const freshProject = () => createProject({ mode: 'live', brief: { request: 'Synthetic budget boundary test' } });
const ledgerPath = dataDir => join(dataDir, '.http-budget', 'run.json');
function reset() {
  Object.assign(transport.serverUsage, counts(0, 0));
  Object.assign(transport.validationRun, { queryStopped: false, liveStopped: false });
  transport.validationRun.attempts.length = 0;
  delete transport.validationRun.failure;
}
function fixture(t, env = configured, onReserve) {
  reset();
  assert.equal(typeof transport.createHttpBudget, 'function', 'trusted server budget entry must exist');
  const dataDir = mkdtempSync(join(tmpdir(), 'art-budget-test-'));
  let budget;
  t.after(() => { budget?.release(); rmSync(dataDir, { recursive: true, force: true }); });
  budget = transport.createHttpBudget({ env, dataDir, onReserve });
  return { dataDir, budget };
}
function sender(implementation = async () => new Response('{}')) {
  let sent = 0;
  const fetch = transport.budgetedFetch(async (...args) => { sent++; return implementation(...args); });
  return { get sent() { return sent; }, send(project, kind = 'model') {
    const origin = `https://${kind}.invalid`;
    return transport.withHttpBudget(project, kind, origin, () => fetch(`${origin}/request`));
  } };
}
function localRequest(port, method, path, payload) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json' } }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

test('trusted configuration retains defaults, supports explicit limits, zero and partial settings', async t => {
  for (const [env, limits, shared] of [
    [{}, counts(6, 6), counts(12, 12)],
    [configured, counts(30, 20), counts(30, 20)],
    [{ ART_MODEL_HTTP_LIMIT: '30' }, counts(30, 6), counts(30, 6)],
    [{ ART_QLOO_HTTP_LIMIT: '0' }, counts(6, 0), counts(6, 0)],
    [{ ART_MODEL_HTTP_LIMIT: Number.MAX_SAFE_INTEGER, ART_QLOO_HTTP_LIMIT: 0 }, counts(Number.MAX_SAFE_INTEGER, 0), counts(Number.MAX_SAFE_INTEGER, 0)],
  ]) await t.test(JSON.stringify(env), t => {
    const { budget } = fixture(t, env);
    const project = freshProject(); budget.bind(project, true);
    assert.deepEqual(budget.limits, limits);
    assert.deepEqual(budget.sharedLimits, shared);
    assert.deepEqual(transport.remainingBudget(project).caseLimits, limits);
    assert.deepEqual(transport.remainingBudget(project).sharedLimits, shared);
  });
});

test('invalid configured values fail closed without a fetch or silent default', t => {
  const { dataDir, budget } = fixture(t); budget.release();
  let index = 0;
  for (const name of ['ART_MODEL_HTTP_LIMIT', 'ART_QLOO_HTTP_LIMIT']) {
    for (const value of ['', ' ', 'NaN', 'Infinity', '-1', '1.5', '1e2', '+1', '0x10', '9007199254740992',
      NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true]) {
      assert.throws(() => {
        const accidental = transport.createHttpBudget({ env: { [name]: value }, dataDir: join(dataDir, `invalid-${index++}`) });
        accidental.release();
      },
        error => error.code === 'HTTP_BUDGET_CONFIG_INVALID', `${name}=${String(value)}`);
    }
  }
  assert.deepEqual(transport.serverUsage, counts(0, 0));
  assert.equal(transport.validationRun.attempts.length, 0);
});

test('30 model and 20 Qloo sends are counted before fetch; the next sends are local rejections', async t => {
  let reservations = 0;
  const { budget, dataDir } = fixture(t, { ...configured, ART_MODEL_API_KEY: 'DO_NOT_PERSIST_SECRET' }, project => {
    reservations++;
    const saved = JSON.parse(readFileSync(ledgerPath(dataDir), 'utf8'));
    assert.deepEqual(saved.usage, transport.serverUsage);
    assert.equal(saved.registeredProjects[project.id].usage.modelHttpAttempts, project.usage.modelHttpAttempts);
    assert.equal(saved.registeredProjects[project.id].usage.qlooHttpAttempts, project.usage.qlooHttpAttempts);
  });
  const project = freshProject(); budget.bind(project, true);
  const wire = sender(async (_url, options) => {
    assert.equal(reservations, wire.sent, 'project persistence precedes each underlying send');
    assert.equal(options.redirect, 'error');
    return new Response('{}');
  });
  for (const [kind, limit] of [['model', 30], ['qloo', 20]]) {
    for (let i = 0; i < limit; i++) await wire.send(project, kind);
    const before = wire.sent;
    await assert.rejects(wire.send(project, kind), /总额度/);
    assert.equal(wire.sent, before, 'rejection is not a sent HTTP request');
  }
  assert.equal(wire.sent, 50);
  assert.deepEqual(transport.serverUsage, counts(30, 20));
  assert.deepEqual(budget.summary().usage, counts(30, 20));
  assert.deepEqual(transport.remainingBudget(project).caseRemaining, counts(0, 0));
  assert.deepEqual(transport.remainingBudget(project).sharedRemaining, counts(0, 0));
  assert.equal(readFileSync(ledgerPath(dataDir), 'utf8').includes('DO_NOT_PERSIST_SECRET'), false);
});

test('40 simultaneous attempts cannot exceed either shared limit, including across new projects', async t => {
  const { budget } = fixture(t);
  const projects = Array.from({ length: 40 }, () => { const project = freshProject(); budget.bind(project, true); return project; });
  const wire = sender();
  for (const [kind, limit] of [['model', 30], ['qloo', 20]]) {
    const results = await Promise.allSettled(projects.map(project => wire.send(project, kind)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, limit);
    assert.equal(results.filter(result => result.status === 'rejected').length, 40 - limit);
    assert.equal(projects.reduce((total, project) => total + project.usage[`${kind}HttpAttempts`], 0), limit);
  }
  assert.equal(wire.sent, 50);
  assert.deepEqual(budget.summary().usage, counts(30, 20));
});

test('failed sends and retries consume the same configured budget', async t => {
  const { budget } = fixture(t);
  const project = freshProject(); budget.bind(project, true);
  const wire = sender(async () => { throw new Error('synthetic network failure'); });
  for (let i = 0; i < 30; i++) await assert.rejects(wire.send(project), /synthetic network failure/);
  await assert.rejects(wire.send(project), /总额度/);
  assert.equal(wire.sent, 30);
  assert.equal(project.usage.modelHttpAttempts, 30);
  assert.equal(transport.remainingBudget(project).modelHttpAttempts, 0);
  assert.equal(transport.validationRun.attempts.filter(attempt => attempt.outcome === 'network_error').length, 30);
});

test('untrusted fields cannot raise limits; historical and unbound projects keep 6/6', async t => {
  const { budget } = fixture(t);
  for (const bind of [project => budget.bind(project), () => {}]) {
    const project = freshProject();
    project.limits = counts(10000, 10000);
    project.httpBudget = { limits: counts(10000, 10000) };
    project.runtime.validation = { modelHttpLimit: 10000, qlooHttpLimit: 10000 };
    bind(project);
    assert.deepEqual(transport.remainingBudget(project).caseLimits, counts(6, 6));
  }
  const project = freshProject(); budget.bind(project, true);
  project.runtime.validation = { modelHttpLimit: 10000, qlooHttpLimit: 0 };
  assert.deepEqual(transport.remainingBudget(project).caseLimits, counts(30, 20));
  const wire = sender();
  const historical = freshProject(); budget.bind(historical);
  for (let i = 0; i < 6; i++) await wire.send(historical);
  await assert.rejects(wire.send(historical), /总额度/);
  assert.equal(wire.sent, 6);
});

test('restricted validation only tightens configured limits and diagnostic remains 1/0', async t => {
  const { budget } = fixture(t);
  const wire = sender();
  for (const limit of [0, 2, 10]) {
    const project = freshProject(); budget.bind(project, true);
    project.runtime.validation = { modelHttpLimit: limit, qlooHttpLimit: 0 };
    assert.deepEqual(transport.remainingBudget(project).caseLimits, counts(limit, 0));
    for (let i = 0; i < limit; i++) await wire.send(project);
    await assert.rejects(wire.send(project), /总额度/);
    await assert.rejects(wire.send(project, 'qloo'), /总额度/);
  }
  let sends = 0;
  const diagnostic = transport.createDiagnosticFetch(async () => { sends++; return new Response('{}'); });
  const options = { method: 'POST', body: JSON.stringify({ model: 'deepseek-flash', messages: [] }) };
  await diagnostic.fetch('https://api.deepseek.com/chat/completions', options);
  await assert.rejects(diagnostic.fetch('https://api.deepseek.com/chat/completions', options));
  await assert.rejects(diagnostic.fetch('https://hackathon.api.qloo.com/search'));
  assert.equal(sends, 1);
  assert.equal(diagnostic.ledger.modelHttpAttempts, 1);
  assert.equal(diagnostic.ledger.qlooHttpAttempts, 0);
});

test('unbound trusted validation retains its original ten-model zero-Qloo allowance', async t => {
  reset(); t.after(reset);
  const project = freshProject();
  project.runtime.validation = { modelHttpLimit: 10, qlooHttpLimit: 0 };
  const wire = sender();
  await assert.rejects(wire.send(project, 'qloo'), /总额度/);
  for (let i = 0; i < 10; i++) await wire.send(project);
  await assert.rejects(wire.send(project), /总额度/);
  assert.deepEqual(transport.remainingBudget(project).caseLimits, counts(10, 0));
  assert.equal(wire.sent, 10);
  assert.equal(project.usage.modelHttpAttempts, 10);
  assert.equal(project.usage.qlooHttpAttempts, 0);
});

test('trusted validation cannot expand a bound two-model allowance', async t => {
  const { budget } = fixture(t, { ...configured, ART_MODEL_HTTP_LIMIT: '2' });
  const project = freshProject(); budget.bind(project, true);
  project.runtime.validation = { modelHttpLimit: 10, qlooHttpLimit: 0 };
  const wire = sender();
  assert.deepEqual(transport.remainingBudget(project).caseLimits, counts(2, 0));
  await assert.rejects(wire.send(project, 'qloo'), /总额度/);
  await wire.send(project); await wire.send(project);
  await assert.rejects(wire.send(project), /总额度/);
  assert.equal(wire.sent, 2);
  assert.equal(project.usage.modelHttpAttempts, 2);
  assert.equal(project.usage.qlooHttpAttempts, 0);
});

test('Qloo exhaustion stops all queries while model cleanup uses only remaining allowance', async t => {
  const { budget, dataDir } = fixture(t, { ...configured, ART_QLOO_HTTP_LIMIT: '0' });
  const project = freshProject(); budget.bind(project, true);
  let executions = 0;
  const executor = wrapProjectExecutor(project, { transport: { kind: 'direct', remote: false },
    async execute() { executions++; assert.fail('Qloo zero cannot reach the official executor'); } },
  { QLOO_API_URL: 'https://qloo.invalid' });
  const result = await executor.execute('recommend', {});
  assert.equal(result.result.queryStopped, true);
  assert.equal(project.runtime.queryStopped, true);
  assert.equal(transport.validationRun.queryStopped, true);
  assert.equal(transport.validationRun.liveStopped, false);
  assert.equal(executions, 0);
  const saved = JSON.parse(readFileSync(ledgerPath(dataDir), 'utf8'));
  assert.equal(saved.queryStopped, true);
  assert.equal(saved.liveStopped, false);
  const wire = sender();
  for (let i = 0; i < 30; i++) await wire.send(project);
  await assert.rejects(wire.send(project), /总额度/);
  assert.equal(wire.sent, 30);
});

test('a fresh process restores counters, reserved project usage and stop flags without HTTP', async t => {
  const { budget, dataDir } = fixture(t);
  const project = freshProject(); budget.bind(project, true);
  const staleSnapshot = structuredClone(project);
  const wire = sender(); await wire.send(project); await wire.send(project, 'qloo');
  transport.stopLiveRun(project, { kind: 'qloo', code: 'SYNTHETIC_STOP', status: null }, true);
  transport.stopLiveRun(project, { kind: 'model', code: 'SYNTHETIC_STOP', status: null });
  budget.release();
  const source = `
    let actualFetches = 0;
    globalThis.fetch = async () => { actualFetches++; throw new Error('NO_NETWORK'); };
    const transport = await import(${JSON.stringify(new URL('../app/transport.mjs', import.meta.url).href)});
    const project = JSON.parse(process.argv[2]);
    const budget = transport.createHttpBudget({ env: ${JSON.stringify(configured)}, dataDir: process.argv[1] });
    try {
      budget.bind(project);
      console.log(JSON.stringify({ summary: budget.summary(), remaining: transport.remainingBudget(project),
        projectUsage: project.usage, actualFetches, attempts: transport.validationRun.attempts.length }));
    } finally { budget.release(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, dataDir, JSON.stringify(staleSnapshot)],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const restored = JSON.parse(child.stdout.trim());
  assert.deepEqual(restored.summary.usage, counts(1, 1));
  assert.equal(restored.projectUsage.modelHttpAttempts, 1);
  assert.equal(restored.projectUsage.qlooHttpAttempts, 1);
  assert.deepEqual(restored.remaining.caseLimits, counts(30, 20));
  assert.equal(restored.remaining.modelHttpAttempts, 29);
  assert.equal(restored.remaining.qlooHttpAttempts, 0);
  assert.equal(restored.summary.queryStopped, true);
  assert.equal(restored.summary.liveStopped, true);
  assert.equal(restored.actualFetches, 0);
  assert.equal(restored.attempts, 0);
});

test('active-instance lock, damaged ledger and changed configuration cannot reset counters', async t => {
  const { budget, dataDir } = fixture(t);
  assert.throws(() => transport.createHttpBudget({ env: configured, dataDir }),
    error => error.code === 'HTTP_BUDGET_CONFIG_INVALID');
  const project = freshProject(); budget.bind(project, true);
  await sender().send(project); budget.release();
  const saved = readFileSync(ledgerPath(dataDir), 'utf8');
  assert.throws(() => transport.createHttpBudget({ env: { ...configured, ART_MODEL_HTTP_LIMIT: '31' }, dataDir }),
    error => error.code === 'HTTP_BUDGET_CONFIG_INVALID');
  assert.equal(readFileSync(ledgerPath(dataDir), 'utf8'), saved);
  const elevated = JSON.parse(saved); elevated.registeredProjects[project.id].limits = counts(31, 20);
  for (const damaged of ['invalid-json', '{}', JSON.stringify({ ...JSON.parse(saved), usage: counts(-1, 0) }), JSON.stringify(elevated)]) {
    writeFileSync(ledgerPath(dataDir), damaged);
    assert.throws(() => transport.createHttpBudget({ env: configured, dataDir }),
      error => error.code === 'HTTP_BUDGET_CONFIG_INVALID');
    assert.equal(readFileSync(ledgerPath(dataDir), 'utf8'), damaged);
  }
  assert.deepEqual(transport.serverUsage, counts(1, 0));
});

test('failed project snapshot initialization releases its unstarted server lock', async t => {
  reset();
  const dataDir = mkdtempSync(join(tmpdir(), 'art-budget-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const broken = join(dataDir, 'broken.json');
  writeFileSync(broken, 'invalid-json');
  assert.throws(() => createAppServer({ env: configured, dataDir }));
  rmSync(broken);
  const restarted = createAppServer({ env: configured, dataDir });
  try {
    assert.equal(restarted.projects.size, 0);
    assert.deepEqual(transport.serverUsage, counts(0, 0));
    assert.equal(transport.validationRun.attempts.length, 0);
  } finally { await restarted.dispose(); }
});

test('project persistence failure prevents the send and preserves the stop state in the ledger', async t => {
  const { budget, dataDir } = fixture(t, configured, () => { throw new Error('synthetic project disk failure'); });
  const project = freshProject(); budget.bind(project, true);
  const wire = sender();
  await assert.rejects(wire.send(project), /额度无法保存/);
  assert.equal(wire.sent, 0);
  assert.equal(transport.validationRun.liveStopped, true);
  const saved = JSON.parse(readFileSync(ledgerPath(dataDir), 'utf8'));
  assert.equal(saved.liveStopped, true, 'a restart must retain the failure stop');
  assert.equal(saved.usage.modelHttpAttempts, 1, 'uncertain reserved request is never refunded');
  assert.equal(saved.registeredProjects[project.id].usage.modelHttpAttempts, 1);
});

test('local HTTP reports configured limits and ignores client budget injection when creating a project', async t => {
  reset();
  const dataDir = mkdtempSync(join(tmpdir(), 'art-budget-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const app = createAppServer({ env: configured, dataDir });
  let id;
  try {
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    const local = (method, path, payload) => localRequest(app.server.address().port, method, path, payload);
    const config = await local('GET', '/api/config');
    assert.equal(config.status, 200);
    assert.deepEqual(config.body.limits, counts(30, 20));
    assert.deepEqual(config.body.serverLimits, counts(30, 20));
    const created = await local('POST', '/api/projects', { mode: 'offline', brief: { request: 'Synthetic offline budget API test' },
      limits: counts(1000, 1000), httpBudget: { limits: counts(1000, 1000) },
      runtime: { validation: { modelHttpLimit: 1000, qlooHttpLimit: 1000 } } });
    assert.equal(created.status, 202);
    const project = app.projects.get(created.body.project.id); id = project.id;
    for (const state of [created.body.project, project]) {
      assert.equal(state.limits, undefined);
      assert.equal(state.httpBudget, undefined);
      assert.equal(state.runtime.validation, undefined);
    }
    const remaining = transport.remainingBudget(project);
    assert.deepEqual(remaining.caseLimits, counts(30, 20));
    assert.deepEqual(remaining.sharedLimits, counts(30, 20));
    assert.equal(remaining.modelHttpAttempts, 30);
    assert.equal(remaining.qlooHttpAttempts, 20);
  } finally { await app.dispose(); }
  const savedProject = JSON.parse(readFileSync(join(dataDir, `${id}.json`), 'utf8')).project;
  assert.equal(savedProject.status.phase, 'needs_input', 'dispose waits for the offline submission to finish');
  assert.equal(savedProject.runtime.validation, undefined);
  assert.equal(savedProject.usage.modelHttpAttempts, 0);
  assert.equal(savedProject.usage.qlooHttpAttempts, 0);
  const savedRun = JSON.parse(readFileSync(ledgerPath(dataDir), 'utf8'));
  assert.deepEqual(savedRun.registeredProjects[id].limits, counts(30, 20));
  assert.deepEqual(savedRun.usage, counts(0, 0));
  assert.equal(transport.validationRun.attempts.length, 0);
});

test('server shutdown rejects new projects while draining a reserved model request', async t => {
  reset();
  const dataDir = mkdtempSync(join(tmpdir(), 'art-budget-test-'));
  const env = { ...configured, ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'deepseek', ART_MODEL_ID: 'deepseek-flash',
    ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://api.deepseek.com',
    ART_MODEL_API_KEY: 'synthetic-local-only-key', QLOO_API_KEY: 'synthetic-local-only-qloo-key',
    QLOO_API_URL: 'https://hackathon.api.qloo.com' };
  let releaseGate, markStarted, timer, sends = 0;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = transport.budgetedFetch(async () => {
    sends++;
    if (sends === 1) { markStarted(); await gate; }
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'synthetic-shutdown',
      object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: 'Synthetic local response' }) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  const app = createAppServer({ env, dataDir });
  let disposing;
  try {
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    const port = app.server.address().port;
    const payload = { mode: 'live', brief: { request: 'Synthetic shutdown boundary' } };
    assert.equal((await localRequest(port, 'POST', '/api/projects', payload)).status, 202);
    await Promise.race([started, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('synthetic model request did not start')), 10000);
    })]);
    disposing = app.dispose();
    const next = await localRequest(port, 'POST', '/api/projects', payload)
      .then(response => ({ response }), error => ({ error }));
    if (next.error) assert(['ECONNREFUSED', 'ECONNRESET'].includes(next.error.code), next.error.message);
    else assert.equal(next.response.status, 503, 'closing server must not accept another project');
    assert.equal(app.projects.size, 1);
    assert.equal(sends, 1);
    assert.equal(existsSync(join(dataDir, '.http-budget', 'active.lock')), true, 'in-flight request retains the instance lock');
  } finally {
    clearTimeout(timer); releaseGate();
    await (disposing ?? app.dispose());
    // Also drain an incorrectly admitted task when proving the RED regression.
    for (let i = 0; i < 1000 && [...app.projects.values()].some(project => project.status.phase === 'busy'); i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    globalThis.fetch = previousFetch;
    for (const id of app.projects.keys()) rmSync(fileURLToPath(new URL(`../.art-runtime/${id}`, import.meta.url)), { recursive: true, force: true });
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  }
  assert.equal(existsSync(join(dataDir, '.http-budget', 'active.lock')), false);
  const restarted = createAppServer({ env, dataDir });
  await restarted.dispose();
  assert.equal(sends, 1);
});
