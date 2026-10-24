import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const config = { production: false, modes: { live: { enabled: false, available: false } } };
const project = { id: 'synthetic-restored', mode: 'offline', version: 1, status: { phase: 'created', detail: 'Saved, awaiting explicit start' },
  brief: { request: 'Original brief' }, runtime: {}, usage: {}, concepts: [], questions: [], messages: [], actions: [] };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(done => setImmediate(done)); };

function page(storage, send) {
  const elements = new Map(), calls = [];
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', dataset: {}, handlers: {}, firstElementChild: {},
      classList: { add() {} }, addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute() {}, removeAttribute() {}, focus() {}, replaceChildren() {}, append(child) { this.textContent += child.textContent ?? ''; },
      querySelector() { return get(`${id}-option`); } });
    return elements.get(id);
  };
  get('mode').value = 'offline'; get('request').value = 'Original brief';
  const location = { href: 'https://art.invalid/' };
  const context = { URL, crypto: webcrypto, console,
    localStorage: { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, String(value)), removeItem: name => storage.delete(name) },
    history: { replaceState(_state, _title, url) { location.href = String(url); } },
    window: { location, setTimeout() {} },
    document: { getElementById: get, createElement: () => ({ addEventListener() {} }), body: { classList: { add() {} }, setAttribute() {} }, querySelectorAll: () => [] },
    async fetch(path, options = {}) {
      if (path === '/api/config') return new Response(JSON.stringify(config));
      calls.push({ path, options });
      return send(path, options, storage, location);
    } };
  runInNewContext(source, context);
  return { calls, get, async submit() { await get('brief-form').handlers.submit({ preventDefault() {} }); }, location };
}

test('lost creation response retains the same durable request; reopening recovers identity without starting generation', async () => {
  const storage = new Map(); let originalPayload;
  const first = page(storage, async (path, options) => {
    assert.equal(path, '/api/projects');
    originalPayload = JSON.parse(options.body);
    assert.match(originalPayload.creationKey, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(storage.get('art-pending-creation')), originalPayload, 'recovery request must be durable before HTTP');
    throw new Error('Synthetic response lost after server save');
  });
  await first.submit();
  assert(storage.has('art-pending-creation'));
  assert.doesNotMatch(first.get('connection-error').textContent, /project was not created/i);
  const reopened = page(storage, async (path, options) => {
    if (path === '/api/projects') assert.deepEqual(JSON.parse(options.body), originalPayload);
    else assert.equal(path, `/api/projects/${project.id}`, 'recovery must not start generation');
    return new Response(JSON.stringify({ project }));
  });
  await flush();
  assert.equal(reopened.calls.length, 2);
  assert.equal(storage.get('art-current-project'), project.id);
  assert.equal(storage.has('art-pending-creation'), false);
  assert.equal(reopened.get('start-project').hidden, false);
});

test('normal create remembers identity before start; a lost generation response refreshes by GET without replay', async () => {
  const storage = new Map(); let starts = 0;
  const first = page(storage, async (path, _options, saved, location) => {
    if (path === '/api/projects') return new Response(JSON.stringify({ project }));
    if (path === `/api/projects/${project.id}`) return new Response(JSON.stringify({ project }));
    assert.equal(path, `/api/projects/${project.id}/start`); starts++;
    assert.equal(saved.get('art-current-project'), project.id);
    assert.equal(new URL(location.href).searchParams.get('project'), project.id);
    throw new Error('Synthetic final response lost');
  });
  await first.submit();
  assert.equal(starts, 1);
  assert.doesNotMatch(first.get('connection-error').textContent, /：/);
  const reopened = page(storage, async (path, options) => {
    assert.equal(path, `/api/projects/${project.id}`); assert.equal(options.method, undefined);
    return new Response(JSON.stringify({ project: { ...project, status: { phase: 'interrupted', detail: 'Saved interrupted run' } } }));
  });
  await flush();
  assert.equal(reopened.calls.length, 1); assert.equal(starts, 1);
  assert.match(reopened.get('project-status').innerHTML, /interrupted/);
});
