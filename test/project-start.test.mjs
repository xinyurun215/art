import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppServer } from '../app/server.mjs';
import { createPostgresStore } from '../app/store.mjs';

const brief = { request: 'Synthetic identity and start recovery', venue: 'Synthetic room' };
const key = () => randomBytes(32).toString('hex');
const input = () => ({ creationKey: key(), mode: 'offline', brief });
const env = { VERCEL_ENV: 'production', ART_PREVIEW_ACCESS_KEY: 'synthetic-access-key' };

function memoryStore() {
  const records = new Map();
  return { records, limits: { modelHttpAttempts: 6, qlooHttpAttempts: 6 }, sharedLimits: { modelHttpAttempts: null, qlooHttpAttempts: null },
    async get(id) { return structuredClone(records.get(id)); },
    async save(project, { create = false, start = false, initial = false } = {}) {
      const old = records.get(project.id);
      if (create && old) {
        if (old.creation?.fingerprint !== project.creation?.fingerprint || old.guestOwner !== project.guestOwner)
          throw Object.assign(new Error('creation conflict'), { statusCode: 409, code: 'PROJECT_CREATION_CONFLICT' });
        return structuredClone(old);
      }
      if (initial && old.status.phase !== 'created') return { project: structuredClone(old), alreadyStarted: true };
      const saved = structuredClone(project); saved.storageVersion = (saved.storageVersion ?? 0) + 1;
      if (start) (saved.runtime.runs ??= []).push({ id: key(), status: 'running' });
      records.set(saved.id, saved);
      return start ? { project: structuredClone(saved), token: saved.runtime.runs.at(-1).id, usage: {} } : structuredClone(saved);
    } };
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'art-project-start-'));
  const app = createAppServer({ env: {}, dataDir, ...options });
  t.after(async () => { await app.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (method, path, payload, headers = {}) => {
    const result = { headers: {} };
    await app.handler({ method, url: path, body: payload, headers: { host: 'art-lovat-two.vercel.app',
      'content-type': 'application/json', ...headers } }, {
      setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
      writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); }
    });
    return result;
  };
  return { app, call, dataDir };
}

test('creation saves one recoverable identity and zero generation; concurrent same key recovers and changed input conflicts', async t => {
  let generations = 0;
  const f = await fixture(t, { runtimeOptions: { decide() { generations++; return [{ type: 'text', text: 'Synthetic stop' }]; } } });
  const payload = input();
  const first = await f.call('POST', '/api/projects', payload);
  assert.equal(first.status, 201); assert.equal(first.body.project.status.phase, 'created');
  assert.equal(generations, 0, 'saving identity must not start the runtime');
  const repeats = await Promise.all(Array.from({ length: 4 }, () => f.call('POST', '/api/projects', payload)));
  assert(repeats.every(value => value.body.project.id === first.body.project.id));
  assert.equal(f.app.projects.size, 1);
  const before = await f.call('GET', `/api/projects/${first.body.project.id}`);
  assert.equal((await f.call('POST', '/api/projects', { ...payload, brief: { request: 'Different brief' } })).status, 409);
  assert.deepEqual((await f.call('GET', `/api/projects/${first.body.project.id}`)).body, before.body);
  assert.equal((await f.call('POST', '/api/projects', { mode: 'offline', brief })).status, 400);
  assert.equal(generations, 0);
});

test('guest creation response and cookie may both be lost; same key safely restores across instances without exposing private metadata', async t => {
  const liveInput = () => ({ ...input(), mode: 'live' });
  const store = memoryStore(), options = { env, store, functionMode: true };
  const first = await fixture(t, options), second = await fixture(t, options), payload = liveInput();
  const created = await first.call('POST', '/api/projects', { ...payload, guestOwner: 'forged-owner' });
  assert.equal(created.status, 201);
  const restored = await second.call('POST', '/api/projects', payload);
  assert.equal(restored.status, 201); assert.equal(restored.body.project.id, created.body.project.id);
  assert.equal(restored.headers['set-cookie'], created.headers['set-cookie']);
  assert.equal(store.records.size, 1);
  const cookie = restored.headers['set-cookie'].split(';')[0];
  const id = restored.body.project.id, stored = await store.get(id);
  for (const text of [payload.creationKey, stored.creation.fingerprint, stored.guestOwner])
    assert.equal(JSON.stringify(restored.body).includes(text), false);
  assert.equal(restored.body.project.creation, undefined);
  assert.equal((await second.call('GET', `/api/projects/${id}`, undefined, { cookie })).status, 200);
  assert.equal((await second.call('GET', `/api/projects/${id}`)).status, 404);
  const sameGuest = await second.call('POST', '/api/projects', liveInput(), { cookie });
  assert.equal(sameGuest.status, 201); assert.notEqual(sameGuest.body.project.id, id);
  assert.equal(sameGuest.headers['set-cookie'], undefined);
  assert.equal((await store.get(sameGuest.body.project.id)).guestOwner, stored.guestOwner);
  for (const projectId of [id, sameGuest.body.project.id])
    assert.equal((await second.call('GET', `/api/projects/${projectId}`, undefined, { cookie })).status, 200);
  const other = await second.call('POST', '/api/projects', liveInput());
  const otherCookie = other.headers['set-cookie'].split(';')[0];
  const denied = await second.call('POST', '/api/projects', { ...payload, guestOwner: stored.guestOwner }, { cookie: otherCookie });
  assert.equal(denied.status, 409); assert.equal(denied.headers['set-cookie'], undefined);
  assert.equal((await second.call('GET', `/api/projects/${id}`, undefined, { cookie: otherCookie })).status, 404);
  const fresh = liveInput();
  const [a, b] = await Promise.all([first.call('POST', '/api/projects', fresh), second.call('POST', '/api/projects', fresh)]);
  assert.equal(a.body.project.id, b.body.project.id); assert.equal(store.records.size, 4);
});

test('start is explicit and executes once; repeated start and reread keep the saved result and lease history', async t => {
  const store = memoryStore(); let generations = 0;
  const f = await fixture(t, { store, runtimeFactory: async project => ({ async submit() {
    generations++; project.status = { phase: 'insufficient_evidence', detail: 'Synthetic completion' };
  }, async dispose() {} }) });
  const created = await f.call('POST', '/api/projects', input()), id = created.body.project.id;
  assert.equal(generations, 0);
  assert.equal((await f.call('POST', `/api/projects/${id}/messages`, { text: 'Bypass explicit start' })).status, 409);
  const result = await f.call('POST', `/api/projects/${id}/start`, {});
  assert.equal(result.status, 200); assert.equal(generations, 1);
  const saved = await store.get(id);
  assert.equal(saved.runtime.runs.length, 1);
  const repeat = await f.call('POST', `/api/projects/${id}/start`, {});
  assert.deepEqual(repeat.body, result.body);
  assert.deepEqual(await store.get(id), saved, 'duplicate start must not increment storage version or add a lease');
  assert.deepEqual((await f.call('GET', `/api/projects/${id}`)).body, result.body);
  assert.equal(generations, 1);
});

test('two simultaneous initial starts return current state and claim only one execution', async t => {
  let entered, release, generations = 0;
  const started = new Promise(done => { entered = done; }), gate = new Promise(done => { release = done; });
  t.after(() => release());
  const store = memoryStore(), f = await fixture(t, { store, runtimeFactory: async project => ({ async submit() {
    generations++; entered(); await gate; project.status = { phase: 'insufficient_evidence', detail: 'Synthetic completion' };
  }, async dispose() {} }) });
  const id = (await f.call('POST', '/api/projects', input())).body.project.id;
  const calls = [f.call('POST', `/api/projects/${id}/start`, {}), f.call('POST', `/api/projects/${id}/start`, {})];
  await started;
  const early = await Promise.race(calls);
  assert.equal(early.status, 200);
  assert.equal(early.body.project.status.phase, 'busy');
  release(); await Promise.all(calls);
  assert.equal(generations, 1); assert.equal((await store.get(id)).runtime.runs.length, 1);
});

test('creation failures before saving or after an uncertain commit recover with the same key and no generation', async t => {
  for (const timing of ['before', 'after']) {
    const store = memoryStore(), save = store.save;
    let failed = false, generations = 0;
    store.save = async (project, options) => {
      if (options.create && !failed) {
        failed = true;
        if (timing === 'after') await save(project, options);
        throw Object.assign(new Error('Synthetic uncertain save'), { statusCode: 503, code: 'PROJECT_STORE_UNAVAILABLE' });
      }
      return save(project, options);
    };
    const f = await fixture(t, { store, runtimeFactory: async () => { generations++; assert.fail('creation may not generate'); } });
    const payload = input();
    assert.equal((await f.call('POST', '/api/projects', payload)).status, 503);
    const recovered = await f.call('POST', '/api/projects', payload);
    const repeated = await f.call('POST', '/api/projects', payload);
    assert.equal(recovered.status, 201); assert.equal(recovered.body.project.id, repeated.body.project.id);
    assert.equal(store.records.size, 1); assert.equal(generations, 0);
  }
});

test('interrupted initial generation restores the same project and never restarts through start', async t => {
  let generations = 0, rejectSubmit;
  const store = memoryStore(), f = await fixture(t, { store, maxRunMs: 30, runtimeFactory: async () => ({
    submit() { generations++; return new Promise((_, reject) => { rejectSubmit = reject; }); },
    async abort() { rejectSubmit(new Error('Synthetic abort')); }, async dispose() {} }) });
  const payload = input(), created = await f.call('POST', '/api/projects', payload), id = created.body.project.id;
  const interrupted = await f.call('POST', `/api/projects/${id}/start`, {});
  assert.equal(interrupted.status, 200, 'the explicit start route must exist');
  assert.equal(interrupted.body.project.status.phase, 'interrupted');
  const recoveredIdentity = await f.call('POST', '/api/projects', payload);
  assert.equal(recoveredIdentity.body.project.id, id);
  assert.equal(recoveredIdentity.body.project.status.phase, 'interrupted');
  await f.call('POST', `/api/projects/${id}/start`, {});
  assert.equal(generations, 1);
});

test('SQL create deduplication and initial-start guard use the locked stored row, without a candidate write', async () => {
  const stored = { id: 'existing', storageVersion: 4, creation: { fingerprint: 'same' }, guestOwner: 'owner',
    status: { phase: 'interrupted' }, runtime: { runs: [{ status: 'interrupted' }] } };
  const statements = [];
  const store = createPostgresStore({ pool: { async connect() { return { release() {}, async query(sql) {
    statements.push(sql);
    if (sql.startsWith('SELECT * FROM art_budget_runs')) return { rows: [{ limits: store.limits, shared_limits: store.sharedLimits }] };
    if (sql.startsWith('SELECT * FROM art_projects')) return { rows: [{ run_id: 'protected-preview-v1', revision: 4, state: structuredClone(stored) }] };
    return { rows: [] };
  } }; } } });
  assert.deepEqual(await store.save({ ...stored, storageVersion: undefined }, { create: true }), stored);
  const candidate = { ...stored, status: { phase: 'busy' } };
  assert.deepEqual(await store.save(candidate, { start: true, initial: true }), { project: stored, alreadyStarted: true });
  await assert.rejects(() => store.save({ ...stored, creation: { fingerprint: 'different' } }, { create: true }), { code: 'PROJECT_CREATION_CONFLICT' });
  assert(statements.some(sql => sql.includes('art_projects') && sql.includes('FOR UPDATE')));
  assert.equal(statements.some(sql => sql.startsWith('UPDATE art_projects') || sql.startsWith('INSERT INTO art_projects')), false);
});
