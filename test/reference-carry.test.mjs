import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';

// This file uses the installed official workflows with a synthetic client only.
// Install before importing the app so even its captured fetch cannot go online.
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error('Reference carry test attempted network'); };
globalThis.fetch = deny;
const require = createRequire(import.meta.url);
for (const [name, methods] of [['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']]]) {
  const api = require(name);
  for (const method of methods) api[method] = deny;
  if (name === 'node:net') api.Socket.prototype.connect = deny;
}
syncBuiltinESMExports();
const { createQlooTools, createDirectQlooWorkflowExecutor, createNativeQlooResolutionProvider } = await import('@qloo/qloo-harness');
const { createProject } = await import('../app/state.mjs');
const { wrapProjectExecutor } = await import('../app/runtime.mjs');
const { pendingReference, bindReferenceInputs } = await import('../app/references.mjs');
const { qlooResultView } = await import('../app/context.mjs');

const artistId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const brandId = '33333333-3333-4333-8333-333333333333';
function setup({ name = 'Synthetic Echo', request = `合成需求：参考公开音乐人 ${name}，研究品牌关联。`,
  references = [name], typedAmbiguous = false } = {}) {
  const project = createProject({ brief: { request, references, venue: '合成室内' } });
  const artist = { entity_id: artistId, name, types: ['urn:entity:artist'],
    properties: { short_description: 'Explicit synthetic artist; no real Qloo response.' } };
  const other = { entity_id: otherId, name, types: [typedAmbiguous ? 'urn:entity:artist' : 'urn:entity:album'] };
  const calls = [];
  const client = {
    async searchEntities(query) {
      calls.push({ method: 'search', query: structuredClone(query) });
      return { results: { entities: query.types && !typedAmbiguous ? [artist] : [artist, other] } };
    },
    async entities(query) {
      calls.push({ method: 'entities', query: structuredClone(query) });
      return { results: { entities: [artist] } };
    },
    async insights(query) {
      calls.push({ method: 'insights', query: structuredClone(query) });
      return { results: { entities: [{ entity_id: brandId, name: 'Synthetic Brand', types: ['urn:entity:brand'], affinity: 0.2 }] } };
    },
  };
  const native = createNativeQlooResolutionProvider(client, { cacheMaxEntries: 0 });
  const wrapped = wrapProjectExecutor(project, createDirectQlooWorkflowExecutor(client, undefined, native), {});
  const tools = createQlooTools({ executor: wrapped });
  const execute = async (operation, input) => (await tools.find(tool => tool.name === `qloo_${operation}`)
    .execute(`synthetic-${operation}`, input)).details;
  return { name, project, calls, tools, execute };
}

test('successful typed description carries its identity into a preplanned recommendation without a second name search', async () => {
  for (const name of ['Synthetic Echo', 'Another Synthetic Artist']) {
    const { project, calls, tools, execute } = setup({ name });
    const recommendation = { target_type: 'brand', signals: [name], limit: 2, explain: true };
    assert(tools.filter(tool => ['qloo_describe', 'qloo_recommend'].includes(tool.name))
      .every(tool => tool.executionMode === 'sequential'));
    assert(tools.find(tool => tool.name === 'qloo_recommend').promptGuidelines.some(text => text.includes('reuse returned Qloo UUIDs')));
    const described = await execute('describe', { entity: name, type: 'artist' });
    assert.equal(described.status, 'ok');
    assert.equal(described.resolution.outcomes[0].selected.id, artistId);
    assert.equal(described.results[0].type, undefined, 'official compact entity omits type; resolution retains it');
    const recommended = await execute('recommend', recommendation);
    assert.equal(recommended.status, 'ok');
    assert.deepEqual(calls.map(call => call.method), ['search', 'entities', 'entities', 'insights']);
    assert.deepEqual(calls[2].query, [artistId], 'official UUID lookup still validates the exact ID');
    assert.deepEqual(calls.at(-1).query['signal.interests.entities'], [artistId]);
    assert.deepEqual(recommendation.signals, [name], 'preplanned caller arguments are not mutated');
    assert.deepEqual(project.evidence.at(-1).query.input.signals, [artistId]);
    const record = project.referenceResolutions[0];
    assert.equal(record.selected.type, 'urn:entity:artist');
    assert.equal(record.status, 'system_resolved');
    assert.equal(record.confirmed, false, 'system resolution is not a user click');
    assert.equal(qlooResultView(described, project).referenceResolution.records[0].selectedId, artistId);
    const restored = JSON.parse(JSON.stringify(project));
    assert.deepEqual(bindReferenceInputs(restored, 'recommend', recommendation).signals, [artistId]);
    assert.equal(project.usage.qlooHttpAttempts, 0);
  }
});

test('same-type ambiguity still needs input and a sibling recommendation cannot pick the first candidate', async () => {
  const { name, project, calls, execute } = setup({ typedAmbiguous: true });
  const described = await execute('describe', { entity: name, type: 'artist' });
  assert.equal(described.status, 'needs_input');
  assert.equal(pendingReference(project).status, 'pending');
  const recommended = await execute('recommend', { target_type: 'brand', signals: [artistId] });
  assert.equal(recommended.status, 'needs_input');
  assert.equal(recommended.feedback.code, 'REFERENCE_CONFIRMATION_REQUIRED');
  assert.deepEqual(calls.map(call => call.method), ['search']);
});

test('an assistant-supplied type alone cannot confirm a vague user reference', async () => {
  const { name, project, calls, execute } = setup({ request: '合成需求：研究 Synthetic Echo。' });
  await execute('describe', { entity: name, type: 'artist' });
  const recommended = await execute('recommend', { target_type: 'brand', signals: [name] });
  assert.equal(recommended.status, 'needs_input');
  assert.equal(pendingReference(project).status, 'pending');
  assert(!calls.some(call => call.method === 'insights'));
});

test('a description conflicting with the user type cannot become a reusable identity', async () => {
  const { name, project, calls, execute } = setup({ request: '合成需求：文化参考是电影《Synthetic Echo》。', references: ['电影《Synthetic Echo》'] });
  await execute('describe', { entity: name, type: 'artist' });
  const recommended = await execute('recommend', { target_type: 'brand', signals: [name] });
  assert.equal(recommended.status, 'needs_input');
  assert.equal(pendingReference(project).status, 'needs_details');
  assert(!calls.some(call => call.method === 'insights'));
});

test('reuse requires official resolution and a matching returned ID, but does not impose exact spelling', async () => {
  for (const variant of ['alias', 'no_outcome', 'wrong_id', 'missing_type', 'unrelated_reference']) {
    const project = createProject({ brief: { request: '文化参考是音乐人 Synthetic Alias。',
      references: variant === 'unrelated_reference' ? ['Other Reference'] : ['Synthetic Alias'] } });
    if (variant === 'unrelated_reference') project.brief.request = '无该参考的合成需求。';
    const input = { entity: 'Synthetic Alias', type: 'artist' };
    const selected = { id: artistId, name: 'Different Official Canonical Name', type: 'urn:entity:artist' };
    if (variant === 'missing_type') delete selected.type;
    const result = { status: 'ok', results: [{ entity_id: variant === 'wrong_id' ? otherId : artistId }],
      resolution: { outcomes: variant === 'no_outcome' ? [] : [{ input: input.entity, status: 'resolved', selected }] } };
    const wrapped = wrapProjectExecutor(project, { transport: { kind: 'direct', remote: false },
      async execute() { return { result }; } }, {});
    await wrapped.execute('describe', input);
    assert.deepEqual(bindReferenceInputs(project, 'recommend', { signals: [input.entity] }).signals,
      [variant === 'alias' ? artistId : input.entity], variant);
  }
});

after(() => assert.equal(networkAttempts, 0, 'zero real network attempts'));
