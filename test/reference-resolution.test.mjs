import test from 'node:test';
import { createAndStart } from './project-http.mjs';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createQlooTools, createDirectQlooWorkflowExecutor, createNativeQlooResolutionProvider } from '@qloo/qloo-harness';
import { createProject, applyProposal } from '../app/state.mjs';
import { wrapProjectExecutor, createProductRuntime } from '../app/runtime.mjs';
import { pendingReference, respondToReference, referenceResolutionView } from '../app/references.mjs';
import { qlooResultView, assembleContext, requestBudget } from '../app/context.mjs';
import { createAppServer } from '../app/server.mjs';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const candidates = [{ id: a, name: 'North Light', type: 'urn:entity:movie', release_year: 1995,
  description: 'Explicit synthetic movie, director Synthetic One.' },
{ id: b, name: 'North Light', type: 'urn:entity:movie', release_year: 2015,
  description: 'Explicit synthetic movie, director Synthetic Two; description says 2016.' }];
const brief = { request: '明确合成快闪任务；预算年份2026无关实体', references: ['电影《North Light》'], venue: '合成室内' };
const project = (reference = brief.references[0]) => createProject({ brief: { ...brief, references: [reference] } });
const ambiguity = (values = candidates) => ({ status: 'needs_input', results: [], resolution: { issues: [
  { input: 'North Light', input_kind: 'entity', field: 'entity', kind: values.length ? 'ambiguous' : 'not_found', candidates: values }] } });
function executor(values = candidates, calls = []) {
  return { transport: { kind: 'direct', name: 'explicit-synthetic-no-http', remote: false }, async execute(operation, input) {
    calls.push({ operation, input: structuredClone(input) });
    return { correlationId: 'explicit-synthetic-no-http', result: operation === 'describe' && input.entity === 'North Light'
      ? ambiguity(values) : { status: 'ok', results: [{ entity_id: input.entity ?? a, name: 'Synthetic metadata', type: 'urn:entity:movie' }] } };
  } };
}
const describe = { entity: 'North Light', type: 'movie' };
const selection = (value, selectedId = a) => ({ resolutionId: pendingReference(value).id, baseVersion: value.version, action: 'confirm', selectedId });
const cleanRuntime = (t, value) => t.after(() => {
  const directory = resolve('.art-runtime', value.id);
  assert(directory.startsWith(resolve('.art-runtime') + sep));
  rmSync(directory, { recursive: true, force: true });
});

test('same ID duplicates and actual year/type/creator uniquely resolve without claiming user confirmation', async () => {
  for (const [reference, values] of [[brief.references[0], [candidates[0], candidates[0]]],
    ['电影《North Light》（1995）', candidates], ['电影《North Light》；导演 Synthetic Two', candidates]]) {
    const value = project(reference), calls = [];
    const result = await wrapProjectExecutor(value, executor(values, calls)).execute('describe', describe);
    assert.equal(result.result.status, 'ok'); assert.equal(pendingReference(value), undefined);
    const record = value.referenceResolutions[0];
    assert.equal(record.status, 'system_resolved'); assert.equal(record.confirmed, false);
    assert.equal(calls[1].input.entity, record.selectedId);
    assert.equal(record.returnedCandidates.length, new Set(values.map(candidate => candidate.id)).size);
    assert(record.basis.source.includes('system resolution'));
    assert.equal(value.usage.qlooHttpAttempts, 0);
  }
});

test('request-local type/year/creator participate; unrelated request year and conflicting description do not invent matches', async () => {
  const value = createProject({ brief: { request: '2026年做快闪。文化参考是电影《North Light》（1995，导演 Synthetic One）。', venue: brief.venue } });
  const calls = [];
  await wrapProjectExecutor(value, executor(candidates, calls)).execute('describe', describe);
  assert.equal(value.referenceResolutions[0].status, 'system_resolved');
  assert.equal(value.referenceResolutions[0].selectedId, a);
  assert.equal(value.referenceResolutions[0].basis.release_year, '1995');
  assert(!value.referenceResolutions[0].originalInput.includes('2026'));
  const unmatched = project('电影《North Light》（2016）');
  await wrapProjectExecutor(unmatched, executor()).execute('describe', describe);
  assert.equal(pendingReference(unmatched).status, 'needs_details');
  assert.deepEqual(pendingReference(unmatched).candidates, []);
  assert.equal(pendingReference(unmatched).returnedCandidates[1].release_year, 2015);
});

test('unclear supplementation preserves unresolved guard until actual unique metadata resolves the new reference', async () => {
  const value = project(), calls = [], wrapped = wrapProjectExecutor(value, executor(candidates, calls));
  await wrapped.execute('describe', describe);
  respondToReference(value, { ...selection(value), action: 'clarify', text: '不清楚，随便' });
  assert.equal(pendingReference(value).status, 'pending');
  await wrapped.execute('recommend', { target_type: 'artist', signals: [a] }); assert.equal(calls.length, 1);
  await wrapped.execute('describe', { entity: a });
  assert.equal(pendingReference(value).status, 'pending', 'UUID metadata does not resolve an unrelated supplement');
  const empty = project();
  await wrapProjectExecutor(empty, executor([])).execute('describe', describe);
  respondToReference(empty, { resolutionId: pendingReference(empty).id, baseVersion: empty.version,
    action: 'clarify', text: '电影《North Light》（1995）' });
  const newInput = pendingReference(empty).originalInput;
  const matching = wrapProjectExecutor(empty, { transport: { kind: 'direct', remote: false }, async execute() {
    return { result: { status: 'ok', results: [{ ...candidates[0], entity_id: a }] } };
  } });
  await matching.execute('describe', { entity: newInput });
  assert.equal(pendingReference(empty), undefined);
  assert.equal(empty.referenceResolutions.at(-1).status, 'system_resolved');
  assert.equal(empty.referenceResolutions.at(-1).confirmed, false);
});

test('partial year or creator supplement retains the original title and uniquely uses actual saved candidates', async () => {
  for (const [text, selectedId] of [['1995年的那部', a], ['导演 Synthetic Two', b]]) {
    const value = project(), calls = [], wrapped = wrapProjectExecutor(value, executor(candidates, calls));
    await wrapped.execute('describe', describe);
    respondToReference(value, { resolutionId: pendingReference(value).id, baseVersion: value.version, action: 'clarify', text });
    assert(value.brief.references[0].includes('North Light'));
    assert.equal(pendingReference(value), undefined);
    assert.equal(value.referenceResolutions.at(-1).status, 'system_resolved');
    assert.equal(value.referenceResolutions.at(-1).confirmed, false);
    await wrapped.execute('recommend', { target_type: 'artist', signals: value.brief.references });
    assert.deepEqual(calls.at(-1).input.signals, [selectedId]);
  }
});

test('the same reference request qualifiers and complete lookup strings disambiguate; excluded ID cannot bypass system resolution', async () => {
  const requestValue = createProject({ brief: { ...brief, references: ['North Light'],
    request: '2026年做快闪。文化参考电影《North Light》（1995，导演 Synthetic One）。' } });
  await wrapProjectExecutor(requestValue, executor()).execute('describe', describe);
  assert.equal(requestValue.referenceResolutions[0].status, 'system_resolved');
  assert.equal(requestValue.referenceResolutions[0].selectedId, a);
  const repeated = createProject({ brief: { ...requestValue.brief, references: ['电影《North Light》（1995）'] } });
  await wrapProjectExecutor(repeated, executor()).execute('describe', describe);
  assert.equal(repeated.referenceResolutions[0].selectedId, a, 'same supplied year in both input fields is one condition');
  const whole = 'North Light (1995), directed by Synthetic One', value = project(whole), calls = [];
  const wrapped = wrapProjectExecutor(value, { transport: { kind: 'direct', remote: false }, async execute(operation, input) {
    calls.push({ operation, input: structuredClone(input) });
    return { result: input.entity === whole ? { ...ambiguity(), resolution: { issues: [{ ...ambiguity().resolution.issues[0], input: whole }] } }
      : { status: 'ok', results: [candidates[0]] } };
  } });
  await wrapped.execute('describe', { entity: whole });
  assert.equal(value.referenceResolutions[0].status, 'system_resolved');
  const count = calls.length;
  const blocked = await wrapped.execute('recommend', { target_type: 'artist', signals: [b] });
  assert.equal(blocked.result.feedback.code, 'REFERENCE_CHOICE_MISMATCH');
  assert.equal(calls.length, count);
});

test('actual official executor identity type survives compact results when resolving a supplemented not-found reference', async () => {
  const value = project();
  const raw = { entity_id: a, name: 'North Light', types: ['urn:entity:movie'],
    properties: { release_year: 1995, description: 'Explicit synthetic raw response; director Synthetic One.' } };
  let searches = 0;
  const client = { async searchEntities() { return { results: { entities: ++searches === 1 ? [] : [raw] } }; },
    async entities() { return { results: { entities: [raw] } }; } };
  const native = createNativeQlooResolutionProvider(client, { cacheMaxEntries: 0 });
  const wrapped = wrapProjectExecutor(value, createDirectQlooWorkflowExecutor(client, undefined, native));
  await wrapped.execute('describe', describe);
  respondToReference(value, { resolutionId: pendingReference(value).id, baseVersion: value.version,
    action: 'clarify', text: '电影《North Light》（1995）' });
  const returned = await wrapped.execute('describe', describe);
  assert.equal(returned.result.status, 'ok');
  assert.equal(returned.result.results[0].type, undefined, 'official compact result does not copy raw types');
  assert.equal(returned.result.resolution.outcomes[0].selected.type, 'urn:entity:movie');
  assert.equal(pendingReference(value), undefined);
  assert.equal(value.referenceResolutions.at(-1).selected.type, 'urn:entity:movie');
  assert.equal(value.referenceResolutions.at(-1).status, 'system_resolved');
  assert.equal(value.referenceResolutions.at(-1).confirmed, false);
  assert.equal(value.usage.qlooHttpAttempts, 0);
});

test('different plausible IDs persist; UUID recommendation and final proposal are blocked, metadata is not confirmation', async () => {
  const value = project(), calls = [], wrapped = wrapProjectExecutor(value, executor(candidates, calls));
  await wrapped.execute('describe', describe);
  const saved = structuredClone(pendingReference(value));
  assert.equal(saved.originalInput, brief.references[0]); assert.equal(saved.projectId, value.id);
  assert.deepEqual(saved.candidates, candidates); assert.equal(saved.status, 'pending');
  const blocked = await wrapped.execute('recommend', { target_type: 'artist', signals: [a], limit: 2 });
  assert.equal(blocked.result.feedback.code, 'REFERENCE_CONFIRMATION_REQUIRED'); assert.equal(calls.length, 1);
  assert.throws(() => applyProposal(value, { projectId: value.id, baseVersion: value.version,
    phase: 'insufficient_evidence', summary: 'must not finish', concepts: [] }), { code: 'REFERENCE_CONFIRMATION_REQUIRED' });
  await wrapped.execute('describe', { entity: a });
  assert.deepEqual(pendingReference(value), saved); assert.equal(saved.confirmed, false);
  assert.equal(value.usage.qlooHttpAttempts, 0);
});

test('valid page choice binds original research to selected actual ID and rejects unselected candidate', async () => {
  const value = project(), calls = [], wrapped = wrapProjectExecutor(value, executor(candidates, calls));
  await wrapped.execute('describe', describe);
  respondToReference(value, selection(value, b));
  assert.equal(value.referenceResolutions[0].status, 'user_confirmed');
  assert.equal(value.referenceResolutions[0].confirmed, true);
  await wrapped.execute('recommend', { target_type: 'artist', signals: [brief.references[0]], limit: 2 });
  assert.deepEqual(calls.at(-1).input.signals, [b]);
  const count = calls.length;
  const blocked = await wrapped.execute('recommend', { target_type: 'artist', signals: [a], limit: 2 });
  assert.equal(blocked.result.feedback.code, 'REFERENCE_CHOICE_MISMATCH'); assert.equal(calls.length, count);
  // New recommended entities remain usable; they do not all need a user choice.
  await wrapped.execute('recommend', { target_type: 'artist', signals: ['33333333-3333-4333-8333-333333333333'], limit: 2 });
  assert.equal(calls.length, count + 1);
});

test('UUID candidate validation uses official case-insensitive identifier semantics', async () => {
  const values = candidates.map((candidate, index) => ({ ...candidate,
    id: index ? 'BB222222-2222-4222-8222-222222222222' : 'AA111111-1111-4111-8111-111111111111' }));
  const duplicate = project();
  await wrapProjectExecutor(duplicate, executor([values[0], { ...values[0], id: values[0].id.toLowerCase() }])).execute('describe', describe);
  assert.equal(pendingReference(duplicate), undefined);
  assert.equal(duplicate.referenceResolutions[0].returnedCandidates.length, 1);
  const value = project(), calls = [], wrapped = wrapProjectExecutor(value, executor(values, calls));
  await wrapped.execute('describe', describe);
  respondToReference(value, selection(value, values[0].id));
  const count = calls.length;
  for (const id of [values[1].id, values[1].id.toLowerCase()]) {
    const blocked = await wrapped.execute('recommend', { target_type: 'artist', signals: [id] });
    assert.equal(blocked.result.feedback.code, 'REFERENCE_CHOICE_MISMATCH');
    assert.equal(calls.length, count);
  }
  await wrapped.execute('recommend', { target_type: 'artist', signals: [values[0].id.toLowerCase()] });
  assert.equal(calls.length, count + 1);
});

test('no result, cancellation and invalid selection never default to first; old and foreign choices reject', async () => {
  for (const values of [[], candidates]) {
    const value = project(), calls = [], wrapped = wrapProjectExecutor(value, executor(values, calls));
    await wrapped.execute('describe', describe);
    assert.equal(pendingReference(value).status, values.length ? 'pending' : 'needs_details');
    assert.throws(() => respondToReference(value, selection(value, 'not-a-candidate')), { code: 'REFERENCE_SELECTION_INVALID' });
    if (values.length) respondToReference(value, { ...selection(value), action: 'cancel' });
    assert.equal(pendingReference(value).status, 'needs_details');
    assert.equal(pendingReference(value).confirmed, false);
    await wrapped.execute('recommend', { target_type: 'artist', signals: [a] }); assert.equal(calls.length, 1);
    assert.throws(() => respondToReference(value, selection(value)), { code: 'REFERENCE_SELECTION_INVALID' });
  }
  const value = project(); await wrapProjectExecutor(value, executor()).execute('describe', describe);
  const stale = selection(value); value.version++;
  assert.throws(() => respondToReference(value, stale), { code: 'STALE_REFERENCE_RESOLUTION' });
  const other = project(); other.referenceResolutions = structuredClone(value.referenceResolutions);
  assert.throws(() => respondToReference(other, { ...stale, baseVersion: other.version }), { code: 'STALE_REFERENCE_RESOLUTION' });
});

test('authoritative pending summary enters bounded context without replaying candidate bodies', async () => {
  const value = project();
  const raw = candidates.map(candidate => ({ ...candidate, description: 'SYNTHETIC_LARGE_CANDIDATE '.repeat(5000) }));
  const returned = await wrapProjectExecutor(value, executor(raw)).execute('describe', describe);
  const view = qlooResultView(returned.result, value);
  assert(!JSON.stringify(view).includes('SYNTHETIC_LARGE_CANDIDATE'));
  assert.equal(value.referenceResolutions[0].candidates[0].description, raw[0].description);
  const messages = assembleContext([{ role: 'user', content: '{"message":"continue"}' }], {
    brief: value.brief, referenceResolution: referenceResolutionView(value) });
  const work = JSON.parse(messages[0].content[0].text).project;
  assert.equal(work.referenceResolution.unresolvedCount, 1);
  assert(requestBudget({ systemPrompt: 'synthetic', messages, tools: [] }, { contextWindow: 32000, maxTokens: 12000 }).fits);
  const unrelated = { status: 'needs_input', referenceResolution: referenceResolutionView(value), resolution: { issues: [
    { input: 'Unrelated later tag', input_kind: 'tag', candidates: [{ id: 'tag-one', name: 'Actual synthetic tag' }] }] } };
  assert.deepEqual(qlooResultView(unrelated, value).resolution, unrelated.resolution,
    'later non-reference ambiguity retains its actual workflow candidates');
});

function decide(context, snapshot) {
  const current = context.messages.slice(context.messages.findLastIndex(message => message.role === 'user') + 1);
  if (!snapshot.referenceResolution.records.length) return [
    { type: 'toolCall', id: 'resolve-original', name: 'qloo_describe', arguments: describe },
    { type: 'toolCall', id: 'same-batch-bypass', name: 'qloo_recommend', arguments: { target_type: 'artist', signals: [a], limit: 2 } }];
  if (!current.some(message => message.role === 'toolResult')) return [{ type: 'toolCall', id: 'continue-selected', name: 'qloo_recommend',
    arguments: { target_type: 'artist', signals: snapshot.brief.references, limit: 2 } }];
  return [{ type: 'toolCall', id: 'stop-after-research', name: 'propose_design_response', arguments: {
    baseVersion: snapshot.version, phase: 'insufficient_evidence', summary: '明确模拟研究已使用选择ID；未生成设计效果证据。', concepts: [] } }];
}

test('installed official sequential tools block a UUID sibling in the same batch before synthetic executor', async t => {
  const value = project(), calls = []; cleanRuntime(t, value);
  const tools = createQlooTools({ executor: executor() });
  assert(tools.filter(tool => ['qloo_describe', 'qloo_recommend'].includes(tool.name)).every(tool => tool.executionMode === 'sequential'));
  const runtime = await createProductRuntime(value, { env: {}, decide, qlooExecutor: executor(candidates, calls) });
  try {
    await runtime.submit(value.brief.request);
    assert.equal(value.status.phase, 'needs_input'); assert.equal(calls.length, 1);
    assert.equal(value.actions.find(action => action.toolCallId === 'same-batch-bypass').feedback.code, 'REFERENCE_CONFIRMATION_REQUIRED');
    assert.equal(value.usage.modelHttpAttempts, 0); assert.equal(value.usage.qlooHttpAttempts, 0);
  } finally { await runtime.dispose(); }
});

const local = (port, method, path, payload) => new Promise((done, reject) => {
  const req = request({ hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, response => {
    let text = ''; response.on('data', chunk => { text += chunk; });
    response.on('end', () => done({ status: response.statusCode, body: JSON.parse(text) }));
  }); req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
});
async function settled(port, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await local(port, 'GET', `/api/projects/${id}`);
    if (result.body.project.status.phase !== 'busy') return result.body.project;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('Synthetic project did not settle');
}

test('GET refresh and service restart restore waiting state; vague text rejects and valid selection resumes same project', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'art-reference-test-')), calls = [];
  t.after(() => { assert(dataDir.startsWith(join(tmpdir(), 'art-reference-test-'))); rmSync(dataDir, { recursive: true, force: true }); });
  let app;
  const start = async () => {
    app = createAppServer({ env: {}, dataDir, runtimeOptions: { decide, qlooExecutor: executor(candidates, calls) } });
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    return app.server.address().port;
  };
  let port = await start();
  try {
    const created = await createAndStart((...args) => local(port, ...args), { brief });
    const id = created.body.project.id; cleanRuntime(t, created.body.project);
    const waiting = await settled(port, id), saved = structuredClone(pendingReference(waiting));
    assert.equal(waiting.concepts.length, 0);
    assert.deepEqual(pendingReference((await local(port, 'GET', `/api/projects/${id}`)).body.project), saved);
    await app.dispose(); port = await start();
    const restored = (await local(port, 'GET', `/api/projects/${id}`)).body.project;
    assert.deepEqual(pendingReference(restored), saved); assert.equal(calls.length, 1);
    assert.equal((await local(port, 'POST', `/api/projects/${id}/messages`, { text: '第一个吧' })).status, 409);
    assert.equal(calls.length, 1);
    const invalid = await local(port, 'POST', `/api/projects/${id}/messages`, { referenceResolution: selection(restored, 'unknown') });
    assert.equal(invalid.status, 409); assert.equal(calls.length, 1);
    const continued = await local(port, 'POST', `/api/projects/${id}/messages`, { referenceResolution: selection(restored, b) });
    assert.equal(continued.status, 202);
    const final = await settled(port, id);
    assert.equal(final.id, id); assert.equal(final.status.phase, 'insufficient_evidence');
    assert.equal(final.referenceResolutions[0].status, 'user_confirmed');
    assert.deepEqual(calls.at(-1).input.signals, [b]);
    assert.equal(final.usage.modelHttpAttempts, 0); assert.equal(final.usage.qlooHttpAttempts, 0);
  } finally { await app.dispose(); }
});
