import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createProject } from '../app/state.mjs';
import * as transport from '../app/transport.mjs';

const configured = { ART_MODEL_HTTP_LIMIT: '30', ART_QLOO_HTTP_LIMIT: '20' };
const counts = (modelHttpAttempts, qlooHttpAttempts) => ({ modelHttpAttempts, qlooHttpAttempts });
const nativeRename = fs.renameSync;
const nativeWrite = fs.writeFileSync;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const freshProject = () => createProject({ mode: 'live', brief: { request: 'Synthetic atomic budget persistence test' } });

function fixture(t, onReserve) {
  Object.assign(transport.serverUsage, counts(0, 0));
  Object.assign(transport.validationRun, { queryStopped: false, liveStopped: false });
  transport.validationRun.attempts.length = 0;
  delete transport.validationRun.failure;
  const parent = resolve(tmpdir());
  const dataDir = fs.mkdtempSync(join(parent, 'art-budget-persistence-'));
  assert(dataDir.startsWith(parent + sep), 'cleanup remains within this test temporary root');
  let budget;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platformDescriptor);
    budget?.release();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  budget = transport.createHttpBudget({ env: configured, dataDir, onReserve });
  const project = freshProject();
  budget.bind(project, true);
  const path = join(dataDir, '.http-budget', 'run.json');
  return { budget, project, path, temporary: `${path}.tmp`, saved: () => JSON.parse(fs.readFileSync(path, 'utf8')) };
}

function observe(t, state, { platform = 'win32', fail = () => false, code = 'EPERM' } = {}) {
  const writes = [], attempts = [], waits = [];
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
  t.mock.method(Atomics, 'wait', (_array, _index, _value, milliseconds) => { waits.push(milliseconds); return 'timed-out'; });
  t.mock.method(fs, 'writeFileSync', (path, value, ...options) => {
    if (path === state.temporary) writes.push(String(value));
    return nativeWrite(path, value, ...options);
  });
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination !== state.path) return nativeRename(source, destination);
    const candidate = fs.readFileSync(source, 'utf8');
    attempts.push({ source, destination, candidate });
    assert.equal(source, state.temporary, 'every retry uses the same candidate pathname');
    if (fail(attempts.length, JSON.parse(candidate))) throw Object.assign(new Error(`synthetic rename ${code}`), { code });
    const previous = state.saved();
    const next = JSON.parse(candidate);
    for (const key of Object.keys(counts(0, 0))) assert(next.usage[key] >= previous.usage[key], 'older candidate must not overwrite newer counters');
    return nativeRename(source, destination);
  });
  syncBuiltinESMExports();
  return { writes, attempts, waits };
}

function sender(state) {
  let sent = 0;
  const fetch = transport.budgetedFetch(async () => {
    sent++;
    const saved = state.saved();
    assert.deepEqual(saved.usage, transport.serverUsage, 'authoritative counters are saved before fetch');
    return new Response('{}');
  });
  return { get sent() { return sent; }, send(project = state.project, kind = 'model') {
    const origin = `https://${kind}.invalid`;
    return transport.withHttpBudget(project, kind, origin, () => fetch(`${origin}/request`));
  } };
}

test('budget replacement succeeds once without waiting or duplicate writes/sends', async t => {
  const state = fixture(t);
  const observed = observe(t, state);
  const wire = sender(state);
  await wire.send();
  assert.equal(wire.sent, 1);
  assert.equal(observed.writes.length, 1);
  assert.equal(observed.attempts.length, 1);
  assert.deepEqual(observed.waits, []);
  assert.deepEqual(state.saved().usage, counts(1, 0));
  assert.equal(state.project.usage.modelHttpAttempts, 1);
});

test('Windows EPERM retries the unchanged candidate and publishes one reservation/send', async t => {
  const state = fixture(t);
  const observed = observe(t, state, { fail: attempt => attempt <= 2 });
  const wire = sender(state);
  await wire.send();
  assert.equal(wire.sent, 1);
  assert.equal(observed.writes.length, 1);
  assert.equal(observed.attempts.length, 3);
  assert.equal(new Set(observed.attempts.map(attempt => attempt.candidate)).size, 1);
  assert.deepEqual(observed.waits, [100, 200]);
  assert.deepEqual(transport.serverUsage, counts(1, 0));
  assert.deepEqual(state.saved().usage, counts(1, 0));
  assert.deepEqual(state.saved().registeredProjects[state.project.id].usage, counts(1, 0));
});

test('exhausted Windows EPERM stops without sending or publishing counters', async t => {
  const state = fixture(t);
  const before = state.saved();
  const observed = observe(t, state, { fail: () => true });
  const wire = sender(state);
  await assert.rejects(wire.send(), /budget could not be saved/);
  assert.equal(wire.sent, 0);
  assert.deepEqual(observed.waits, [100, 200, 400, 800]);
  assert.equal(observed.attempts.length, 6, 'five attempts for the reservation and one non-retrying stop-state save');
  assert.equal(new Set(observed.attempts.slice(0, 5).map(attempt => attempt.candidate)).size, 1);
  assert.equal(observed.writes.length, 2, 'retries never rewrite; the separate stop-state save is attempted once');
  assert.deepEqual(transport.serverUsage, before.usage);
  assert.deepEqual(state.saved().usage, before.usage);
  assert.deepEqual(state.budget.summary().registeredProjects[state.project.id].usage, before.registeredProjects[state.project.id].usage);
  assert.equal(state.project.usage.modelHttpAttempts, 0);
  assert.equal(transport.validationRun.liveStopped, true);
  const attempts = observed.attempts.length;
  await assert.rejects(wire.send());
  assert.equal(wire.sent, 0);
  assert.equal(observed.attempts.length, attempts, 'stopped run cannot retry another reservation');
  assert.deepEqual(transport.serverUsage, before.usage);
  assert.equal(state.project.usage.modelHttpAttempts, 0);
  assert.deepEqual(state.saved().usage, before.usage);
});

for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EIO']]) {
  test(`${platform} ${code} is not retried`, async t => {
    const state = fixture(t);
    const observed = observe(t, state, { platform, code, fail: () => true });
    const wire = sender(state);
    await assert.rejects(wire.send(), /budget could not be saved/);
    assert.equal(wire.sent, 0);
    assert.deepEqual(observed.waits, []);
    assert.equal(observed.attempts.length, 2, 'one reservation attempt and one stop-state save, neither retries');
    assert.deepEqual(transport.serverUsage, counts(0, 0));
    assert.deepEqual(state.saved().usage, counts(0, 0));
  });
}

test('project save failure retains an already durable reservation without sending', async t => {
  const state = fixture(t, () => { throw new Error('synthetic project save failure'); });
  const observed = observe(t, state);
  const wire = sender(state);
  await assert.rejects(wire.send(), /budget could not be saved/);
  assert.equal(wire.sent, 0);
  assert.deepEqual(transport.serverUsage, counts(1, 0));
  assert.equal(state.project.usage.modelHttpAttempts, 1);
  assert.deepEqual(state.saved().usage, counts(1, 0));
  assert.equal(state.saved().liveStopped, true);
  assert.deepEqual(observed.waits, []);
});

test('concurrent callers preserve shared limits and cannot overwrite a newer ledger', async t => {
  const state = fixture(t);
  const projects = [state.project, ...Array.from({ length: 39 }, freshProject)];
  for (const project of projects.slice(1)) state.budget.bind(project, true);
  const observed = observe(t, state, { fail: attempt => attempt === 1 });
  const wire = sender(state);
  for (const [kind, limit] of [['model', 30], ['qloo', 20]]) {
    const results = await Promise.allSettled(projects.map(project => wire.send(project, kind)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, limit);
    assert.equal(projects.reduce((sum, project) => sum + project.usage[`${kind}HttpAttempts`], 0), limit);
  }
  assert.equal(wire.sent, 50);
  assert.deepEqual(transport.serverUsage, counts(30, 20));
  assert.deepEqual(state.saved().usage, counts(30, 20));
  assert.equal(observed.writes.length, 50);
  assert.equal(observed.attempts.length, 51);
  assert.deepEqual(observed.waits, [100]);
});

test('a request awaiting its body cannot reserve or send after another request stops the run', async t => {
  const state = fixture(t);
  const blocker = freshProject();
  state.budget.bind(blocker, true);
  state.project.runtime.generationBudget = { finalMaxTokens: 7 };
  const observed = observe(t, state, { fail: attempt => attempt <= 6 });
  const wire = sender(state);
  let releaseBody, markBodyStarted, sent = 0;
  const gate = new Promise(resolve => { releaseBody = resolve; });
  const bodyStarted = new Promise(resolve => { markBodyStarted = resolve; });
  t.after(() => releaseBody());
  const request = new Request('https://model.invalid/request', { method: 'POST', body: JSON.stringify({ max_tokens: 7 }) });
  t.mock.method(request, 'clone', () => ({ async text() {
    markBodyStarted();
    await gate;
    return JSON.stringify({ max_tokens: 7 });
  } }));
  const fetch = transport.budgetedFetch(async () => { sent++; return new Response('{}'); });
  const pending = transport.withHttpBudget(state.project, 'model', 'https://model.invalid', () => fetch(request));
  await bodyStarted;
  await assert.rejects(wire.send(blocker), /budget could not be saved/);
  assert.equal(transport.validationRun.liveStopped, true);
  assert.equal(observed.attempts.length, 6);
  releaseBody();
  await assert.rejects(pending);
  assert.equal(state.project.runtime.localFailure.code, 'VALIDATION_RUN_STOPPED');
  assert.equal(sent, 0);
  assert.equal(wire.sent, 0);
  assert.equal(observed.attempts.length, 6, 'resumed request cannot try a new reservation after the stop');
  assert.deepEqual(transport.serverUsage, counts(0, 0));
  assert.equal(state.project.usage.modelHttpAttempts, 0);
  assert.equal(blocker.usage.modelHttpAttempts, 0);
  assert.deepEqual(state.saved().usage, counts(0, 0));
});
