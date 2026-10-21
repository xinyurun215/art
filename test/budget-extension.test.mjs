import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from '../app/state.mjs';
import * as transport from '../app/transport.mjs';

const counts = (modelHttpAttempts, qlooHttpAttempts) => ({ modelHttpAttempts, qlooHttpAttempts });
const oldLimits = counts(30, 20);
const newLimits = counts(40, 20);
const usage = counts(30, 12);
const reason = 'Synthetic explicit offline authorization: model 30 to 40, Qloo unchanged';
const root = resolve(fileURLToPath(new URL('../validation/budget-extension-tests/', import.meta.url)));
const nativeWrite = fs.writeFileSync;
const nativeRename = fs.renameSync;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function fixture(t) {
  fs.mkdirSync(root, { recursive: true });
  const dataDir = fs.mkdtempSync(join(root, 'case-'));
  assert(resolve(dataDir).startsWith(root + sep), 'cleanup is confined to this new test directory');
  const project = createProject({ mode: 'live', brief: { request: 'Synthetic offline budget extension' } });
  Object.assign(project.usage, usage);
  const directory = join(dataDir, '.http-budget');
  fs.mkdirSync(directory);
  const path = join(directory, 'run.json');
  const ledger = {
    schemaVersion: 1, limits: { ...oldLimits }, sharedLimits: { ...oldLimits }, usage: { ...usage },
    registeredProjects: { [project.id]: { limits: { ...oldLimits }, usage: { ...usage }, marker: 'retain entry metadata' } },
    queryStopped: true, liveStopped: true,
    failure: { kind: 'model', code: 'MODEL_HTTP_BUDGET_EXHAUSTED', summary: 'Synthetic retained failure' },
    marker: { retain: 'unrelated ledger metadata' },
  };
  const write = value => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  write(ledger);
  const projectPath = join(dataDir, `${project.id}.json`);
  fs.writeFileSync(projectPath, JSON.stringify({ schemaVersion: 1, project }));
  const original = fs.readFileSync(path);
  let budget;
  Object.assign(transport.serverUsage, counts(0, 0));
  Object.assign(transport.validationRun, { queryStopped: false, liveStopped: false });
  transport.validationRun.attempts.length = 0;
  delete transport.validationRun.failure;
  const network = t.mock.method(globalThis, 'fetch', () => assert.fail('offline extension tests must not send HTTP'));
  t.after(() => {
    assert.equal(network.mock.callCount(), 0);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platformDescriptor);
    budget?.release();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { project, projectPath, dataDir, path, lock: join(directory, 'active.lock'), ledger, original, write,
    read: () => JSON.parse(fs.readFileSync(path, 'utf8')),
    extend(overrides = {}) { return transport.extendHttpBudget({ dataDir, projectId: project.id,
      expectedLimits: { ...oldLimits }, expectedUsage: { ...usage }, newLimits: { ...newLimits }, reason, ...overrides }); },
    restart(limits) { budget = transport.createHttpBudget({ dataDir, env: {
      ART_MODEL_HTTP_LIMIT: String(limits.modelHttpAttempts), ART_QLOO_HTTP_LIMIT: String(limits.qlooHttpAttempts) } });
      budget.bind(project); return budget; },
  };
}

function unchanged(state, bytes = state.original) {
  assert.deepEqual(fs.readFileSync(state.path), bytes, 'rejected extension preserves original ledger bytes');
}

test('explicit offline extension changes only limits and appends a durable original-byte audit', t => {
  const state = fixture(t);
  const { ledgerPath, backupPath, ...audit } = state.extend();
  const saved = state.read();
  assert.equal(ledgerPath, state.path);
  assert.equal(backupPath, join(state.dataDir, '.http-budget', `run.before-extension-${createHash('sha256').update(state.original).digest('hex')}.json`));
  assert.deepEqual(fs.readFileSync(backupPath), state.original, 'backup preserves exact original bytes');
  assert.deepEqual(audit.oldLimits, oldLimits);
  assert.deepEqual(audit.newLimits, newLimits);
  assert.equal(audit.projectId, state.project.id);
  assert.equal(audit.reason, reason);
  assert(Number.isFinite(Date.parse(audit.at)));
  assert.equal(audit.originalSha256, createHash('sha256').update(state.original).digest('hex'));
  assert.deepEqual(saved.limits, newLimits);
  assert.deepEqual(saved.sharedLimits, newLimits);
  assert.deepEqual(saved.registeredProjects[state.project.id].limits, newLimits);
  assert.deepEqual(saved.limitExtensions, [audit]);
  const expected = structuredClone(state.ledger);
  expected.limits = { ...newLimits };
  expected.sharedLimits = { ...newLimits };
  expected.registeredProjects[state.project.id].limits = { ...newLimits };
  expected.limitExtensions = [audit];
  assert.deepEqual(saved, expected, 'usage, stop flags, failure and unrelated metadata are preserved');
  assert.equal(fs.existsSync(state.lock), false);
  assert.deepEqual(transport.serverUsage, counts(0, 0), 'offline editing does not reserve HTTP attempts');
});

test('ordinary restart cannot silently raise 30 to 31; explicit extension restarts at 40/20 without resetting usage', t => {
  const state = fixture(t);
  assert.throws(() => state.restart(counts(31, 20)), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
  unchanged(state);
  assert.equal(fs.existsSync(state.lock), false);
  const { ledgerPath, backupPath, ...audit } = state.extend();
  const budget = state.restart(newLimits);
  assert.deepEqual(budget.limits, newLimits);
  assert.deepEqual(budget.summary().usage, usage);
  assert.deepEqual(state.project.usage.modelHttpAttempts, 30);
  assert.deepEqual(state.project.usage.qlooHttpAttempts, 12);
  assert.deepEqual(transport.serverUsage, usage);
  assert.equal(transport.validationRun.queryStopped, true);
  assert.equal(transport.validationRun.liveStopped, true);
  assert.deepEqual(transport.validationRun.failure, state.ledger.failure);
  assert.deepEqual(state.read().limitExtensions, [audit], 'startup and bind retain extension audit');
  assert.equal(transport.remainingBudget(state.project).modelHttpAttempts, 10);
});

test('stale expected limits or usage and inconsistent shared/registered values are rejected without writes', t => {
  const state = fixture(t);
  for (const mutate of [
    ledger => { ledger.limits.modelHttpAttempts = 31; },
    ledger => { ledger.sharedLimits.modelHttpAttempts = 31; },
    ledger => { ledger.registeredProjects[state.project.id].limits.modelHttpAttempts = 31; },
    ledger => { ledger.usage.modelHttpAttempts = 29; },
    ledger => { ledger.registeredProjects[state.project.id].usage.modelHttpAttempts = 29; },
    ledger => { ledger.usage.qlooHttpAttempts = 13; },
    ledger => { ledger.registeredProjects[state.project.id].usage.qlooHttpAttempts = 13; },
  ]) {
    const ledger = structuredClone(state.ledger);
    mutate(ledger);
    state.write(ledger);
    const before = fs.readFileSync(state.path);
    assert.throws(() => state.extend(), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
    unchanged(state, before);
    assert.equal(fs.existsSync(state.lock), false);
  }
  state.write(state.ledger);
  for (const overrides of [{ expectedLimits: counts(29, 20) }, { expectedUsage: counts(29, 12) }]) {
    const before = fs.readFileSync(state.path);
    assert.throws(() => state.extend(overrides), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
    unchanged(state, before);
  }
});

test('extension rejects lowering below used, no increase, changed Qloo and invalid counts', t => {
  const state = fixture(t);
  for (const next of [counts(29, 20), counts(30, 20), counts(40, 19), counts(40, 21),
    counts(40.5, 20), counts(Number.MAX_SAFE_INTEGER + 1, 20)]) {
    assert.throws(() => state.extend({ newLimits: next }), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
    unchanged(state);
    assert.equal(fs.existsSync(state.lock), false);
  }
  assert.throws(() => state.extend({ reason: '   ' }), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
  unchanged(state);
});

test('extension requires the exact sole registered project and refuses an active server lock', t => {
  const state = fixture(t);
  assert.throws(() => state.extend({ projectId: randomUUID() }), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
  unchanged(state);
  const multiple = structuredClone(state.ledger);
  multiple.registeredProjects[randomUUID()] = { limits: { ...oldLimits }, usage: counts(0, 0) };
  state.write(multiple);
  const before = fs.readFileSync(state.path);
  assert.throws(() => state.extend(), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
  unchanged(state, before);
  state.write(state.ledger);
  fs.writeFileSync(state.lock, 'synthetic active service', { flag: 'wx' });
  assert.throws(() => state.extend(), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
  assert.equal(fs.readFileSync(state.lock, 'utf8'), 'synthetic active service', 'existing lock is not removed');
  assert.deepEqual(state.read(), state.ledger);
});

test('extension requires an absolute data directory and matching saved project identity and usage', t => {
  const state = fixture(t);
  assert.throws(() => state.extend({ dataDir: '.' }), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
  unchanged(state);
  for (const project of [
    { ...state.project, id: randomUUID() },
    { ...state.project, usage: { ...state.project.usage, modelHttpAttempts: 29 } },
    { ...state.project, usage: { ...state.project.usage, qlooHttpAttempts: 13 } },
  ]) {
    fs.writeFileSync(state.projectPath, JSON.stringify({ schemaVersion: 1, project }));
    assert.throws(() => state.extend(), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
    unchanged(state);
    assert.equal(fs.existsSync(state.lock), false);
  }
});

test('extension never overwrites an existing original-byte backup', t => {
  const state = fixture(t);
  const sha = createHash('sha256').update(state.original).digest('hex');
  const backupPath = join(state.dataDir, '.http-budget', `run.before-extension-${sha}.json`);
  fs.writeFileSync(backupPath, 'synthetic existing backup', { flag: 'wx' });
  assert.throws(() => state.extend(), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
  unchanged(state);
  assert.equal(fs.readFileSync(backupPath, 'utf8'), 'synthetic existing backup');
  assert.equal(fs.existsSync(state.lock), false);
});

test('extension refuses an externally changed ledger after backup without overwriting it or appending an audit', t => {
  const state = fixture(t);
  const external = { ...state.ledger, externalMarker: 'synthetic concurrent offline writer' };
  const externalBytes = Buffer.from(JSON.stringify(external) + '\n');
  let injected = false;
  t.mock.method(fs, 'writeFileSync', (path, value, ...options) => {
    const result = nativeWrite(path, value, ...options);
    if (typeof path === 'string' && path.startsWith(join(state.dataDir, '.http-budget', 'run.before-extension-'))) {
      injected = true;
      nativeWrite(state.path, externalBytes);
    }
    return result;
  });
  syncBuiltinESMExports();
  assert.throws(() => state.extend(), { code: 'HTTP_BUDGET_CONFIG_INVALID' });
  assert.equal(injected, true, 'external change occurs after original-byte backup has been written');
  unchanged(state, externalBytes);
  assert.deepEqual(state.read(), external);
  assert.equal(state.read().limitExtensions, undefined, 'rejected extension appends no audit');
  assert.equal(fs.existsSync(state.lock), false);
});

for (const operation of ['writeFileSync', 'renameSync']) {
  test(`extension ${operation} failure leaves original limits, counters and audit unchanged`, t => {
    const state = fixture(t);
    const native = operation === 'writeFileSync' ? nativeWrite : nativeRename;
    t.mock.method(fs, operation, (...args) => {
      if (operation === 'writeFileSync' ? args[0] === `${state.path}.tmp` : args[1] === state.path)
        throw Object.assign(new Error('synthetic atomic persistence failure'), { code: 'EIO' });
      return native(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => state.extend(), { code: 'EIO' });
    unchanged(state);
    assert.equal(fs.existsSync(state.lock), false);
  });
}

test('extension retries Windows EPERM with the same candidate and appends only one audit', t => {
  const state = fixture(t);
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  const attempts = [], waits = [], writes = [];
  t.mock.method(Atomics, 'wait', (_array, _index, _value, milliseconds) => { waits.push(milliseconds); return 'timed-out'; });
  t.mock.method(fs, 'writeFileSync', (path, value, ...options) => {
    if (path === `${state.path}.tmp`) writes.push(String(value));
    return nativeWrite(path, value, ...options);
  });
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination !== state.path) return nativeRename(source, destination);
    attempts.push({ source, destination, candidate: fs.readFileSync(source, 'utf8') });
    if (attempts.length <= 2) throw Object.assign(new Error('synthetic recoverable EPERM'), { code: 'EPERM' });
    return nativeRename(source, destination);
  });
  syncBuiltinESMExports();
  const { ledgerPath, backupPath, ...audit } = state.extend();
  assert.equal(writes.length, 1);
  assert.equal(attempts.length, 3);
  assert.deepEqual(waits, [100, 200]);
  assert(attempts.every(attempt => attempt.source === `${state.path}.tmp` && attempt.destination === state.path));
  assert.equal(new Set(attempts.map(attempt => attempt.candidate)).size, 1);
  assert.deepEqual(state.read().limitExtensions, [audit]);
  assert.deepEqual(state.read().usage, usage);
});

test('extension exhausts four Windows EPERM waits without publishing new limits or audit', t => {
  const state = fixture(t);
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  const waits = [];
  let attempts = 0;
  t.mock.method(Atomics, 'wait', (_array, _index, _value, milliseconds) => { waits.push(milliseconds); return 'timed-out'; });
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination !== state.path) return nativeRename(source, destination);
    attempts++;
    assert.equal(source, `${state.path}.tmp`);
    throw Object.assign(new Error('synthetic persistent EPERM'), { code: 'EPERM' });
  });
  syncBuiltinESMExports();
  assert.throws(() => state.extend(), { code: 'EPERM' });
  assert.equal(attempts, 5);
  assert.deepEqual(waits, [100, 200, 400, 800]);
  unchanged(state);
  assert.equal(fs.existsSync(state.lock), false);
});
