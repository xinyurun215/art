import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createAppServer } from '../app/server.mjs';
import { configStatus, createProject } from '../app/state.mjs';
import { budgetedFetch, validationRun } from '../app/transport.mjs';

const brief = { request: 'New real project input; never use a preset', venue: 'Unconfirmed venue' };
const payload = extra => ({ creationKey: randomBytes(32).toString('hex'), brief, ...extra });
const env = { VERCEL_ENV: 'production', ART_PREVIEW_ACCESS_KEY: 'synthetic-preview-key', ART_ENABLE_LIVE: 'true',
  ART_MODEL_PROVIDER: 'deepseek', ART_MODEL_ID: 'deepseek-flash', ART_MODEL_API: 'openai-completions',
  ART_MODEL_BASE_URL: 'https://api.deepseek.com', ART_MODEL_API_KEY: 'synthetic-model-key',
  QLOO_API_KEY: 'synthetic-qloo-key', QLOO_API_URL: 'https://hackathon.api.qloo.com' };

function memoryStore() {
  const records = new Map(), usage = { modelHttpAttempts: 0, qlooHttpAttempts: 0 };
  return { records, limits: { modelHttpAttempts: 6, qlooHttpAttempts: 6 }, sharedLimits: { modelHttpAttempts: null, qlooHttpAttempts: null },
    async get(id) { return structuredClone(records.get(id)); },
    async save(project, { create = false, start = false, initial = false } = {}) {
      const old = records.get(project.id);
      if (create && old) {
        if (old.creation.fingerprint !== project.creation.fingerprint || old.guestOwner !== project.guestOwner)
          throw Object.assign(new Error('Creation conflict'), { code: 'PROJECT_CREATION_CONFLICT', statusCode: 409 });
        return structuredClone(old);
      }
      if (initial && old.status.phase !== 'created') return { project: structuredClone(old), alreadyStarted: true };
      const next = structuredClone(project); next.storageVersion = (next.storageVersion ?? 0) + 1;
      if (start) (next.runtime.runs ??= []).push({ id: 'private-lease', status: 'running' });
      records.set(next.id, structuredClone(next));
      return start ? { project: next, token: 'private-lease', usage } : next;
    }, async reserve(project, _token, detail) {
      const next = structuredClone(project), key = `${detail.kind}HttpAttempts`;
      next.usage[key]++; next.storageVersion++; usage[key]++;
      records.set(next.id, structuredClone(next)); return { project: next, usage };
    }, async finishAttempt() {} };
}
async function fixture(t, configured = env, store = memoryStore()) {
  const app = createAppServer({ env: configured, store, functionMode: Boolean(configured.VERCEL_ENV),
    runtimeOptions: { decide() { assert.fail('production may not call the offline model'); } } });
  t.after(() => app.dispose());
  const call = async (method, url, body, cookie) => {
    const result = { headers: {} };
    await app.handler({ method, url, body, headers: { host: 'art-lovat-two.vercel.app',
      'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }, {
      setHeader(name, value) { result.headers[name.toLowerCase()] = value; }, writeHead(status) { result.status = status; },
      end(text) { result.body = JSON.parse(text); }
    });
    return result;
  };
  return { app, store, call };
}
const cookieOf = result => result.headers['set-cookie']?.split(';')[0];
function response(version) {
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'synthetic-live-entry', object: 'chat.completion.chunk',
    created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'actual-proposal', type: 'function', function: {
    name: 'propose_design_response', arguments: JSON.stringify({ baseVersion: version, phase: 'insufficient_evidence',
      summary: 'Response from the substituted live provider. Research is insufficient; no preset was used.', concepts: [] }) } }] })
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('production is derived from deployment or Node environment; development keeps offline available', () => {
  for (const configured of [{ VERCEL_ENV: 'production' }, { NODE_ENV: 'production' }]) {
    assert.equal(configStatus(configured).production, true);
    assert.equal(configStatus(configured).modes.offline.available, false);
  }
  for (const configured of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { VERCEL_ENV: 'preview' },
    { NODE_ENV: 'production', VERCEL_ENV: 'preview' }, { NODE_ENV: 'production', VERCEL_ENV: 'development' }]) {
    assert.equal(configStatus(configured).production, false); assert.equal(configStatus(configured).modes.offline.available, true);
  }
});

test('production omitted mode uses the real runtime; legacy sufficient payload deduplicates and start is once', async t => {
  const f = await fixture(t), input = payload();
  let sends = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = budgetedFetch(async url => { assert.equal(new URL(String(url)).origin, env.ART_MODEL_BASE_URL); sends++; return response(1); });
  t.after(() => { globalThis.fetch = previous; Object.assign(validationRun, { liveStopped: false, queryStopped: false }); });
  Object.assign(validationRun, { liveStopped: true, queryStopped: true });
  const created = await f.call('POST', '/api/projects', input), cookie = cookieOf(created);
  assert.equal(created.status, 201); assert.equal(created.body.project.mode, 'live'); assert.equal(sends, 0); assert(cookie);
  const replay = await f.call('POST', '/api/projects', { ...input, mode: 'live', scenario: 'sufficient' });
  assert.equal(replay.status, 201); assert.equal(replay.body.project.id, created.body.project.id); assert.equal(cookieOf(replay), cookie);
  const id = created.body.project.id;
  assert.equal((await f.call('GET', `/api/projects/${id}`)).status, 404);
  const started = await f.call('POST', `/api/projects/${id}/start`, {}, cookie);
  assert.equal(started.status, 200); assert.equal(sends, 1); assert.equal(started.body.project.version, 2);
  assert.match(started.body.project.status.detail, /substituted live provider/);
  assert.equal(started.body.project.usage.qlooHttpAttempts, 0);
  const before = await f.store.get(id);
  await f.call('POST', `/api/projects/${id}/start`, {}, cookie);
  assert.deepEqual(await f.store.get(id), before); assert.equal(sends, 1);
  assert.equal(started.body.project.creation, undefined); assert.equal(started.body.project.guestOwner, undefined);
});

test('production refuses new offline projects and fixtures, and unavailable live service never generates synthetic content', async t => {
  const f = await fixture(t, { VERCEL_ENV: 'production', ART_PREVIEW_ACCESS_KEY: 'synthetic-preview-key' });
  const previous = globalThis.fetch; let sends = 0;
  globalThis.fetch = () => { sends++; assert.fail('unavailable service cannot send'); };
  t.after(() => { globalThis.fetch = previous; });
  for (const extra of [{ mode: 'offline' }, { scenario: 'failure' }, { scenario: 'irrelevant' }, { offlineFixture: 'pair_45' }]) {
    const result = await f.call('POST', '/api/projects', payload(extra));
    assert.equal(result.status, 400); assert.equal(result.body.code, 'SYNTHETIC_MODE_DISABLED');
  }
  assert.equal(f.store.records.size, 0);
  const created = await f.call('POST', '/api/projects', payload()), id = created.body.project.id, cookie = cookieOf(created);
  assert.equal(created.body.project.mode, 'live');
  for (const input of [{ text: 'Do not run offline', mode: 'offline' }, { text: 'Do not use a fixture', offlineFixture: 'pair_45' }]) {
    const rejected = await f.call('POST', `/api/projects/${id}/messages`, input, cookie);
    assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'SYNTHETIC_MODE_DISABLED');
  }
  const stopped = await f.call('POST', `/api/projects/${id}/start`, {}, cookie);
  assert.equal(stopped.status, 503); assert.equal(stopped.body.code, 'LIVE_SERVICE_UNAVAILABLE');
  assert.match(stopped.body.error, /disabled|configuration/i); assert.match(stopped.body.error, /saved/i);
  assert.equal((await f.store.get(id)).status.phase, 'created'); assert.equal(sends, 0);
});

test('an existing offline pending creation recovers only the matching identity and stays read only in production', async t => {
  const store = memoryStore(), input = payload({ mode: 'offline', scenario: 'sufficient' });
  const project = createProject(input), hash = value => createHash('sha256').update(value).digest('hex');
  project.id = hash(`art-project:${input.creationKey}`);
  project.creation = { fingerprint: hash(JSON.stringify({ brief: project.brief, mode: project.mode, scenario: project.scenario })) };
  project.guestOwner = hash(hash(`art-guest-creation:${input.creationKey}`)); project.status.phase = 'created';
  const saved = await store.save(project), f = await fixture(t, env, store);
  const restored = await f.call('POST', '/api/projects', input), cookie = cookieOf(restored), id = project.id;
  assert.equal(restored.status, 201); assert.equal(restored.body.project.id, id); assert.equal(restored.body.project.mode, 'offline'); assert(cookie);
  assert.deepEqual(await store.get(id), saved);
  for (const route of ['start', 'messages', 'select', 'locks', 'revisions', 'revisions/missing/accept', 'revisions/missing/feedback']) {
    const result = await f.call('POST', `/api/projects/${id}/${route}`, { text: 'Do not synthesize' }, cookie);
    assert.equal(result.status, 409); assert.equal(result.body.code, 'OFFLINE_PROJECT_READ_ONLY');
  }
  assert.deepEqual(await store.get(id), saved);
  assert.equal((await f.call('GET', `/api/projects/${id}`, undefined, cookie)).status, 200);
  const conflict = await f.call('POST', '/api/projects', { ...input, brief: { request: 'Changed input' } });
  assert.equal(conflict.status, 409); assert.equal(conflict.headers['set-cookie'], undefined);
  const next = await f.call('POST', '/api/projects', payload(), cookie);
  assert.equal(next.status, 201); assert.equal(next.body.project.mode, 'live'); assert.equal(store.records.size, 2);
});

test('development still supports explicitly requested offline execution', async t => {
  const store = memoryStore(), f = await fixture(t, { NODE_ENV: 'development' }, store);
  const created = await f.call('POST', '/api/projects', payload({ mode: 'offline' }));
  assert.equal(created.status, 201); assert.equal(created.body.project.mode, 'offline');
  // Use the actual offline runtime without any external provider requests.
  const dev = createAppServer({ env: { NODE_ENV: 'development' }, store }); t.after(() => dev.dispose());
  const result = {};
  await dev.handler({ method: 'POST', url: `/api/projects/${created.body.project.id}/start`, body: {}, headers: {} }, {
    writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); }
  });
  assert.equal(result.status, 200); assert.equal(result.body.project.mode, 'offline'); assert.equal(result.body.project.status.phase, 'needs_input');
  assert.equal(result.body.project.usage.modelHttpAttempts, 0); assert.equal(result.body.project.usage.qlooHttpAttempts, 0);
});
