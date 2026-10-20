import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createQlooTools } from '@qloo/qloo-harness';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { assembleContext, evidenceView, qlooResultView, readProjectEvidence, requestBudget } from '../app/context.mjs';
import { createProductRuntime, recordEvidence, wrapProjectExecutor } from '../app/runtime.mjs';
import { createProject } from '../app/state.mjs';

const model = { contextWindow: 32000, maxTokens: 12000 };
const text = message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');
const assistant = (id, name, args = {}) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'SYNTHETIC_PROTOCOL_ONLY' },
  { type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse', timestamp: 1,
  usage: { input: 50000, output: 20000, cacheRead: 0, cacheWrite: 0, totalTokens: 70000 } });
const result = (id, name, details) => ({ role: 'toolResult', toolCallId: id, toolName: name,
  content: [{ type: 'text', text: JSON.stringify(details) }], details, timestamp: 2 });
const makeProject = () => createProject({ brief: { request: '合成有界上下文测试', venue: '合成室内', mustKeep: ['触摸样本'] } });
function cleanup(t, project) {
  const directory = resolve('.art-runtime', project.id);
  t.after(() => { assert(directory.startsWith(resolve('.art-runtime') + sep)); rmSync(directory, { recursive: true, force: true }); });
}

test('whole recent tool batch retains protocol pairs and zeroes stale usage on copies only', () => {
  const first = assistant('old', 'qloo_describe');
  const latest = assistant('one', 'read_project_evidence');
  latest.content.push({ type: 'toolCall', id: 'two', name: 'read_project_evidence', arguments: {} });
  const messages = [{ role: 'user', content: [{ type: 'text', text: '{"message":"keep exact request"}' }], timestamp: 0 },
    first, result('old', 'qloo_describe', { status: 'ok', results: [] }), latest,
    result('one', 'read_project_evidence', { status: 'ok', exact: true, value: 'one' }),
    result('two', 'read_project_evidence', { status: 'missing', exact: false })];
  const before = structuredClone(messages);
  const view = assembleContext(messages, { brief: { mustKeep: ['keep all constraints'] } });
  assert.deepEqual(view.map(message => message.role), ['user', 'assistant', 'toolResult', 'toolResult']);
  assert.deepEqual(view[1].content, latest.content, 'required synthetic thinking is opaque protocol content');
  assert.equal(view[1].usage.totalTokens, 0);
  assert.equal(JSON.parse(text(view[0])).message, 'keep exact request');
  assert.equal(clampMaxTokensToContext(model, { systemPrompt: 'system', messages: view, tools: [] }, 12000), 12000);
  assert.deepEqual(messages, before);
});

test('unconfirmed ambiguity remains in work state after three different tool rounds', () => {
  const ambiguity = { status: 'needs_input', resolution: { confirmed: false,
    candidates: [{ entity_id: 'candidate-a', name: 'Unconfirmed A' }, { entity_id: 'candidate-b', name: 'Unconfirmed B' }] }, results: [] };
  const messages = [{ role: 'user', content: '{"message":"research references"}' },
    assistant('ambiguous', 'qloo_describe', { entity: 'Unknown reference' }), result('ambiguous', 'qloo_describe', ambiguity),
    assistant('other', 'qloo_describe', { entity: 'Unknown reference' }), result('other', 'qloo_describe', { status: 'ok', results: [] }),
    assistant('newest', 'qloo_describe', { entity: 'Unknown reference' }), result('newest', 'qloo_describe', { status: 'empty', results: [] })];
  const view = assembleContext(messages, { brief: { references: ['Unknown reference'] } });
  const work = JSON.parse(text(view[0])).project;
  assert.equal(work.openResearchQuestions[0].confirmed, false);
  assert.deepEqual(work.openResearchQuestions[0].result.resolution, ambiguity.resolution);
  assert.deepEqual(work.openResearchQuestions[0].input, { entity: 'Unknown reference' });
  assert.equal(view[1].content.find(block => block.type === 'toolCall').id, 'newest');
  assert.equal(view.length, 3);
});

test('giant unresolved tool inputs are bounded display copies and distinct observation IDs do not merge', () => {
  const giant = 'SYNTHETIC_QUERY_PREFIX '.repeat(10000);
  const messages = [{ role: 'user', content: '{"message":"preserve current exact brief"}' },
    assistant('first-observation', 'qloo_describe', { entity: `${giant}one` }), result('first-observation', 'qloo_describe', { status: 'needs_input', results: [] }),
    assistant('second-observation', 'qloo_describe', { entity: `${giant}two` }), result('second-observation', 'qloo_describe', { status: 'needs_input', results: [] }),
    assistant('newest', 'read_project_evidence'), result('newest', 'read_project_evidence', { status: 'missing' })];
  const before = structuredClone(messages);
  const constraints = 'Exact hard requirement '.repeat(100);
  const view = assembleContext(messages, { brief: { mustKeep: [constraints] } });
  const work = JSON.parse(text(view[0])).project;
  assert.equal(work.openResearchQuestions.length, 2);
  assert.notEqual(work.openResearchQuestions[0].observationId, work.openResearchQuestions[1].observationId);
  assert(work.openResearchQuestions.every(item => item.input.exact === false && item.input.truncated === true));
  assert.deepEqual(work.brief.mustKeep, [constraints]);
  assert(text(view[0]).length < 7000);
  assert.deepEqual(messages, before);
});

test('giant interpretation and card resolution metadata stay bounded while exact query and raw authority survive', () => {
  const project = makeProject(); project.mode = 'live';
  const huge = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`field-${index}`, 'Synthetic metadata '.repeat(100)]));
  const signals = Array.from({ length: 10000 }, (_, index) => ({ entityId: `seed-${index}`, name: `Synthetic seed ${index}`,
    type: 'urn:entity:artist', match: 'exact', ...(index === 0 ? { resolution: huge } : {}) }));
  const input = { target_type: 'movie', signals: ['Synthetic client signal'], limit: 1 };
  const card = recordEvidence(project, 'recommend', input, { correlationId: 'synthetic-only', result: {
    status: 'ok', interpretation: { signals }, results: [{ entity_id: 'returned-entity', name: 'Synthetic returned entity' }] } });
  card.extraMetadata = huge;
  const before = structuredClone(project.evidence);
  const view = evidenceView(card);
  assert.equal(view.inputReferences.length, 12);
  assert.equal(view.inputReferenceCount, 10000);
  assert.equal(view.omittedInputReferenceCount, 9988);
  assert.equal(view.inputReferences[0].id, 'seed-0');
  assert.equal(view.inputReferences[0].name, 'Synthetic seed 0');
  assert.equal(view.inputReferences[0].resolution.exact, false);
  assert.equal(view.extraMetadata.exact, false);
  assert.equal(view.workflowContext.interpretation.signals.total, 10000);
  assert.equal(view.workflowContext.interpretation.signals.items[0].entityId, 'seed-0');
  assert.deepEqual(view.query.input, input);
  assert(JSON.stringify(view).length < 16000);
  assert(requestBudget({ messages: [{ role: 'user', content: JSON.stringify(view) }], tools: [], max_tokens: 12000 }, model).fits);
  assert.deepEqual(project.evidence, before);
  assert.equal(project.usage.qlooHttpAttempts, 0);
});

test('field inventories explicitly count omitted entity, property and workflow fields', () => {
  const fields = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field-${index}`, index]));
  const properties = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`property-${index}`, index]));
  const entity = { entity_id: 'synthetic-entity', ...fields, properties };
  const rawResult = { status: 'ok', results: [entity], ...fields };
  const card = { id: 'synthetic-card', projectId: 'synthetic-project', returnedEntities: [entity], rawResult };
  const before = structuredClone(card);
  for (const expanded of [false, true]) {
    const view = evidenceView(card, expanded);
    const returned = view.returnedEntities[0];
    assert.equal(returned.availableFields.length, 48);
    assert.equal(returned.propertyFields.length, 48);
    assert.equal(returned.omittedFieldCount, Object.keys(entity).length - 48);
    assert.equal(returned.omittedPropertyFieldCount, Object.keys(properties).length - 48);
    assert.equal(view.availableWorkflowFields.length, 48);
    assert.equal(view.omittedWorkflowFieldCount, Object.keys(rawResult).length - 1 - 48);
  }
  const tool = qlooResultView({ ...rawResult, artEvidence: { id: card.id } }, { id: card.projectId, evidence: [card] }, false);
  assert.equal(tool.availableWorkflowFields.length, 48);
  assert.equal(tool.omittedWorkflowFieldCount, Object.keys(rawResult).length - 1 - 48);
  assert.deepEqual(card, before);
});

test('giant stored queries have bounded views and exact allowlisted local query leaves', () => {
  const project = makeProject();
  const input = { entity: 'Synthetic exact input', signals: ['Exact first signal', 'Exact second signal'],
    giant: 'Synthetic historical query '.repeat(10000) };
  const card = recordEvidence(project, 'describe', input, { result: { status: 'ok', results: [
    { entity_id: 'returned-entity', properties: { description: 'Exact returned description' } }] } });
  const before = structuredClone(project);
  const view = evidenceView(card);
  assert.equal(view.query.exact, false); assert.equal(view.query.truncated, true);
  assert.equal(view.query.readTool, 'read_project_evidence'); assert.equal(view.query.field, 'query');
  assert(JSON.stringify(view).length < 5000);
  const read = field => readProjectEvidence(project, { evidenceId: card.id, field });
  assert.equal(read('query').status, 'too_large');
  assert.equal(read('query.input.giant').status, 'too_large');
  assert.deepEqual(read('query.input.signals').value, input.signals);
  assert.equal(read('query.input.signals.1').value, 'Exact second signal');
  assert.equal(read('query.input.entity').value, input.entity);
  assert.equal(read('query.workflow').value, 'describe');
  assert.equal(read('query.input.absent').status, 'missing');
  for (const field of ['brief', 'rawResult', 'context.venue', 'properties.description', 'queryLike.input'])
    assert.equal(read(field).status, 'invalid_input');
  for (const field of ['query.__proto__', 'query.constructor', 'query.input.prototype', 'query.https://example.invalid'])
    assert.equal(read(field).status, 'invalid_path');
  assert.equal(readProjectEvidence(project, { evidenceId: card.id, entityId: 'returned-entity', field: 'query.input.entity' }).status, 'missing');
  assert.equal(readProjectEvidence(project, { evidenceId: card.id, entityId: 'returned-entity', field: 'properties.description' }).value, 'Exact returned description');
  const other = makeProject(); other.evidence = [card];
  assert.equal(readProjectEvidence(other, { evidenceId: card.id, field: 'query.input.entity' }).status, 'missing');
  assert.deepEqual(project, before);
  assert.equal(project.usage.qlooHttpAttempts, 0);
});

test('incomplete, duplicate and orphan current tool results stop locally before any model callback', async t => {
  const project = makeProject(); cleanup(t, project);
  let modelCallbacks = 0;
  const runtime = await createProductRuntime(project, { env: {}, decide() { modelCallbacks++; return []; } });
  try {
    const user = { role: 'user', content: '{"message":"Synthetic partial batch"}' };
    const call = assistant('one', 'read_project_evidence');
    call.content.push({ type: 'toolCall', id: 'two', name: 'read_project_evidence', arguments: {} });
    const one = result('one', 'read_project_evidence', { status: 'missing' });
    for (const messages of [[user, call, one], [user, assistant('one', 'read_project_evidence'), one, one], [user, one]]) {
      assert.throws(() => assembleContext(messages, {}), { code: 'MODEL_CONTEXT_PROTOCOL_INCOMPLETE' });
    }
    runtime.session.agent.state.messages = [user, call, one];
    await runtime.session.agent.continue(); await runtime.session.agent.waitForIdle();
    assert.equal(modelCallbacks, 0);
    assert.equal(project.runtime.localFailure.code, 'MODEL_CONTEXT_PROTOCOL_INCOMPLETE');
    assert.equal(project.usage.modelHttpAttempts, 0);
  } finally { await runtime.dispose(); }
});

test('full Qloo raw result is recorded before a giant single return gets a bounded public-hook view', async t => {
  const project = makeProject(); cleanup(t, project);
  const raw = { status: 'ok', interpretation: { signals: [{ entityId: 'seed', name: 'Synthetic seed', type: 'artist' }] },
    results: Array.from({ length: 10000 }, (_, index) => ({ entity_id: `entity-${index}`, name: `Synthetic ${index}`,
      properties: { description: index ? 'Exact small description.' : 'synthetic giant description '.repeat(10000) } })),
    explainability: { detail: 'synthetic giant metadata '.repeat(10000) } };
  const before = structuredClone(raw);
  const executor = wrapProjectExecutor(project, { transport: { kind: 'direct', remote: false }, async execute() { return { result: raw, correlationId: 'synthetic-no-http' }; } });
  const tool = createQlooTools({ executor }).find(tool => tool.name === 'qloo_recommend');
  const complete = await tool.execute('giant', { target_type: 'movie', signals: ['Synthetic seed'], limit: 10 });
  const card = project.evidence[0];
  assert.deepEqual(card.rawResult, before);
  assert.equal(card.returnedEntities.length, 10000);
  const runtime = await createProductRuntime(project, { env: {} });
  try {
    const bounded = await runtime.session.agent.afterToolCall({ toolCall: { name: 'qloo_recommend' }, result: complete, isError: false });
    const value = JSON.parse(text(bounded));
    assert.equal(value.results.length, 12);
    assert.equal(value.artEvidence.returnedEntityCount, 10000);
    assert.equal(value.results[0].observedFields['properties.description'].exact, false);
    assert(text(bounded).length < 16000);
    const index = readProjectEvidence(project, { evidenceId: card.id, offset: 12 });
    assert.equal(index.entities[0].entity_id, 'entity-12');
    assert.equal(index.total, 10000); assert.equal(index.nextOffset, 24);
    assert.equal(readProjectEvidence(project, { evidenceId: card.id, entityId: 'entity-0', field: 'properties.description' }).status, 'too_large');
    assert.deepEqual(card.rawResult, before);
    assert.equal(project.usage.qlooHttpAttempts, 0);
  } finally { await runtime.dispose(); }
});

test('project reader returns exact JSON types and rejects cross-project, prototype and URL paths without mutations', () => {
  const project = makeProject();
  const card = recordEvidence(project, 'describe', { entity: 'Synthetic' }, { result: { status: 'ok',
    results: [{ entity_id: 'entity', properties: { description: 'Complete exact description', count: 0, active: false, missing: null } }] } });
  const other = makeProject(); other.evidence = [structuredClone(card)];
  const before = structuredClone(project);
  for (const [field, value] of [['properties.description', 'Complete exact description'], ['properties.count', 0], ['properties.active', false], ['properties.missing', null]]) {
    const read = readProjectEvidence(project, { evidenceId: card.id, entityId: 'entity', field });
    assert.equal(read.status, 'ok'); assert.equal(read.exact, true); assert.deepEqual(read.value, value);
  }
  for (const field of ['__proto__.name', 'properties.constructor', 'https://example.invalid', '../secret'])
    assert.equal(readProjectEvidence(project, { evidenceId: card.id, entityId: 'entity', field }).status, 'invalid_path');
  assert.equal(readProjectEvidence(other, { evidenceId: card.id, entityId: 'entity', field: 'properties.description' }).status, 'missing');
  assert.equal(readProjectEvidence(project, { evidenceId: card.id, entityId: 'missing', field: 'properties.description' }).status, 'missing');
  assert.equal(readProjectEvidence(project, { evidenceId: card.id, field: 'properties.description' }).status, 'invalid_input');
  assert.equal(readProjectEvidence(project, { evidenceId: card.id, entityId: 'entity' }).status, 'invalid_input');
  assert.deepEqual(project, before);
});

test('stored raw details and historical usage are excluded from prestream estimate but final payload additions count', () => {
  const content = [{ type: 'text', text: 'bounded view' }];
  const context = { systemPrompt: 'system', tools: [{ name: 'tool', description: 'tool', parameters: { type: 'object' } }],
    messages: [{ role: 'toolResult', content, toolCallId: 'call', toolName: 'tool', details: { raw: 'raw '.repeat(100000) }, usage: { totalTokens: 900000 } }] };
  const compact = { ...context, messages: context.messages.map(({ details, usage, ...message }) => message) };
  assert.deepEqual(requestBudget(context, model), requestBudget(compact, model));
  const final = { model: 'synthetic', messages: [{ role: 'user', content: 'small' }], tools: [], max_tokens: 12000,
    unexpectedWrapper: 'late injected data '.repeat(10000) };
  assert.equal(requestBudget(final, model).fits, false);
  assert(requestBudget(final, model).components.wrappers > 32000);
});

test('bounded exact-field reads and corrected references reach the actual proposal executor through continuous official dispatch', async t => {
  const project = makeProject(); cleanup(t, project);
  const card = recordEvidence(project, 'describe', { entity: 'Synthetic' }, { result: { status: 'ok',
    results: [{ entity_id: 'exact-entity', properties: { description: 'Synthetic material observation reference.' } }] } });
  const beforeEvidence = structuredClone(project.evidence);
  const contexts = [];
  let round = 0;
  const runtime = await createProductRuntime(project, { env: {}, decide(context) {
    contexts.push(context); round++;
    if (round <= 2) return [{ type: 'toolCall', id: `read-${round}`, name: 'read_project_evidence', arguments: round === 1
      ? { evidenceId: card.id } : { evidenceId: card.id, entityId: 'exact-entity', field: 'properties.description' } }];
    const link = { evidenceId: card.id, entityId: 'exact-entity', observedField: round === 3 ? 'properties.wrong' : 'properties.description',
      observedValue: card.returnedEntities[0].properties.description, observation: 'Synthetic exact observation', inspiration: 'Synthetic design inference; effects unknown' };
    return [{ type: 'toolCall', id: `proposal-${round}`, name: 'propose_design_response', arguments: { baseVersion: project.version,
      phase: 'ready', summary: 'Synthetic bounded dispatch proposal', concepts: ['one', 'two'].map(id => ({ id, title: id,
        coreClaim: '触摸样本并记录观察', mechanism: { organization: id, description: '触摸样本并记录观察' },
        journey: ['到场', '参与', '带走'].map(stage => ({ stage, action: '触摸样本并记录观察' })), productTouchpoints: ['触摸样本'],
        evidenceLinks: [link], openQuestions: ['容量未知'], unverifiedEffects: ['效果未知'] })) } }];
  } });
  try {
    await runtime.submit('Synthetic continuous tool dispatch');
    assert.equal(round, 4); assert.equal(project.version, 2); assert.equal(project.concepts.length, 2);
    assert(contexts.every(context => context.messages.length <= 3));
    assert.equal(contexts[3].messages.at(-1).details.feedback.code, 'EVIDENCE_FIELD_MISSING');
    assert(project.actions.some(action => action.type === 'proposal'));
    assert.deepEqual(project.evidence, beforeEvidence);
    assert.equal(project.usage.modelHttpAttempts, 0); assert.equal(project.usage.qlooHttpAttempts, 0);
  } finally { await runtime.dispose(); }
});
