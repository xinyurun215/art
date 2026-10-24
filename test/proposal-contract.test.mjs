import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../app/state.mjs';
import { createProductRuntime, recordEvidence } from '../app/runtime.mjs';

const brief = { request: '合成品牌快闪测试', venue: '室内', references: ['合成参考'] };
const proposal = project => ({ baseVersion: project.version, phase: 'needs_input',
  summary: '先确认预算', questions: [{ field: 'budget', text: '预算范围是多少？' }], concepts: [] });
function readyProposal(project, questions) {
  const card = project.evidence[0];
  const entity = card.returnedEntities[0];
  const concept = (id, organization) => ({ id, title: id, coreClaim: `${organization}完成试穿体验`,
    mechanism: { organization, description: `${organization}组织参与` },
    journey: [{ stage: '到场', action: '领取任务' }, { stage: '参与', action: '完成试穿体验' }, { stage: '离开', action: '带走记录' }],
    productTouchpoints: ['试穿体验'], evidenceLinks: [{ evidenceId: card.id, entityId: entity.id,
      observedField: 'properties.description', observedValue: entity.properties.description,
      observation: '合成返回字段仅用于测试', inspiration: '推导参与组织，仅为合成测试' }],
    openQuestions: [], unverifiedEffects: ['效果未验证'] });
  return { baseVersion: project.version, phase: 'ready', summary: '合成数据上的两种讨论草案',
    ...(questions === undefined ? {} : { questions }), concepts: [concept('a', 'scheduled'), concept('b', 'self_paced')] };
}
function withEvidence() {
  const project = createProject({ brief });
  recordEvidence(project, 'describe', { entity: '合成参考', type: 'artist' }, { correlationId: 'local-only',
    result: { status: 'ok', results: [{ id: 'entity', properties: { description: '合成描述' } }] } });
  return project;
}

async function dispatch(input, project = createProject({ brief })) {
  let observed;
  const runtime = await createProductRuntime(project, { env: {}, decide(context) {
    const result = context.messages.findLast(message => message.role === 'toolResult');
    if (!result) {
      const args = input(project);
      return [{ type: 'toolCall', id: 'proposal-case', name: 'propose_design_response', arguments: args }];
    }
    observed = JSON.parse(result.content.find(part => part.type === 'text').text);
    return [{ type: 'text', text: '合成测试结束' }];
  } });
  try { await runtime.submit(brief.request); return { project, observed, runtime }; }
  finally { await runtime.dispose(); }
}

test('proposal model schema omits projectId and allows omitted questions', async () => {
  const project = createProject({ brief });
  const runtime = await createProductRuntime(project, { env: {} });
  try {
    const schema = runtime.session.getToolDefinition('propose_design_response').parameters;
    assert.equal(Object.hasOwn(schema.properties, 'projectId'), false);
    assert.equal(schema.required.includes('questions'), false);
    assert.equal(schema.properties.questions.items.additionalProperties, false);
  } finally { await runtime.dispose(); }
});

test('dispatcher binds project ID and accepts one structured clarification', async () => {
  const { project } = await dispatch(proposal);
  assert.equal(project.version, 2, JSON.stringify({ feedback: project.runtime.feedback, actions: project.actions, observed: project.status }));
  assert.equal(project.status.phase, 'needs_input');
  assert.equal(project.questions[0].field, 'budget');
});

test('ready proposal accepts omitted or empty questions through official dispatcher', async () => {
  for (const questions of [undefined, []]) {
    const { project } = await dispatch(p => readyProposal(p, questions), withEvidence());
    assert.equal(project.version, 2);
    assert.equal(project.status.phase, 'ready');
    assert.deepEqual(project.questions, []);
    assert.equal(project.concepts.length, 2);
  }
});

test('changing organization and other labels cannot disguise identical participation, journey and product contact', async () => {
  for (const reorderJourneyKeys of [false, true]) {
    const { project, observed } = await dispatch(p => {
      const input = readyProposal(p, []), first = input.concepts[0];
      input.concepts[1] = { ...structuredClone(first), id: 'another-id', title: 'Another title', coreClaim: 'Another claim',
        mechanism: { ...first.mechanism, organization: 'a_different_label' },
        ...(reorderJourneyKeys ? { journey: first.journey.map(step => ({ action: step.action, stage: step.stage })) } : {}) };
      return input;
    }, withEvidence());
    assert.equal(project.version, 1, 'a rejected duplicate must not update the board');
    assert.equal(project.concepts.length, 0);
    assert.equal(observed.feedback.code, 'MECHANISMS_NOT_DISTINCT');
    assert.equal(observed.feedback.path, '/concepts');
    assert.match(observed.feedback.reason, /distinct participation/i);
  }
});

test('different group and self-paced mechanisms still pass the deterministic duplicate check', async () => {
  const { project } = await dispatch(p => {
    const input = readyProposal(p, []);
    input.concepts[0].mechanism.description = 'A scheduled group moves together and rotates through a staff-guided try-on.';
    input.concepts[1].mechanism.description = 'Each visitor independently chooses a task order and unlocks a story through their try-on notes.';
    input.concepts[1].journey[1].action = 'Choose a task alone and use the try-on note to unlock the next station';
    input.concepts[1].productTouchpoints = ['Individual try-on and personal product notes'];
    return input;
  }, withEvidence());
  assert.equal(project.status.phase, 'ready');
  assert.equal(project.version, 2);
  assert.equal(project.concepts.length, 2);
});

test('forged evidence reference is rejected without changing project', async () => {
  const { project, observed } = await dispatch(p => {
    const input = readyProposal(p, []);
    input.concepts[0].evidenceLinks[0].evidenceId = 'forged';
    return input;
  }, withEvidence());
  assert.equal(project.version, 1);
  assert.equal(project.concepts.length, 0);
  assert.equal(observed.feedback.code, 'EVIDENCE_REFERENCE_INVALID');
  assert.equal(observed.feedback.path, '/concepts/0/evidenceLinks/0/evidenceId');
  assert.equal(observed.feedback.expectedType, 'string');
});

test('evidence value rejection reports the stored field type without revealing either value', async () => {
  const { project, observed } = await dispatch(p => {
    const input = readyProposal(p, []);
    input.concepts[0].evidenceLinks[0].observedValue = 123;
    return input;
  }, withEvidence());
  assert.equal(project.version, 1);
  assert.equal(observed.feedback.code, 'EVIDENCE_VALUE_MISMATCH');
  assert.equal(observed.feedback.expectedType, 'string');
  assert.equal(observed.feedback.actualType, 'integer');
  assert.equal(JSON.stringify(observed.feedback).includes('合成描述'), false);
  assert.equal(JSON.stringify(observed.feedback).includes('123'), false);
});

test('dispatcher rejects malformed clarification with typed, value-free feedback that survives refresh', async () => {
  for (const [questions, path, state, expectedType] of [
    [undefined, '/questions', 'missing', 'array'], [[], '/questions', 'empty', 'array'], [null, '/questions', 'null', 'array'],
    [['DO_NOT_ECHO_SECRET'], '/questions/0', 'present', 'object'],
    [[null], '/questions/0', 'null', 'object'],
    [[{ field: 'unknown', text: 'DO_NOT_ECHO_SECRET' }], '/questions/0/field', 'present', 'string'],
    [[{ field: 'budget', text: '' }], '/questions/0/text', 'empty', 'string'],
    [[{ field: 'budget', text: '问题', id: 'DO_NOT_ECHO_SECRET' }], '/questions/0', 'present', 'absent'],
  ]) {
    const { project, observed } = await dispatch(p => {
      const input = proposal(p);
      if (questions === undefined) delete input.questions;
      else input.questions = questions;
      return input;
    });
    assert.equal(project.version, 1);
    assert.equal(project.runtime.feedback?.path, path, JSON.stringify({ project: project.status, actions: project.actions, observed }));
    assert.equal(project.runtime.feedback.valueState, state, JSON.stringify({ questions, feedback: project.runtime.feedback, observed, actions: project.actions }));
    assert.equal(project.runtime.feedback.expectedType, expectedType);
    assert.equal(typeof project.runtime.feedback.actualType, 'string');
    assert.equal(observed.feedback.valueState, state);
    assert.equal(JSON.stringify(project.runtime.feedback).includes('DO_NOT_ECHO_SECRET'), false);
    assert.equal(JSON.stringify(project.actions).includes('DO_NOT_ECHO_SECRET'), false);
  }
});

test('injected projectId is rejected and cannot modify either project', async () => {
  const first = createProject({ brief });
  const second = createProject({ brief });
  const { observed } = await dispatch(p => ({ ...proposal(p), projectId: second.id }), first);
  assert.equal(first.version, 1);
  assert.equal(second.version, 1);
  assert.equal(observed.feedback.code, 'PROPOSAL_SCHEMA_INVALID');
  assert.equal(observed.feedback.path, '/projectId');
  assert.equal(JSON.stringify(first.runtime.feedback).includes(second.id), false);
});

test('direct tool execution enforces model schema without framework preflight', async () => {
  const first = createProject({ brief });
  const second = createProject({ brief });
  const runtime = await createProductRuntime(first, { env: {} });
  try {
    const tool = runtime.session.getToolDefinition('propose_design_response');
    const result = await tool.execute('direct', { ...proposal(first), projectId: second.id });
    assert.equal(result.details.accepted, false);
    assert.equal(result.details.feedback.code, 'PROPOSAL_SCHEMA_INVALID');
    assert.equal(first.version, 1);
    assert.equal(second.version, 1);
  } finally { await runtime.dispose(); }
});
