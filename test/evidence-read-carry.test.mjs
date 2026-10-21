import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, evidenceView, readProjectEvidence, requestBudget } from '../app/context.mjs';
import { applyProposal, createProject } from '../app/state.mjs';

const text = message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');
const work = messages => JSON.parse(text(messages[0])).project;
const entries = messages => work(messages).evidenceReads?.entries ?? [];
const snapshot = project => ({ id: project.id, version: project.version, brief: project.brief, evidence: project.evidence.map(card => evidenceView(card)) });
const start = project => ({ role: 'user', content: JSON.stringify({ project: snapshot(project), message: 'Synthetic current task' }) });
function project(count = 3, value = index => `Synthetic exact field ${index}`) {
  return { id: 'synthetic-project', version: 3, brief: { request: 'Keep complete original task', mustKeep: ['Keep the product interaction'] },
    evidence: [{ id: 'synthetic-card', projectId: 'synthetic-project', query: { workflow: 'describe' },
      returnedEntities: Array.from({ length: count }, (_, index) => ({ entity_id: `entity-${index}`, properties: { description: value(index) } })) }] };
}
function read(messages, project, index, id = `read-${messages.length}`, override) {
  const args = { evidenceId: 'synthetic-card', entityId: `entity-${index}`, field: 'properties.description' };
  const result = override ?? readProjectEvidence(project, args);
  messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'SYNTHETIC_OPAQUE_PROTOCOL' },
    { type: 'toolCall', id, name: 'read_project_evidence', arguments: args }], stopReason: 'toolUse' },
  { role: 'toolResult', toolCallId: id, toolName: 'read_project_evidence', content: [{ type: 'text', text: JSON.stringify(result) }] });
}
function other(messages, id = 'other') {
  messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'qloo_recommend', arguments: {} }], stopReason: 'toolUse' },
    { role: 'toolResult', toolCallId: id, toolName: 'qloo_recommend', content: [{ type: 'text', text: '{"status":"ok","results":[]}' }] });
}

test('exact read values survive later tool batches without replaying old protocol', () => {
  const source = project();
  const messages = [start(source)];
  read(messages, source, 0, 'first-exact-read');
  assert.equal(entries(assembleContext(messages, snapshot(source))).length, 0, 'latest paired result is already visible');
  read(messages, source, 1, 'second-exact-read');
  const before = structuredClone(messages), beforeProject = structuredClone(source);
  const view = assembleContext(messages, snapshot(source));
  assert.deepEqual(entries(view), [{ evidenceId: 'synthetic-card', entityId: 'entity-0', field: 'properties.description',
    value: 'Synthetic exact field 0', sourceCallId: 'first-exact-read' }]);
  assert.equal(view.length, 3);
  assert.equal(view[1].content.find(block => block.type === 'toolCall').id, 'second-exact-read');
  assert.deepEqual(work(view).brief, source.brief);
  other(messages);
  assert.equal(entries(assembleContext(messages, snapshot(source))).length, 2);
  assert.deepEqual(messages.slice(0, before.length), before);
  assert.deepEqual(source, beforeProject);
});

test('repeated reads deduplicate by exact path and keep the most recent source', () => {
  const source = project(); const messages = [start(source)];
  read(messages, source, 0, 'first'); read(messages, source, 1, 'second'); read(messages, source, 0, 'latest-first'); other(messages);
  const saved = entries(assembleContext(messages, snapshot(source)));
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(item => item.sourceCallId), ['second', 'latest-first']);
  assert.equal(saved.filter(item => item.entityId === 'entity-0').length, 1);
});

test('carry is bounded, recent values win and capacity omission is explicit', () => {
  const source = project(12, index => `${index}:` + '合成字段'.repeat(220));
  const messages = [start(source)];
  for (let index = 0; index < 12; index++) read(messages, source, index, `field-${index}`);
  other(messages);
  const view = assembleContext(messages, snapshot(source));
  const carry = work(view).evidenceReads;
  assert(carry.entries.length > 0 && carry.entries.length < 12);
  assert.equal(carry.entries.at(-1).entityId, 'entity-11');
  assert.equal(carry.omitted, 12 - carry.entries.length);
  assert(JSON.stringify(carry).length <= 4096);
  assert(requestBudget({ systemPrompt: 'Synthetic system', messages: view, tools: [] }, { contextWindow: 32000, maxTokens: 12000 }).fits);
  assert.deepEqual(work(view).brief, source.brief);
});

test('new user, project ownership, changed version and missing current fields invalidate carry', () => {
  const source = project(); const messages = [start(source)]; read(messages, source, 0); other(messages);
  assert.equal(entries(assembleContext(messages, snapshot(source))).length, 1);
  assert.equal(entries(assembleContext([...messages, start(source)], snapshot(source))).length, 0);
  for (const change of [
    current => { current.id = 'another-project'; },
    current => { current.version++; },
    current => { current.evidence[0].projectId = 'another-project'; },
    current => { current.evidence = []; },
    current => { current.evidence[0].returnedEntities[0].propertyFields = []; },
  ]) {
    const current = snapshot(source); change(current);
    assert.equal(entries(assembleContext(messages, current)).length, 0);
  }
});

test('failed, mismatched, oversized and unpaired historical results are not carried', () => {
  const source = project();
  for (const result of [
    { status: 'missing', exact: false },
    { status: 'ok', exact: false, value: 'Preview' },
    { status: 'ok', exact: true, evidenceId: 'other-card', entityId: 'entity-0', field: 'properties.description', value: 'Wrong card' },
    { status: 'ok', exact: true, evidenceId: 'synthetic-card', entityId: 'entity-0', field: 'properties.description', value: 'x'.repeat(6001) },
  ]) {
    const messages = [start(source)]; read(messages, source, 0, 'bad', result); other(messages);
    assert.equal(entries(assembleContext(messages, snapshot(source))).length, 0);
  }
  const missing = [start(source)]; read(missing, source, 0, 'missing-pair'); missing.pop(); other(missing);
  assert.equal(entries(assembleContext(missing, snapshot(source))).length, 0);
  const duplicate = [start(source)]; read(duplicate, source, 0, 'duplicate-pair'); duplicate.push(structuredClone(duplicate.at(-1))); other(duplicate);
  assert.equal(entries(assembleContext(duplicate, snapshot(source))).length, 0);
});

test('latest incomplete tool batch continues to stop before model dispatch', () => {
  const source = project(); const messages = [start(source)]; read(messages, source, 0); messages.pop();
  assert.throws(() => assembleContext(messages, snapshot(source)), { code: 'MODEL_CONTEXT_PROTOCOL_INCOMPLETE' });
});

test('query leaves and falsey JSON values carry without widening the read contract', () => {
  const source = project(3, index => [null, false, 0][index]); const messages = [start(source)];
  for (let index = 0; index < 3; index++) read(messages, source, index);
  const whole = { evidenceId: 'synthetic-card', entityId: 'entity-0', field: 'properties' };
  messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'read-properties', name: 'read_project_evidence', arguments: whole }] },
    { role: 'toolResult', toolCallId: 'read-properties', toolName: 'read_project_evidence', content: [{ type: 'text', text: JSON.stringify(readProjectEvidence(source, whole)) }] });
  const args = { evidenceId: 'synthetic-card', field: 'query.workflow' }, id = 'read-query';
  messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read_project_evidence', arguments: args }] },
    { role: 'toolResult', toolCallId: id, toolName: 'read_project_evidence', content: [{ type: 'text', text: JSON.stringify(readProjectEvidence(source, args)) }] });
  other(messages);
  const carried = entries(assembleContext(messages, snapshot(source)));
  assert.deepEqual(carried.map(entry => entry.value), [null, false, 0, { description: null }, 'describe']);
  assert.equal(carried.at(-1).entityId, undefined);
  const before = structuredClone(source);
  assert.equal(readProjectEvidence(source, { evidenceId: 'synthetic-card', field: 'rawResult' }).status, 'invalid_input');
  assert.deepEqual(source, before);
});

test('carried values stay model views and cannot replace authoritative proposal evidence', () => {
  const source = createProject({ brief: { request: 'Synthetic proposal carry check', mustKeep: [] } });
  source.evidence = [{ id: 'synthetic-card', projectId: source.id, query: { workflow: 'describe' },
    returnedEntities: [{ entity_id: 'entity-0', properties: { description: 'Synthetic authoritative description' } }] }];
  const messages = [start(source)]; read(messages, source, 0, 'read-for-proposal'); other(messages);
  const carried = entries(assembleContext(messages, snapshot(source)))[0];
  const proposal = value => ({ projectId: source.id, baseVersion: source.version, phase: 'ready', summary: 'Synthetic local proposal test',
    concepts: ['one', 'two'].map(id => ({ id, title: id, coreClaim: 'Touch the synthetic product',
      mechanism: { organization: id, description: 'Touch the synthetic product' },
      journey: ['arrive', 'participate', 'leave'].map(stage => ({ stage, action: 'Touch the synthetic product' })),
      productTouchpoints: ['Touch the synthetic product'], openQuestions: [], unverifiedEffects: ['Unverified effects'],
      evidenceLinks: [{ evidenceId: carried.evidenceId, entityId: carried.entityId, observedField: carried.field, observedValue: value,
        observation: 'Synthetic actual field', inspiration: 'Synthetic inference only' }] })) });
  const before = structuredClone(source);
  assert.throws(() => applyProposal(source, proposal('Forged cached description')), error => error.feedback.code === 'EVIDENCE_VALUE_MISMATCH');
  assert.deepEqual(source, before);
  assert.equal(applyProposal(source, proposal(carried.value)).accepted, true);
  const otherProject = structuredClone(before); otherProject.id = 'different-project';
  assert.throws(() => applyProposal(otherProject, { ...proposal(carried.value), projectId: otherProject.id, baseVersion: otherProject.version }),
    error => error.feedback.code === 'EVIDENCE_REFERENCE_INVALID');
});
