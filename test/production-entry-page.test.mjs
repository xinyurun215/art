import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(done => setImmediate(done)); };
function page(config, storage = new Map(), send = () => assert.fail('No project request is expected')) {
  const elements = new Map(), calls = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: true, innerHTML: '', textContent: '', dataset: {}, handlers: {}, firstElementChild: {},
      classList: { add() {} }, addEventListener(name, callback) { this.handlers[name] = callback; }, setAttribute() {}, removeAttribute() {}, focus() {},
      replaceChildren() { this.textContent = ''; }, append(child) { this.textContent += child.textContent ?? ''; }, querySelector() { return get(`${id}-option`); } });
    return elements.get(id);
  };
  get('mode').value = 'offline'; get('request').value = 'Actual user input';
  const development = ['development-demo-controls', 'development-mode-controls'].map(get);
  const location = { href: 'https://art.invalid/' };
  const context = { URL, crypto: webcrypto, history: { replaceState(_s, _t, url) { location.href = String(url); } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    window: { location, setTimeout() {} },
    document: { getElementById: get, createElement: () => ({ addEventListener() {} }), body: { classList: { add() {} }, setAttribute() {} },
      querySelectorAll(selector) { return selector === '[data-development-control]' ? development : []; } },
    async fetch(path, options = {}) {
      if (path === '/api/config') {
        if (config instanceof Error) throw config;
        return new Response(JSON.stringify(config));
      }
      calls.push({ path, options }); return send(path, options);
    } };
  runInNewContext(source, context);
  return { get, calls, development, storage, async submit() { await get('brief-form').handlers.submit({ preventDefault() {} }); } };
}
const settings = (production, available = true) => ({ production, modes: { live: { enabled: available, available, missing: [] } } });

test('production always selects live, keeps development controls hidden and cannot execute demo handlers', async () => {
  for (const available of [true, false]) {
    const screen = page(settings(true, available)); await flush();
    assert.equal(screen.get('mode').value, 'live'); assert(screen.development.every(item => item.hidden));
    const before = screen.get('request').value;
    screen.get('load-demo').handlers.click(); screen.get('load-ambiguous').handlers.click();
    assert.equal(screen.get('request').value, before); assert.equal(screen.get('mode').value, 'live');
    assert.equal(screen.get('create-project').disabled, !available);
    if (!available) assert.match(screen.get('connection-error').textContent, /unavailable|disabled|configuration/i);
  }
  const failed = page(new Error('Synthetic config unavailable')); await flush();
  assert.equal(failed.get('mode').value, 'live'); assert.equal(failed.get('create-project').disabled, true);
  assert(failed.development.every(item => item.hidden)); assert.equal(failed.calls.length, 0);
  const offline = { id: 'saved-offline', version: 1, mode: 'offline', selectedConceptId: 'a', status: { phase: 'ready' },
    brief: {}, concepts: [{ id: 'a', title: 'Saved synthetic concept' }], runtime: {} };
  const restored = page(new Error('Synthetic config unavailable'), new Map([['art-current-project', offline.id]]), async path => {
    assert.equal(path, `/api/projects/${offline.id}`); return new Response(JSON.stringify({ project: offline }));
  });
  await flush();
  for (const id of ['message', 'send-message', 'revision-text', 'submit-revision']) assert.equal(restored.get(id).disabled, true);
  assert.match(restored.get('mode-explanation').textContent, /read.only/i);
});

test('production creation stores a live request without a fixture; development still exposes its examples', async () => {
  const screen = page(settings(true), new Map(), async (_path, options) => {
    const input = JSON.parse(options.body); assert.equal(input.mode, 'live'); assert.equal(input.scenario, undefined);
    assert.equal(input.brief.request, 'Actual user input'); throw new Error('Synthetic lost creation result');
  });
  await flush(); await screen.submit(); assert.equal(screen.calls.length, 1);
  assert.equal(JSON.parse(screen.calls[0].options.body).scenario, undefined);
  assert.equal(JSON.parse(screen.storage.get('art-pending-creation')).mode, 'live');
  const dev = page(settings(false, false)); await flush();
  assert(dev.development.every(item => !item.hidden)); assert.equal(dev.get('mode').value, 'offline');
  dev.get('load-demo').handlers.click(); assert.match(dev.get('request').value, /Synthetic demo/);
});

test('old offline pending creation is replayed unchanged and restored read only without an automatic start', async () => {
  for (const phase of ['created', 'busy']) {
  const pending = { creationKey: 'a'.repeat(64), mode: 'offline', scenario: 'sufficient', brief: { request: 'Original saved input' } };
  const storage = new Map([['art-pending-creation', JSON.stringify(pending)]]);
  const project = { id: 'historical-offline', version: 1, mode: 'offline', brief: pending.brief,
    status: { phase, detail: 'Saved identity' }, runtime: {}, concepts: [], evidence: [], actions: [], questions: [], messages: [] };
  const screen = page(settings(true), storage, async (path, options) => {
    if (path === '/api/projects') assert.deepEqual(JSON.parse(options.body), pending);
    else assert.equal(path, `/api/projects/${project.id}`, 'recovery may read the identity but cannot start it');
    return new Response(JSON.stringify({ project }));
  });
  await flush(); assert.equal(screen.calls.length, 2); assert.equal(storage.has('art-pending-creation'), false);
  assert.equal(screen.get('mode').value, 'live'); assert.match(screen.get('mode-explanation').textContent, /read.only/i);
  for (const id of ['start-project', 'message', 'send-message', 'revision-text', 'submit-revision']) assert.equal(screen.get(id).disabled, true);
  assert.equal(screen.get('create-project').disabled, false, 'a saved offline record must not block a separate live project');
  }
});
