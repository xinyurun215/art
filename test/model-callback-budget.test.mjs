import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProductRuntime } from '../app/runtime.mjs';
import { createProject } from '../app/state.mjs';
import * as transport from '../app/transport.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = join(root, '.art-runtime');
const env = { ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'deepseek', ART_MODEL_ID: 'deepseek-flash',
  ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://api.deepseek.com',
  ART_MODEL_API_KEY: 'synthetic-local-only-key', QLOO_API_KEY: 'synthetic-local-only-qloo-key',
  QLOO_API_URL: 'https://hackathon.api.qloo.com' };
const configured = { ART_MODEL_HTTP_LIMIT: '30', ART_QLOO_HTTP_LIMIT: '20' };
const counts = (modelHttpAttempts, qlooHttpAttempts) => ({ modelHttpAttempts, qlooHttpAttempts });

function response() {
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'synthetic-callback-budget',
    object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: 'assistant', content: 'Synthetic callback response.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t, { modelCalls = 0, modelHttpAttempts = 0, limits = configured, mode = 'live' } = {}) {
  Object.assign(transport.serverUsage, counts(modelHttpAttempts, 0));
  Object.assign(transport.validationRun, { queryStopped: false, liveStopped: false });
  transport.validationRun.attempts.length = 0;
  delete transport.validationRun.failure;
  const project = createProject({ mode, brief: { request: 'Synthetic callback and HTTP budget boundary', venue: 'Synthetic room' } });
  project.usage.modelCalls = modelCalls;
  project.usage.modelHttpAttempts = modelHttpAttempts;
  assert.match(project.id, /^[0-9a-f-]{36}$/);
  const directory = resolve(runtimeRoot, project.id);
  assert(directory.startsWith(runtimeRoot + sep));
  assert.equal(existsSync(directory), false, 'this test exclusively owns its fresh runtime UUID');
  const temporaryRoot = resolve(tmpdir());
  const dataDir = mkdtempSync(join(temporaryRoot, 'art-callback-budget-'));
  assert(dataDir.startsWith(temporaryRoot + sep));
  const snapshotPath = join(dataDir, 'project-snapshot.json');
  const previousFetch = globalThis.fetch;
  let budget, runtime, sent = 0, qlooExecutions = 0, decisions = 0;
  globalThis.fetch = transport.budgetedFetch(async (url, options) => {
    assert.equal(new URL(String(url)).origin, env.ART_MODEL_BASE_URL, 'no Qloo or other external destination is allowed');
    assert.equal(JSON.parse(options.body).model, 'deepseek-flash');
    sent++;
    return response();
  });
  t.after(async () => {
    await runtime?.dispose();
    budget?.release();
    globalThis.fetch = previousFetch;
    assert(directory.startsWith(runtimeRoot + sep) && resolve(directory) === join(runtimeRoot, project.id));
    rmSync(directory, { recursive: true, force: true });
    assert(dataDir.startsWith(temporaryRoot + sep));
    rmSync(dataDir, { recursive: true, force: true });
  });
  if (mode === 'live') {
    budget = transport.createHttpBudget({ env: limits, dataDir });
    budget.bind(project, true);
  }
  runtime = await createProductRuntime(project, { env: mode === 'live' ? env : {},
    decide() { decisions++; return [{ type: 'text', text: 'Synthetic offline callback.' }]; },
    qlooExecutor: { transport: { kind: 'direct', remote: false }, async execute() {
      qlooExecutions++;
      assert.fail('callback budget tests never execute Qloo');
    } } });
  return { project, runtime, budget, dataDir, snapshotPath,
    get sent() { return sent; }, get decisions() { return decisions; }, get qlooExecutions() { return qlooExecutions; } };
}

test('configured thirty-request project can send its nineteenth model callback', async t => {
  const state = await fixture(t, { modelCalls: 18, modelHttpAttempts: 18 });
  await state.runtime.submit('Synthetic nineteenth callback');
  assert.equal(state.sent, 1);
  assert.equal(state.project.usage.modelCalls, 19);
  assert.equal(state.project.usage.modelHttpAttempts, 19);
  assert.equal(state.qlooExecutions, 0);
});

test('callback totals survive new sessions and a new process while HTTP remains capped at thirty', async t => {
  const state = await fixture(t, { modelCalls: 19, modelHttpAttempts: 18 });
  await state.runtime.submit('Synthetic first continuation');
  assert.equal(state.sent, 1);
  assert.equal(state.project.usage.modelCalls, 20);
  const firstSession = state.project.runtime.sessionId;
  await state.runtime.submit('Synthetic second continuation');
  assert.equal(state.sent, 2);
  assert.equal(state.project.usage.modelCalls, 21);
  assert.notEqual(state.project.runtime.sessionId, firstSession);
  writeFileSync(state.snapshotPath, JSON.stringify(state.project));
  await state.runtime.dispose();
  state.budget.release();
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    globalThis.fetch = async () => { throw new Error('Unexpected external fetch'); };
    const transport = await import(${JSON.stringify(new URL('../app/transport.mjs', import.meta.url).href)});
    const { createProductRuntime } = await import(${JSON.stringify(new URL('../app/runtime.mjs', import.meta.url).href)});
    const env = ${JSON.stringify(env)};
    const response = ${response.toString()};
    const project = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const budget = transport.createHttpBudget({ env: ${JSON.stringify(configured)}, dataDir: process.argv[2] });
    budget.bind(project);
    assert.equal(project.usage.modelCalls, 21);
    assert.equal(project.usage.modelHttpAttempts, 20);
    assert.equal(transport.serverUsage.modelHttpAttempts, 20);
    let sends = 0, qlooExecutions = 0;
    globalThis.fetch = transport.budgetedFetch(async (url, options) => {
      assert.equal(new URL(String(url)).origin, env.ART_MODEL_BASE_URL);
      assert.equal(JSON.parse(options.body).model, 'deepseek-flash');
      sends++;
      return response();
    });
    const runtime = await createProductRuntime(project, { env,
      qlooExecutor: { transport: { kind: 'direct', remote: false }, async execute() {
        qlooExecutions++; throw new Error('Qloo execution is forbidden');
      } } });
    try {
      for (let index = 0; index < 10; index++) await runtime.submit('Synthetic restored continuation ' + index);
      assert.equal(sends, 10);
      assert.equal(project.usage.modelCalls, 31);
      assert.equal(project.usage.modelHttpAttempts, 30);
      assert.equal(transport.serverUsage.modelHttpAttempts, 30);
      await runtime.submit('Synthetic exhausted continuation');
      assert.equal(sends, 10);
      assert.equal(project.usage.modelCalls, 31, 'HTTP exhaustion is checked before increasing callback totals');
      assert.equal(project.runtime.localFailure.code, 'MODEL_HTTP_BUDGET_EXHAUSTED');
      const saved = JSON.parse(readFileSync(process.argv[2] + '/.http-budget/run.json', 'utf8'));
      assert.equal(saved.usage.modelHttpAttempts, 30);
      assert.equal(saved.registeredProjects[project.id].usage.modelHttpAttempts, 30);
      assert.equal(qlooExecutions, 0);
      writeFileSync(process.argv[1], JSON.stringify(project));
      console.log(JSON.stringify({ sends, modelCalls: project.usage.modelCalls, modelHttpAttempts: project.usage.modelHttpAttempts, qlooExecutions }));
    } finally { await runtime.dispose(); budget.release(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, state.snapshotPath, state.dataDir],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { sends: 10, modelCalls: 31, modelHttpAttempts: 30, qlooExecutions: 0 });
  assert.equal(state.qlooExecutions, 0);
});

test('default live callback allowance remains eighteen with a specific local stop reason', async t => {
  const state = await fixture(t, { modelCalls: 17, limits: {} });
  await state.runtime.submit('Synthetic default callback eighteen');
  assert.equal(state.sent, 1);
  assert.equal(state.project.usage.modelCalls, 18);
  await state.runtime.submit('Synthetic default callback nineteen');
  assert.equal(state.sent, 1);
  assert.equal(state.project.usage.modelCalls, 19);
  assert.equal(state.project.runtime.localFailure?.code, 'MODEL_CALLBACK_BUDGET_EXHAUSTED');
  assert.equal(state.project.usage.modelHttpAttempts, 1);
});

test('offline callback allowance remains eighteen without HTTP or Qloo', async t => {
  const state = await fixture(t, { modelCalls: 17, mode: 'offline' });
  await state.runtime.submit('Synthetic offline callback eighteen');
  assert.equal(state.decisions, 1);
  assert.equal(state.project.usage.modelCalls, 18);
  await state.runtime.submit('Synthetic offline callback nineteen');
  assert.equal(state.decisions, 1);
  assert.equal(state.project.usage.modelCalls, 19);
  assert.equal(state.project.runtime.localFailure?.code, 'MODEL_CALLBACK_BUDGET_EXHAUSTED');
  assert.equal(state.sent, 0);
  assert.equal(state.project.usage.modelHttpAttempts, 0);
  assert.equal(state.qlooExecutions, 0);
});

test('trusted thirty-request configuration has finite callback headroom through forty-two', async t => {
  const state = await fixture(t, { modelCalls: 41 });
  await state.runtime.submit('Synthetic callback forty-two');
  assert.equal(state.sent, 1);
  assert.equal(state.project.usage.modelCalls, 42);
  await state.runtime.submit('Synthetic callback forty-three');
  assert.equal(state.sent, 1);
  assert.equal(state.project.usage.modelCalls, 43);
  assert.equal(state.project.runtime.localFailure?.code, 'MODEL_CALLBACK_BUDGET_EXHAUSTED');
  assert.equal(state.project.usage.modelHttpAttempts, 1);
});

test('HTTP exhaustion wins before a callback total beyond its local allowance', async t => {
  const state = await fixture(t, { modelCalls: 100, modelHttpAttempts: 30 });
  await state.runtime.submit('Synthetic request at an already exhausted HTTP boundary');
  assert.equal(state.sent, 0);
  assert.equal(state.project.usage.modelCalls, 100);
  assert.equal(state.project.usage.modelHttpAttempts, 30);
  assert.equal(state.project.runtime.localFailure?.code, 'MODEL_HTTP_BUDGET_EXHAUSTED');
});
