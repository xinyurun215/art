import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createAppServer } from '../app/server.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const config = { production: true, modes: { live: { enabled: true, available: true } } };
const recorded = { id: 'case-rill-daypack-20261024', version: 3, mode: 'live', brief: { request: 'Fictional Rill daypack brief' },
  status: { phase: 'ready' }, concepts: [], evidence: [], revisions: [],
  provenance: { kind: 'completed_case', recordedAt: '2026-10-24', acceptedAt: '2026-10-24T03:29:25.019Z',
    description: 'Recorded read-only Rill case. Fictional brief with fresh real Qloo data; design effects are unverified.' } };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(done => setImmediate(done)); };

test('the completed case is a separate read-only snapshot: no private store, runtime or provider is used', async t => {
  let privateReads = 0, writes = 0, runs = 0;
  const store = { limits: {}, sharedLimits: {}, get() { privateReads++; assert.fail('case must not read private projects'); },
    save() { writes++; assert.fail('case must not be saved as a visitor project'); } };
  const app = createAppServer({ env: { NODE_ENV: 'production' }, store, runtimeFactory: async () => { runs++; assert.fail('case cannot generate'); } });
  t.after(() => app.dispose());
  const call = async (method, url) => {
    const result = {};
    await app.handler({ method, url, body: {}, headers: {} }, {
      writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); }
    });
    return result;
  };
  const result = await call('GET', '/api/cases/completed');
  assert.equal(result.status, 200);
  const value = result.body.project;
  assert.equal(value.provenance.kind, 'completed_case'); assert.equal(value.provenance.recordedAt, '2026-10-24');
  assert.equal(value.provenance.acceptedAt, '2026-10-24T03:29:25.019Z'); assert.match(value.provenance.description, /fictional/i);
  assert.equal(value.concepts.length, 2); assert.equal(value.evidence.length, 2);
  const accepted = value.revisions.find(revision => revision.status === 'accepted');
  assert.equal(accepted.revisionNumber, 2);
  assert.deepEqual(accepted.changes.map(change => change.field), ['coreClaim', 'mechanism', 'journey', 'productTouchpoints', 'openQuestions', 'unverifiedEffects']);
  assert.equal(value.evidence.reduce((count, card) => count + card.returnedEntities.length, 0), 20);
  const selected = value.concepts.find(concept => concept.id === value.selectedConceptId);
  assert.equal(selected.title, 'Fit Bench: one-to-one measured try-on'); assert.deepEqual(value.lockedFields, ['title']);
  for (const change of accepted.changes) assert.deepEqual(change.after, selected[change.field]);
  assert.match(JSON.stringify(accepted.changes.find(change => change.field === 'mechanism').before), /30.minute/i);
  assert.match(selected.mechanism.description, /15.minute maximum/); assert.match(selected.mechanism.description, /no strap is touched while the visitor is walking/i);
  assert.match(selected.journey.at(-1).stage, /14–15/);
  const geo = value.evidence.map(card => card.context.geographicFilter);
  assert(geo.includes('London, United Kingdom')); assert(geo.some(filter => /^Not applied/.test(filter)));
  for (const concept of value.concepts) for (const link of concept.evidenceLinks) {
    const card = value.evidence.find(card => card.id === link.evidenceId);
    assert.equal(card.projectId, value.id); assert.equal(card.synthetic, false);
    const entity = card.returnedEntities.find(entity => entity.entity_id === link.entityId);
    assert.deepEqual(link.observedField.split('.').reduce((part, key) => part[key], entity), link.observedValue);
  }
  for (const route of ['/api/cases/completed', ...['start', 'messages', 'select', 'locks', 'revisions', 'revisions/old/accept', 'revisions/old/reject', 'revisions/old/feedback']
    .map(suffix => `/api/projects/${value.id}/${suffix}`)]) {
    const denied = await call('POST', route);
    assert.equal(denied.status, 409); assert.equal(denied.body.code, 'CASE_READ_ONLY');
  }
  const forbidden = new Set(['rawResult', 'runtime', 'usage', 'messages', 'guestOwner', 'creation', 'sourceRecordPath', 'sourceRecordSha256',
    'sourceEvidenceId', 'sessionId', 'sessionFile', 'cookie', 'token', 'api_key']);
  const inspect = node => { if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) {
    assert(!forbidden.has(key), `Private source field: ${key}`); inspect(child);
  } };
  inspect(value); assert.doesNotMatch(JSON.stringify(value), /D:\/art|\.art-runtime|[0-9a-f]{64}/i);
  for (const item of [value, ...value.concepts, ...value.evidence, ...value.revisions]) assert.match(item.id, /^case-/);
  assert.equal(privateReads, 0); assert.equal(writes, 0); assert.equal(runs, 0); assert.equal(app.projects.size, 0);
});

function page(url, storage = new Map(), send = async () => assert.fail('Unexpected request')) {
  const elements = new Map(), calls = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', dataset: {}, handlers: {}, firstElementChild: {},
      classList: { add() {} }, addEventListener(name, callback) { this.handlers[name] = callback; }, setAttribute() {}, removeAttribute() {}, focus() {},
      replaceChildren() { this.textContent = ''; }, append(child) { this.textContent += child.textContent ?? ''; }, querySelector() { return get(`${id}-option`); } });
    return elements.get(id);
  };
  get('mode').value = 'live'; const location = { href: url };
  const context = { URL, crypto: webcrypto, history: { replaceState(_s, _t, next) { location.href = String(next); } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    window: { location, setTimeout() {} }, document: { getElementById: get, createElement: () => ({ addEventListener() {} }),
      body: { classList: { add() {} }, setAttribute() {} }, querySelectorAll: () => [] },
    async fetch(path, options = {}) { if (path === '/api/config') return new Response(JSON.stringify(config)); calls.push({ path, options }); return send(path, options); } };
  runInNewContext(source.replace("  $('load-demo').addEventListener", "  globalThis.ui = { state, projectAction, proposalMarkdown };\n  $('load-demo').addEventListener"), context);
  return { get, calls, location, ...context.ui };
}

test('explicit case viewing never restores or overwrites a private project; all action handlers remain read only', async () => {
  const pending = JSON.stringify({ creationKey: 'private-pending-key', brief: { request: 'Private draft' } });
  const storage = new Map([['art-current-project', 'private-current'], ['art-pending-creation', pending]]), before = [...storage];
  const view = page('https://art.invalid/?case=completed', storage, async path => {
    assert.equal(path, '/api/cases/completed'); return new Response(JSON.stringify({ project: recorded }));
  });
  await flush(); assert.equal(view.calls.length, 1); assert.equal(view.calls[0].path, '/api/cases/completed');
  assert.equal(view.state.project.id, recorded.id);
  assert.deepEqual([...storage], before); assert.equal(view.location.href, 'https://art.invalid/?case=completed');
  for (const path of ['/start', '/messages', '/select', '/locks', '/revisions', '/revisions/old/accept']) await view.projectAction(path, {}, 'Cannot write');
  assert.equal(view.calls.length, 1); assert.deepEqual([...storage], before);
  assert.match(view.get('case-provenance').innerHTML, /2026-10-24/); assert.match(view.get('case-provenance').innerHTML, /fictional/i);
  const exported = view.proposalMarkdown(recorded);
  assert.match(exported, /Recorded completed case/); assert.match(exported, /2026-10-24/); assert.match(exported, /read.only/i);
  assert(!exported.includes('private-current')); assert(!exported.includes('private-pending-key'));
});

test('new entry ignores saved identity without deleting it, normal restore still works, and failures never load a case', async () => {
  const storage = new Map([['art-current-project', 'own-project']]);
  const fresh = page('https://art.invalid/?new=1', storage);
  await flush(); assert.equal(fresh.calls.length, 0); assert.equal(storage.get('art-current-project'), 'own-project');
  const own = { ...recorded, id: 'own-project', provenance: undefined };
  const restored = page('https://art.invalid/', storage, async path => {
    assert.equal(path, '/api/projects/own-project'); return new Response(JSON.stringify({ project: own }));
  });
  await flush(); assert.equal(restored.state.project.id, 'own-project'); assert.equal(restored.calls.length, 1);
  const failed = page('https://art.invalid/', new Map(), async path => {
    assert.equal(path, '/api/projects'); throw new Error('Synthetic provider failure');
  });
  await flush(); failed.get('request').value = 'A new real brief';
  await failed.get('brief-form').handlers.submit({ preventDefault() {} });
  assert.equal(failed.calls.length, 1); assert.equal(failed.state.project, null);
  assert.match(failed.get('connection-error').textContent, /not confirmed|failure/i);
});
