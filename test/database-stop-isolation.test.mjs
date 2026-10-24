import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../app/state.mjs';
import { createProductRuntime, recordEvidence } from '../app/runtime.mjs';
import { createAppServer } from '../app/server.mjs';
import { createAndStart } from './project-http.mjs';
import { bindDatabaseBudget, budgetedFetch, createHttpBudget, remainingBudget, serverUsage,
  stopLiveRun, validationRun, withHttpBudget } from '../app/transport.mjs';

const brief = { request: 'Synthetic project stop isolation', venue: 'Synthetic indoor venue' };
const env = { ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'deepseek', ART_MODEL_ID: 'deepseek-flash',
  ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://api.deepseek.com',
  ART_MODEL_API_KEY: 'synthetic-unused-model-key', QLOO_API_KEY: 'synthetic-unused-qloo-key',
  QLOO_API_URL: 'https://hackathon.api.qloo.com' };

function reset() {
  Object.assign(serverUsage, { modelHttpAttempts: 0, qlooHttpAttempts: 0 });
  Object.assign(validationRun, { liveStopped: false, queryStopped: false, attempts: [] });
  delete validationRun.failure;
}

// The database boundary retains snapshots and reservations; production runtime,
// server routes, budget guards and official provider/tool handling stay real.
function memoryStore() {
  const records = new Map(), usage = { modelHttpAttempts: 0, qlooHttpAttempts: 0 };
  return { limits: { modelHttpAttempts: 6, qlooHttpAttempts: 6 },
    sharedLimits: { modelHttpAttempts: null, qlooHttpAttempts: null },
    async get(id) { return structuredClone(records.get(id)); },
    async save(project, { start = false } = {}) {
      const saved = structuredClone(project); saved.storageVersion = (saved.storageVersion ?? 0) + 1;
      if (start) (saved.runtime.runs ??= []).push({ id: 'synthetic-lease', status: 'running' });
      records.set(saved.id, structuredClone(saved));
      return start ? { project: saved, token: 'synthetic-lease', usage: { ...usage } } : saved;
    },
    async reserve(project, _token, detail) {
      const saved = structuredClone(project), key = `${detail.kind}HttpAttempts`;
      saved.usage[key]++; usage[key]++; saved.storageVersion++;
      records.set(saved.id, structuredClone(saved));
      return { project: saved, usage: { ...usage } };
    }, async finishAttempt() {} };
}

function modelResponse(tool, args) {
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'synthetic-stop',
    object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash',
    choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic-tool', type: 'function',
    function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Synthetic bounded conclusion.' };
  return new Response(chunk(delta) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

async function runtime(t, project) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'art-stop-isolation-'));
  const result = await createProductRuntime(project, { env, memorySession: true, runtimeRoot });
  t.after(async () => { await result.dispose(); await rm(runtimeRoot, { recursive: true, force: true }); });
  return result;
}

async function serve(t, app) {
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(() => app.dispose());
  return (path, payload) => new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port: app.server.address().port, method: 'POST', path,
      headers: { 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
}

test('database server keeps A model failure across reread/bind while B creates and continues in the same instance', async t => {
  reset(); t.after(reset);
  let sends = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = budgetedFetch(async url => {
    assert.equal(new URL(String(url)).origin, env.ART_MODEL_BASE_URL); sends++;
    return sends === 1 ? new Response('{"error":{"code":"synthetic_failure"}}', { status: 503 }) : modelResponse();
  });
  t.after(() => { globalThis.fetch = previousFetch; });
  const store = memoryStore(), app = createAppServer({ env, store });
  const call = await serve(t, app);
  const a = await createAndStart((_method, path, payload) => call(path, payload), { mode: 'live', brief });
  assert.equal(a.status, 200); assert.equal(a.body.project.runtime.failure.kind, 'model');
  assert.equal(sends, 1);
  assert.equal(validationRun.liveStopped, false, 'database failures must not write the file validation latch');
  Object.assign(validationRun, { liveStopped: true, queryStopped: true });
  const b = await createAndStart((_method, path, payload) => call(path, payload), { mode: 'live', brief });
  assert.equal(b.status, 200, 'A failure must not reject creation of B');
  assert.equal(sends, 2, 'B reaches its own model boundary');
  assert.equal((await call(`/api/projects/${b.body.project.id}/messages`, { text: 'Continue B' })).status, 200);
  assert.equal(sends, 3, 'B messages must not read the process stop from A');
  const restoredA = await store.get(a.body.project.id);
  bindDatabaseBudget(restoredA, store, 'new-lease');
  const before = sends;
  await assert.rejects(() => withHttpBudget(restoredA, 'model', env.ART_MODEL_BASE_URL,
    () => globalThis.fetch(`${env.ART_MODEL_BASE_URL}/chat/completions`)));
  assert.equal(sends, before, 'A remains stopped after storage reread and rebinding');
  assert.equal(validationRun.liveStopped, true, 'database requests must not reset file validation stops');
  assert.equal(validationRun.attempts.length, 0, 'database requests keep their own attempt records');
});

test('database Qloo failure stops only A queries, keeps model closing, and permits B queries after reread', async t => {
  reset(); t.after(reset);
  const store = memoryStore(), a = createProject({ mode: 'live', brief }), b = createProject({ mode: 'live', brief });
  bindDatabaseBudget(a, store, 'lease-a'); bindDatabaseBudget(b, store, 'lease-b');
  const savedEvidence = recordEvidence(a, 'describe', { entity: 'Synthetic stored entity' }, {
    correlationId: 'synthetic-previous-query', result: { status: 'ok', results: [{ entity_id: 'synthetic-stored-entity',
      name: 'Synthetic stored entity', properties: { description: 'Previously saved exact synthetic description.' } }] } });
  let qlooSends = 0, modelSends = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = budgetedFetch(async url => {
    const origin = new URL(String(url)).origin;
    if (origin === env.QLOO_API_URL) { qlooSends++; return new Response('{"error":"synthetic query failure"}', { status: 503 }); }
    assert.equal(origin, env.ART_MODEL_BASE_URL); modelSends++;
    return modelSends === 1 ? modelResponse('read_project_evidence', { evidenceId: savedEvidence.id,
      entityId: 'synthetic-stored-entity', field: 'properties.description' })
      : modelResponse('propose_design_response', { baseVersion: a.version, phase: 'insufficient_evidence',
        summary: 'The existing description is a fact; new association evidence is unavailable. Pause without unsupported claims.',
        questions: [], concepts: [] });
  });
  t.after(() => { globalThis.fetch = previousFetch; });
  const aRuntime = await runtime(t, a);
  const first = await aRuntime.session.getToolDefinition('qloo_describe')
    .execute('synthetic-describe', { entity: 'Before Sunrise' });
  assert.equal(first.details.status, 'error'); assert.equal(a.runtime.queryStopped, true);
  assert(qlooSends > 0, 'the real official workflow reached the substituted HTTP boundary');
  const stoppedCount = qlooSends;
  await aRuntime.session.getToolDefinition('qloo_describe')
    .execute('synthetic-retry', { entity: 'Before Sunrise' });
  assert.equal(qlooSends, stoppedCount);
  await aRuntime.submit('Conclude from existing evidence without another query');
  assert.equal(modelSends, 2, 'Qloo-only failure keeps bounded model evidence reading and closing');
  const evidenceRead = aRuntime.session.messages.find(message => message.role === 'toolResult' && message.toolName === 'read_project_evidence');
  assert.equal(evidenceRead.details.exact, true);
  assert.equal(evidenceRead.details.value, 'Previously saved exact synthetic description.');
  assert.equal(a.status.phase, 'insufficient_evidence');
  await store.save(a);
  const restored = await store.get(a.id); bindDatabaseBudget(restored, store, 'new-lease');
  await assert.rejects(() => withHttpBudget(restored, 'qloo', env.QLOO_API_URL,
    () => globalThis.fetch(`${env.QLOO_API_URL}/search`)));
  assert.equal(qlooSends, stoppedCount, 'A query stop survives storage reread and rebinding');
  assert.equal(remainingBudget(b).queryStopped, false);
  const bRuntime = await runtime(t, b);
  await bRuntime.session.getToolDefinition('qloo_describe')
    .execute('synthetic-b-query', { entity: 'Before Sunrise' });
  assert(qlooSends > stoppedCount, 'B reaches Qloo despite A failure in the same process');
  assert.equal(validationRun.queryStopped, false);
});

test('database runtime ignores a stopped file validation round through tool continuation', async t => {
  reset(); t.after(reset);
  const project = createProject({ mode: 'live', brief }); bindDatabaseBudget(project, memoryStore(), 'lease');
  let sends = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = budgetedFetch(async () => {
    sends++;
    return sends === 1 ? modelResponse('read_project_evidence', { evidenceId: 'missing-synthetic-evidence' }) : modelResponse();
  });
  t.after(() => { globalThis.fetch = previousFetch; });
  Object.assign(validationRun, { liveStopped: true, queryStopped: true });
  const instance = await runtime(t, project);
  await instance.submit('Check saved evidence and conclude');
  assert.equal(sends, 2, 'both HTTP and shouldStopAfterTurn must use the project database scope');
  assert.equal(project.runtime.failure, undefined);
});

test('file validation still stops all projects and preserves Qloo-only model closing', async t => {
  reset(); t.after(reset);
  const dataDir = await mkdtemp(join(tmpdir(), 'art-file-stop-'));
  const budget = createHttpBudget({ env: {}, dataDir });
  t.after(async () => { budget.release(); await rm(dataDir, { recursive: true, force: true }); });
  const a = createProject({ mode: 'live', brief }), b = createProject({ mode: 'live', brief });
  budget.bind(a, true); budget.bind(b, true);
  let sends = 0;
  const fake = budgetedFetch(async () => { sends++; return new Response('{}'); });
  stopLiveRun(a, { kind: 'qloo', code: 'SYNTHETIC_FAILURE' }, true);
  assert.equal(remainingBudget(b).queryStopped, true);
  await assert.rejects(() => withHttpBudget(b, 'qloo', env.QLOO_API_URL, () => fake(`${env.QLOO_API_URL}/search`)));
  await withHttpBudget(b, 'model', env.ART_MODEL_BASE_URL, () => fake(`${env.ART_MODEL_BASE_URL}/chat/completions`));
  assert.equal(sends, 1);
  stopLiveRun(a, { kind: 'model', code: 'SYNTHETIC_FAILURE' });
  await assert.rejects(() => withHttpBudget(b, 'model', env.ART_MODEL_BASE_URL, () => fake(`${env.ART_MODEL_BASE_URL}/chat/completions`)));
  assert.equal(sends, 1); assert.equal(validationRun.liveStopped, true);
});
