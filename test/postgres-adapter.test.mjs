import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresStore } from '../app/store.mjs';
import { createAppServer } from '../app/server.mjs';
import { createFunctionHandler } from '../api/index.mjs';
import { createProject } from '../app/state.mjs';
import { bindDatabaseBudget, budgetedFetch, remainingBudget, validationRun, withHttpBudget } from '../app/transport.mjs';
import { unresolvedResearch } from '../app/context.mjs';

test('public judge domain creates and restores isolated guest projects through the real runtime with fake model HTTP', async t => {
  const configured = { ...env, VERCEL_ENV: 'production', ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'deepseek',
    ART_MODEL_ID: 'deepseek-flash', ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://api.deepseek.com',
    QLOO_API_URL: 'https://hackathon.api.qloo.com' };
  const records = new Map();
  const historical = createProject({ brief }); records.set(historical.id, structuredClone(historical));
  const usage = { modelHttpAttempts: 0, qlooHttpAttempts: 0 };
  const store = { limits: { modelHttpAttempts: 6, qlooHttpAttempts: 6 }, sharedLimits: { modelHttpAttempts: 12, qlooHttpAttempts: 12 },
    async get(id) { return structuredClone(records.get(id)); },
    async save(project, { start = false } = {}) {
      const next = structuredClone(project); next.storageVersion = (next.storageVersion ?? 0) + 1;
      if (start) (next.runtime.runs ??= []).push({ id: 'private-lease', status: 'running', startedAt: new Date().toISOString() });
      records.set(next.id, structuredClone(next));
      return start ? { project: next, token: 'private-lease', usage } : next;
    },
    async reserve(project, token, detail) {
      assert.equal(token, 'private-lease'); assert.equal(detail.kind, 'model');
      project.usage.modelHttpAttempts++; usage.modelHttpAttempts++;
      return { project: structuredClone(project), usage };
    }, async finishAttempt() {} };
  const previousFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = budgetedFetch(async (url, options) => {
    assert.equal(new URL(String(url)).origin, configured.ART_MODEL_BASE_URL);
    assert.equal(JSON.parse(options.body).model, configured.ART_MODEL_ID); sends++;
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'synthetic-guest', object: 'chat.completion.chunk',
      created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: '合成访客响应，未调用真实服务。' }) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  Object.assign(validationRun, { liveStopped: false, queryStopped: false }); delete validationRun.failure;
  t.after(() => { globalThis.fetch = previousFetch; });
  const first = await serve(t, createFunctionHandler({ env: configured, store }));
  const second = await serve(t, createFunctionHandler({ env: configured, store }));
  const headers = { host: 'art-lovat-two.vercel.app' };
  for (const path of ['/', '/index.html', '/api/config']) {
    const result = await first('GET', path, null, null, headers);
    assert.equal(result.status, 200); assert.equal(result.headers['www-authenticate'], undefined);
    for (const secret of [configured.ART_PREVIEW_ACCESS_KEY, configured.ART_MODEL_API_KEY, configured.QLOO_API_KEY])
      assert.equal(result.text.includes(secret), false);
  }
  const config = await first('GET', '/api/config', null, null, headers);
  assert.equal(config.body.modes.live.available, true);
  assert.equal((await first('GET', '/api/config', null, null, { host: 'art-other.vercel.app' })).status, 401);
  for (const change of [{ Origin: 'https://other.invalid' }, { Origin: 'http://art-lovat-two.vercel.app' }, { 'Content-Type': 'text/plain' }])
    assert.equal((await first('POST', '/api/projects', { brief, mode: 'live' }, null, { ...headers, ...change })).status, 403);
  assert.equal((await first('POST', '/api/projects', { brief: { request: 'x'.repeat(33000) } }, null, headers)).status, 400);
  const created = await first('POST', '/api/projects', { brief, mode: 'live', guestOwner: 'attacker' }, null, headers);
  assert.equal(created.status, 200); assert.equal(created.body.project.mode, 'live'); assert.equal(sends, 1);
  const cookie = created.headers['set-cookie'][0];
  assert.match(cookie, /^__Host-art-guest=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Lax;/);
  const ownHeaders = { ...headers, Cookie: cookie.split(';')[0] };
  const id = created.body.project.id, owner = records.get(id).guestOwner;
  assert.equal(created.text.includes(owner), false); assert.equal(created.body.project.guestOwner, undefined);
  assert.equal(created.text.includes('private-lease'), false); assert.equal(created.body.project.usage.qlooHttpAttempts, 0);
  assert.deepEqual((await second('GET', `/api/projects/${id}`, null, null, ownHeaders)).body.project, created.body.project);
  const other = await second('POST', '/api/projects', { brief, mode: 'live' }, null, headers);
  assert.equal(other.status, 200); assert.equal(sends, 2);
  const otherHeaders = { ...headers, Cookie: other.headers['set-cookie'][0].split(';')[0] };
  for (const deniedHeaders of [headers, otherHeaders, { ...headers, Cookie: '__Host-art-guest=invalid' }]) {
    for (const path of [`/api/projects/${id}`, `/api/projects/${historical.id}`]) {
      assert.equal((await second('GET', path, null, null, deniedHeaders)).status, 404);
      for (const suffix of ['messages', 'select', 'revisions', 'revisions/unknown/accept', 'revisions/unknown/reject', 'revisions/unknown/feedback'])
        assert.equal((await second('POST', `${path}/${suffix}`, { text: '不允许修改' }, null, deniedHeaders)).status, 404);
    }
  }
  assert.equal((await second('GET', `/api/projects/${historical.id}`, null, null, ownHeaders)).status, 404);
  assert.equal((await second('GET', '/api/projects', null, null, ownHeaders)).status, 404);
  const continued = await second('POST', `/api/projects/${id}/messages`, { text: '合成补充' }, null, ownHeaders);
  assert.equal(continued.status, 200); assert.equal(sends, 3); assert.equal(records.get(id).guestOwner, owner);
  assert.deepEqual(records.get(historical.id), historical);
});

test('guest SQL reads reject missing or foreign ownership before recovering an expired historical lease', async () => {
  const statements = [];
  const store = createPostgresStore({ pool: { async connect() { return { release() {}, async query(sql) {
    statements.push(sql);
    return { rows: sql.startsWith('SELECT * FROM art_budget_runs') ? [{ limits: store.limits, shared_limits: store.sharedLimits }]
      : sql.startsWith('SELECT * FROM art_projects') ? [{ run_id: 'protected-preview-v1', state: { runtime: {} }, lease_token: 'expired', lease_until: '2000-01-01' }] : [] };
  } }; } } });
  assert.equal(await store.get('historical', { guestOwner: null }), null); assert.equal(statements.length, 0);
  assert.equal(await store.get('historical', { guestOwner: 'foreign' }), null);
  assert.equal(statements.some(sql => /^UPDATE|art_http_attempts/.test(sql)), false);
});

const connectionString = process.env.ART_TEST_DATABASE_URL;
const sqlTest = (name, run) => test(name, { skip: !connectionString && 'Set ART_TEST_DATABASE_URL to an isolated real Postgres database' }, run);
const brief = { request: '虚构运动鞋快闪，离线数据库验收', venue: '上海室内150平方米', references: ['虚构音乐参考'], mustKeep: ['试穿'] };
const env = { VERCEL_ENV: 'preview', ART_PREVIEW_ACCESS_KEY: 'synthetic-preview-secret', ART_ENABLE_LIVE: 'false',
  ART_MODEL_API_KEY: 'synthetic-model-secret', QLOO_API_KEY: 'synthetic-qloo-secret' };
const authorization = `Basic ${Buffer.from(`preview:${env.ART_PREVIEW_ACCESS_KEY}`).toString('base64')}`;

async function fixture(t, budgetEnv = {}) {
  validationRun.liveStopped = false; validationRun.queryStopped = false; delete validationRun.failure;
  const admin = new pg.Pool({ connectionString, max: 1 });
  const schema = `art_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pools = [0, 1].map(() => new pg.Pool({ connectionString, max: 2, options: `-c search_path=${schema}` }));
  t.after(async () => { await Promise.all(pools.map(pool => pool.end())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pools[0].query(await readFile(new URL('../migrations/001-postgres.sql', import.meta.url), 'utf8'));
  const stores = pools.map(pool => createPostgresStore({ pool, env: budgetEnv }));
  return { stores, pools };
}

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return (method, path, payload, auth = authorization, headers = {}) => new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', ...(auth ? { authorization: auth } : {}), ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, text, headers: res.headers,
        body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

sqlTest('real Postgres preserves full authority across independent stores and rejects one concurrent same-version writer', async t => {
  const { stores, pools } = await fixture(t);
  assert.match((await pools[0].query('SELECT version()')).rows[0].version, /PostgreSQL/);
  const project = createProject({ brief }); project.status.phase = 'ready';
  project.evidence.push({ id: 'synthetic-evidence', synthetic: true, query: { operation: 'describe' } });
  project.revisions.push({ id: 'pending', status: 'pending', changes: [{ field: 'title', after: '待审' }] });
  project.versionHistory.push({ version: 1, concepts: [] });
  const saved = await stores[0].save(project);
  assert.deepEqual(await stores[1].get(project.id), saved);
  const candidates = await Promise.all(stores.map(store => store.get(project.id)));
  candidates.forEach((candidate, index) => { candidate.brief.goal = `writer-${index}`; });
  const writes = await Promise.allSettled(stores.map((store, index) => store.save(candidates[index])));
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.find(result => result.status === 'rejected').reason.code, 'PROJECT_STORAGE_CONFLICT');
  const final = await stores[1].get(project.id);
  assert.equal(final.storageVersion, saved.storageVersion + 1);
  assert.deepEqual(final.evidence, saved.evidence); assert.deepEqual(final.revisions, saved.revisions);
});

sqlTest('function HTTP routes await the official offline runtime, protect access, hide internals and read the same project in a second instance', async t => {
  const { stores } = await fixture(t);
  const first = await serve(t, createFunctionHandler({ env, store: stores[0] }));
  const second = await serve(t, createFunctionHandler({ env, store: stores[1] }));
  assert.equal((await first('GET', '/api/config', null, null)).status, 401);
  assert.match((await first('GET', '/', null, null)).headers['www-authenticate'], /Basic/);
  assert.equal((await first('GET', '/')).status, 200);
  assert.equal((await first('GET', '/index.html', null, null)).status, 401);
  const routing = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const src of ['/', '/index\\.html', '/api(?:/.*)?']) assert(routing.routes.some(route => route.src === src && route.dest === '/api/index'));
  assert.equal((await first('POST', '/api/projects', { brief }, authorization, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await first('POST', '/api/projects', { brief }, authorization, { 'Content-Type': 'text/plain' })).status, 403);
  const config = await first('GET', '/api/config');
  assert.equal(config.status, 200); assert.equal(config.body.modes.live.available, false);
  for (const secret of Object.values(env).filter(value => value.includes('secret'))) assert.equal(config.text.includes(secret), false);
  const created = await first('POST', '/api/projects', { brief, mode: 'offline' });
  assert.equal(created.status, 200); assert.equal(created.body.project.status.phase, 'ready');
  assert.equal(created.body.project.concepts.length, 2);
  assert.equal(created.body.project.runtime.runs[0].status, 'completed');
  const restored = await second('GET', `/api/projects/${created.body.project.id}`);
  assert.deepEqual(restored.body.project, created.body.project);
  const privateState = await stores[1].get(created.body.project.id);
  privateState.runtime.sessionFile = '/private/session'; privateState.runtime.sessionHistory = ['/private/history'];
  privateState.runtime.internalSecret = 'synthetic-internal-value';
  await stores[1].save(privateState);
  const publicState = await first('GET', `/api/projects/${privateState.id}`);
  for (const text of ['/private/', 'synthetic-internal-value', privateState.runtime.runs[0].id]) assert.equal(publicState.text.includes(text), false);
  assert.equal(publicState.body.project.usage.modelHttpAttempts, 0); assert.equal(publicState.body.project.usage.qlooHttpAttempts, 0);
  assert.equal((await first('GET', '/api/projects')).status, 404);
});

test('Vercel routes protect homepage and APIs before the static filesystem without a database', async () => {
  const routing = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert(Array.isArray(routing.routes), 'explicit routes must protect the homepage before filesystem lookup');
  const filesystem = routing.routes.findIndex(route => route.handle === 'filesystem');
  assert(filesystem >= 0, 'static assets require filesystem lookup');
  for (const path of ['/', '/index.html', '/api', '/api/config', '/api/projects/example/messages']) {
    const index = routing.routes.findIndex(route => route.src && new RegExp(`^${route.src}$`).test(path));
    assert(index >= 0 && index < filesystem, `${path} must reach authentication before filesystem lookup`);
    assert.equal(routing.routes[index].dest, '/api/index');
  }
  for (const path of ['/app.js', '/styles.css', '/apix'])
    assert(!routing.routes.slice(0, filesystem).some(route => route.src && new RegExp(`^${route.src}$`).test(path)), path);
  assert.deepEqual(routing.functions['api/index.mjs'], { maxDuration: 300, includeFiles: 'fixtures/**' });
});

test('function POST access requires matching HTTPS Origin and JSON without a database', async t => {
  const app = createAppServer({ env, store: {}, functionMode: true });
  t.after(() => app.dispose());
  const call = async headers => {
    const result = {};
    await app.handler({ method: 'POST', url: '/api/origin-probe', headers: {
      authorization, 'content-type': 'application/json', host: 'preview.invalid',
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'other.invalid', ...headers
    } }, { setHeader() {}, writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); } });
    return result;
  };
  for (const [origin, status] of [['https://other.invalid', 403], ['http://preview.invalid', 403],
    ['https://preview.invalid', 404], [undefined, 404]]) {
    const result = await call({ origin });
    assert.equal(result.status, status, `Origin: ${origin}`);
    if (status === 403) assert.equal(result.body.code, 'CROSS_ORIGIN_REQUEST_BLOCKED');
  }
  assert.equal((await call({ authorization: undefined, origin: 'https://preview.invalid' })).status, 401);
  assert.equal((await call({ origin: 'https://preview.invalid', 'content-type': 'text/plain' })).status, 403);
});

test('function fails closed without database, deployment identity or independent access key', async t => {
  for (const badEnv of [{}, { ...env, VERCEL_ENV: 'production' }, { ...env, ART_PREVIEW_ACCESS_KEY: '' },
    { ...env, VERCEL_ENV: 'development', DATABASE_URL: 'postgres://unused.invalid/art' }]) {
    const call = await serve(t, createFunctionHandler({ env: badEnv }));
    const result = await call('GET', '/api/config'); assert.equal(result.status, 503);
    assert.equal(result.body.code, 'PREVIEW_CONFIGURATION_REQUIRED');
  }
});

test('preview and production retain authentication, configuration and origin guards without model or database calls', async t => {
  async function call(handler, { path = '/api/config', auth = authorization, method = 'GET', headers = {} } = {}) {
    const result = { headers: {} };
    await handler({ method, url: path, headers: { authorization: auth, host: 'art.invalid',
      'content-type': 'application/json', ...headers } }, {
      setHeader(key, value) { result.headers[key.toLowerCase()] = value; },
      writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); },
      end(text) { result.text = String(text); }
    });
    return result;
  }
  const store = { limits: {}, sharedLimits: {} };
  for (const VERCEL_ENV of ['preview', 'production']) {
    const configured = { ...env, VERCEL_ENV };
    const app = createAppServer({ env: configured, store, functionMode: true,
      runtimeFactory: async () => { assert.fail('configuration checks must not start a model'); } });
    t.after(() => app.dispose());
    for (const handler of [app.handler, createFunctionHandler({ env: configured, store })]) {
      for (const path of ['/', '/index.html', '/api/config']) {
        const denied = await call(handler, { path, auth: null });
        assert.equal(denied.status, 401); assert.match(denied.headers['www-authenticate'], /Basic/);
      }
      assert.equal((await call(handler, { auth: 'Basic invalid' })).status, 401);
      const config = await call(handler);
      assert.equal(config.status, 200); assert.equal(JSON.parse(config.text).modes.live.available, false);
      for (const secret of Object.values(configured).filter(value => value.includes('secret')))
        assert.equal(config.text.includes(secret), false);
      assert.equal((await call(handler, { method: 'POST', path: '/api/origin-probe',
        headers: { origin: 'https://other.invalid' } })).status, 403);
      assert.equal((await call(handler, { method: 'POST', path: '/api/origin-probe',
        headers: { origin: 'https://art.invalid' } })).status, 404);
    }
    for (const badEnv of [{ ...configured, ART_PREVIEW_ACCESS_KEY: '' },
      { ...configured, VERCEL_ENV: 'development' }, { ...configured, VERCEL_ENV: undefined }]) {
      for (const handler of [createFunctionHandler({ env: badEnv, store }),
        createAppServer({ env: badEnv, store, functionMode: true }).handler])
        assert.equal((await call(handler)).status, 503);
    }
    assert.equal((await call(createFunctionHandler({ env: configured }))).status, 503);
  }
});

sqlTest('a real SQL save failure publishes nothing and never starts a runtime', async t => {
  const { stores, pools } = await fixture(t);
  await pools[0].query(`CREATE FUNCTION reject_project() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected write failure'; END $$;
    CREATE TRIGGER reject_project BEFORE INSERT OR UPDATE ON art_projects FOR EACH ROW EXECUTE FUNCTION reject_project()`);
  let runtimeStarts = 0;
  const app = createAppServer({ env, store: stores[0], functionMode: true,
    runtimeFactory: async () => { runtimeStarts++; throw new Error('must not start'); } });
  t.after(() => app.dispose());
  const call = await serve(t, app.handler);
  const response = await call('POST', '/api/projects', { brief });
  assert.equal(response.status, 503); assert.equal(response.body.code, 'PROJECT_STORE_UNAVAILABLE');
  assert.equal(runtimeStarts, 0); assert.equal(app.projects.size, 0);
  assert.equal((await pools[0].query('SELECT * FROM art_projects')).rowCount, 0);
  assert.equal((await pools[0].query('SELECT * FROM art_budget_runs')).rowCount, 0);
});

sqlTest('real SQL reserves shared caps and request records atomically across store instances, and rejects duplicate sends', async t => {
  const { stores, pools } = await fixture(t, { ART_MODEL_HTTP_LIMIT: '1', ART_QLOO_HTTP_LIMIT: '0',
    ART_SHARED_MODEL_HTTP_LIMIT: '1', ART_SHARED_QLOO_HTTP_LIMIT: '0' });
  const live = createProject({ brief, mode: 'live' });
  const active = await stores[0].save(live, { start: true });
  const snapshots = await Promise.all(stores.map(store => store.get(live.id)));
  let sends = 0;
  const fake = budgetedFetch(async () => { sends++; return new Response('{}'); });
  snapshots.forEach((project, index) => bindDatabaseBudget(project, stores[index], active.token));
  const attempts = await Promise.allSettled(snapshots.map(project => withHttpBudget(project, 'model', 'https://model.invalid', () => fake('https://model.invalid/v1'))));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1); assert.equal(sends, 1);
  assert.equal((await pools[0].query('SELECT * FROM art_http_attempts')).rowCount, 1);
  let saved = await stores[1].get(live.id);
  assert.equal(saved.usage.modelHttpAttempts, 1); assert.equal(saved.runtime.httpAttempts[0].outcome, 'response_ok');
  saved.status.phase = 'ready'; await stores[0].save(saved, { token: active.token });
  const next = await stores[1].save(createProject({ brief, mode: 'live' }), { start: true });
  bindDatabaseBudget(next.project, stores[1], next.token);
  await assert.rejects(() => withHttpBudget(next.project, 'model', 'https://model.invalid', () => fake('https://model.invalid/v1')), /未发送请求/);
  assert.equal(sends, 1);
  assert.equal((await pools[0].query('SELECT usage FROM art_budget_runs')).rows[0].usage.modelHttpAttempts, 1);
});

sqlTest('real SQL leases, stops and caps stay per project; changed limits keep recorded usage', async t => {
  const { stores, pools } = await fixture(t, { ART_MODEL_HTTP_LIMIT: '1' });
  const [first, second] = await Promise.all(stores.map(store => store.save(createProject({ brief, mode: 'live' }), { start: true })));
  await assert.rejects(() => stores[1].save(first.project, { start: true }), { code: 'RUNTIME_BUSY' });
  for (const [index, active] of [first, second].entries()) {
    const reserved = await stores[index].reserve(active.project, active.token, { id: randomUUID(), kind: 'model' });
    assert.equal(reserved.project.usage.modelHttpAttempts, 1);
    if (index === 0) {
      reserved.project.runtime.failure = { kind: 'model', code: 'HTTP_ERROR' };
      await stores[0].save(reserved.project, { token: active.token });
    }
  }
  const third = await stores[0].save(createProject({ brief, mode: 'live' }), { start: true });
  await stores[0].reserve(third.project, third.token, { id: randomUUID(), kind: 'model' });
  assert.deepEqual((await pools[0].query('SELECT usage FROM art_budget_runs')).rows[0].usage, { modelHttpAttempts: 3, qlooHttpAttempts: 0 });
  const raised = createPostgresStore({ pool: pools[1], env: { ART_MODEL_HTTP_LIMIT: '4', ART_SHARED_MODEL_HTTP_LIMIT: '4' } });
  const current = await raised.get(third.project.id);
  await raised.reserve(current, third.token, { id: randomUUID(), kind: 'model' });
  const fourth = await raised.save(createProject({ brief, mode: 'live' }), { start: true });
  await assert.rejects(() => raised.reserve(fourth.project, fourth.token, { id: randomUUID(), kind: 'model' }), { code: 'HTTP_BUDGET_EXHAUSTED' });
  const run = (await pools[0].query('SELECT * FROM art_budget_runs')).rows[0];
  assert.deepEqual(run.limits, { modelHttpAttempts: 4, qlooHttpAttempts: 6 });
  assert.deepEqual(run.usage, { modelHttpAttempts: 4, qlooHttpAttempts: 0 });
});

sqlTest('SQL reservation faults block all later egress and roll back counters', async t => {
  const { stores, pools } = await fixture(t);
  const active = await stores[0].save(createProject({ brief, mode: 'live' }), { start: true });
  bindDatabaseBudget(active.project, stores[0], active.token);
  await pools[0].query(`CREATE FUNCTION reject_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reservation failure'; END $$;
    CREATE TRIGGER reject_attempt BEFORE INSERT ON art_http_attempts FOR EACH ROW EXECUTE FUNCTION reject_attempt()`);
  let sends = 0;
  const fake = budgetedFetch(async () => { sends++; return new Response('{}', { status: 429 }); });
  const send = () => withHttpBudget(active.project, 'model', 'https://model.invalid', () => fake('https://model.invalid/v1'));
  await assert.rejects(send, /未发送请求/); assert.equal(sends, 0);
  assert.equal((await stores[1].get(active.project.id)).usage.modelHttpAttempts, 0);
  assert.equal((await pools[0].query('SELECT usage FROM art_budget_runs')).rows[0].usage.modelHttpAttempts, 0);
  await pools[0].query('DROP TRIGGER reject_attempt ON art_http_attempts');
  await assert.rejects(send, /禁止自动重复/); assert.equal(sends, 0);
});

sqlTest('a provider HTTP failure cannot automatically retry and consume another reservation', async t => {
  const { stores } = await fixture(t);
  const active = await stores[0].save(createProject({ brief, mode: 'live' }), { start: true });
  bindDatabaseBudget(active.project, stores[0], active.token);
  let sends = 0;
  const fake = budgetedFetch(async () => { sends++; return new Response('{}', { status: 429 }); });
  const send = () => withHttpBudget(active.project, 'model', 'https://model.invalid', () => fake('https://model.invalid/v1'));
  assert.equal((await send()).status, 429); assert.equal(sends, 1);
  await assert.rejects(send, /禁止自动重复/); assert.equal(sends, 1);
  assert.equal((await stores[1].get(active.project.id)).usage.modelHttpAttempts, 1);
});

sqlTest('an expired real SQL lease marks interrupted without replay, preserves unknown reservations and blocks stale workers', async t => {
  const { stores, pools } = await fixture(t);
  const active = await stores[0].save(createProject({ brief, mode: 'live' }), { start: true });
  const reserved = await stores[0].reserve(active.project, active.token, { id: randomUUID(), kind: 'model', status: null, outcome: 'reserved_unknown' });
  await pools[0].query(`UPDATE art_projects SET lease_until=now()-interval '1 second'`);
  await assert.rejects(() => stores[1].save(reserved.project, { start: true }), { code: 'RUN_RECOVERY_REQUIRED' });
  const recovered = await stores[1].get(active.project.id);
  assert.equal(recovered.status.phase, 'interrupted'); assert.equal(recovered.runtime.runs[0].status, 'interrupted');
  assert.equal(recovered.usage.modelHttpAttempts, 1); assert.equal(recovered.runtime.httpAttempts[0].outcome, 'reserved_unknown');
  await assert.rejects(() => stores[0].save(reserved.project, { token: active.token }), { code: 'PROJECT_STORAGE_CONFLICT' });
  await assert.rejects(() => stores[0].reserve(recovered, active.token, { id: randomUUID(), kind: 'model' }), { code: 'PROJECT_STORAGE_CONFLICT' });
  const unrelated = await stores[1].save(createProject({ brief, mode: 'live' }), { start: true });
  assert.equal(unrelated.project.runtime.runs[0].status, 'running');
  const call = await serve(t, createFunctionHandler({ env, store: stores[0], runtimeFactory: async () => { throw new Error('GET must never replay'); } }));
  assert.equal((await call('GET', `/api/projects/${active.project.id}`)).body.project.status.phase, 'interrupted');
  assert.equal((await pools[0].query('SELECT * FROM art_http_attempts')).rowCount, 1);
});

sqlTest('a bounded function request saves interrupted and refuses competing execution rather than queueing', async t => {
  const { stores } = await fixture(t);
  let rejectSubmit, entered;
  const started = new Promise(done => { entered = done; });
  const call = await serve(t, createFunctionHandler({ env, store: stores[0], maxRunMs: 100,
    runtimeFactory: async () => ({ submit: () => { entered(); return new Promise((_, reject) => { rejectSubmit = reject; }); },
      abort: async () => { rejectSubmit(Object.assign(new Error('deadline'), { code: 'RUN_INTERRUPTED' })); }, dispose: async () => {} }) }));
  const first = call('POST', '/api/projects', { brief }); await started;
  const competition = await call('POST', '/api/projects', { brief });
  assert.equal(competition.status, 409); assert.equal(competition.body.code, 'RUNTIME_BUSY');
  const result = await first;
  assert.equal(result.status, 200); assert.equal(result.body.project.status.phase, 'interrupted');
  const saved = await stores[1].get(result.body.project.id);
  assert.equal(saved.status.phase, 'interrupted'); assert.equal(saved.runtime.runs.at(-1).status, 'interrupted');
});

sqlTest('a final SQL save failure returns no candidate success and leaves only the last committed busy snapshot', async t => {
  const { stores, pools } = await fixture(t);
  await pools[0].query(`CREATE FUNCTION reject_final() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state->'status'->>'phase' != 'busy' THEN RAISE EXCEPTION 'injected final failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_final BEFORE UPDATE ON art_projects FOR EACH ROW EXECUTE FUNCTION reject_final()`);
  const app = createAppServer({ env, store: stores[0], functionMode: true, runtimeFactory: async project => ({
    async submit() { project.status.phase = 'ready'; project.concepts.push({ id: 'candidate-must-not-publish' }); },
    async dispose() {} }) });
  t.after(() => app.dispose());
  const call = await serve(t, app.handler);
  const response = await call('POST', '/api/projects', { brief });
  assert.equal(response.status, 503); assert.equal(response.body.project, undefined);
  const row = (await pools[0].query('SELECT state FROM art_projects')).rows[0].state;
  assert.equal(row.status.phase, 'busy'); assert.equal(row.concepts.length, 0);
  assert.deepEqual(app.projects.get(row.id), row);
});

sqlTest('a real SQL result-save fault keeps an unknown charged attempt and blocks same-kind retries and model closing egress', async t => {
  const { stores, pools } = await fixture(t);
  const active = await stores[0].save(createProject({ brief, mode: 'live' }), { start: true });
  bindDatabaseBudget(active.project, stores[0], active.token);
  await pools[0].query(`CREATE FUNCTION reject_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected result failure'; END $$;
    CREATE TRIGGER reject_result BEFORE UPDATE ON art_http_attempts FOR EACH ROW EXECUTE FUNCTION reject_result()`);
  let sends = 0;
  const fake = budgetedFetch(async () => { sends++; return new Response('{}'); });
  const send = kind => withHttpBudget(active.project, kind, 'https://provider.invalid', () => fake('https://provider.invalid/query'));
  await assert.rejects(() => send('qloo'), /结果记录无法保存/); assert.equal(sends, 1);
  await pools[0].query('DROP TRIGGER reject_result ON art_http_attempts');
  await assert.rejects(() => send('qloo'), /禁止自动重复/);
  await assert.rejects(() => send('model'), /禁止自动重复/);
  assert.equal(sends, 1);
  const restored = await stores[1].get(active.project.id);
  assert.equal(restored.usage.qlooHttpAttempts, 1);
  assert.equal(restored.runtime.httpAttempts[0].outcome, 'reserved_unknown');
  assert.equal((await pools[0].query('SELECT * FROM art_http_attempts')).rowCount, 1);
});

sqlTest('Qloo-only exhaustion preserves bounded model closing requests and stays scoped to its project', async t => {
  const { stores } = await fixture(t, { ART_MODEL_HTTP_LIMIT: '3', ART_QLOO_HTTP_LIMIT: '0', ART_SHARED_MODEL_HTTP_LIMIT: '3' });
  const active = await stores[0].save(createProject({ brief, mode: 'live' }), { start: true });
  bindDatabaseBudget(active.project, stores[0], active.token, undefined, active.usage);
  active.project.runtime.queryStopped = true;
  active.project.runtime.failure = { kind: 'qloo', code: 'QLOO_HTTP_BUDGET_EXHAUSTED' };
  let sends = 0;
  const fake = budgetedFetch(async () => { sends++; return new Response('{}'); });
  await withHttpBudget(active.project, 'model', 'https://model.invalid', () => fake('https://model.invalid/close'));
  assert.equal(sends, 1);
  active.project.status.phase = 'insufficient_evidence';
  await stores[0].save(active.project, { token: active.token });
  const next = await stores[1].save(createProject({ brief, mode: 'live' }), { start: true });
  bindDatabaseBudget(next.project, stores[1], next.token, undefined, next.usage);
  assert.equal(remainingBudget(next.project).modelHttpAttempts, 2);
  assert.equal(remainingBudget(next.project).queryStopped, false);
  await withHttpBudget(next.project, 'model', 'https://model.invalid', () => fake('https://model.invalid/close'));
  assert.equal(sends, 2);
});

sqlTest('minimal unresolved observations survive independent function sessions without a historical session file', async t => {
  const { stores } = await fixture(t);
  const project = createProject({ brief }); project.status.phase = 'error';
  const result = { status: 'needs_input', resolution: { candidates: [{ entity_id: 'synthetic-candidate', name: 'Synthetic unconfirmed candidate' }], confirmed: false }, results: [] };
  project.runtime.openResearchQuestions = unresolvedResearch([
    { role: 'assistant', content: [{ type: 'toolCall', id: 'unconfirmed', name: 'qloo_describe', arguments: { entity: 'Synthetic ambiguous input' } }] },
    { role: 'toolResult', toolCallId: 'unconfirmed', toolName: 'qloo_describe', details: result } ]);
  await stores[0].save(project);
  for (let pass = 0; pass < 2; pass++) {
    let observed;
    const call = await serve(t, createFunctionHandler({ env, store: stores[pass], runtimeOptions: { decide(context) {
      const message = context.messages.find(entry => entry.role === 'user');
      observed = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('')).project;
      return [{ type: 'text', text: '离线保留尚未确认的观察；未调用外部接口。' }];
    } } }));
    const response = await call('POST', `/api/projects/${project.id}/messages`, { text: '保留原有未确认信息' });
    assert.equal(response.status, 200);
    assert.equal(observed.openResearchQuestions.length, 1);
    assert.equal(observed.openResearchQuestions[0].confirmed, false);
    assert.deepEqual(observed.openResearchQuestions[0].result.resolution, result.resolution);
    const saved = await stores[1].get(project.id);
    assert.deepEqual(saved.runtime.openResearchQuestions, project.runtime.openResearchQuestions);
    assert.equal(saved.runtime.sessionFile, undefined);
  }
});
