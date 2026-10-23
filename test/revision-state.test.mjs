import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, selectConcept, beginRevision, proposeRevision, decideRevision } from '../app/state.mjs';

export function revisionProject() {
  const project = createProject({ brief: { request: '离线局部修改测试', mustKeep: ['试穿'], references: ['合成音乐'], venue: '室内' } });
  project.status = { phase: 'ready', detail: '已确认的测试方案' };
  project.concepts = ['a', 'b'].map(id => ({ id, title: `概念${id}`, coreClaim: '共同完成试穿',
    mechanism: { organization: `scheduled-${id}`, description: '按场次组织试穿任务' },
    journey: [{ stage: '为什么来', action: '参加试穿' }, { stage: '参与', action: '完成试穿任务' }, { stage: '带走', action: '体验记录' }],
    productTouchpoints: ['试穿'], evidenceLinks: [{ evidenceId: 'historical-invalid', observation: '历史记录保留，不复验' }],
    openQuestions: [], unverifiedEffects: ['效果待验证'] }));
  project.evidence = [{ id: 'evidence', projectId: project.id, query: { workflow: 'describe' },
    returnedEntities: [{ entity_id: 'artist', properties: { description: '合成音乐描述：同步节奏' }, affinity: 0.42 }] }];
  selectConcept(project, { conceptId: 'a', baseVersion: 1 });
  return project;
}
export const descriptionRef = () => ({ evidenceId: 'evidence', entityId: 'artist', observedField: 'properties.description',
  observedValue: '合成音乐描述：同步节奏', observation: '模型文字不能替代实际返回', inspiration: '设计推断：将共同节奏转为双人动作' });
export function revisionInput(request, fields = [{ field: 'mechanism', after: { organization: 'pairs', description: '双人协作试穿，45分钟一轮' } }]) {
  return { requestId: request.id, phase: 'pending', summary: '离线测试局部修改，效果未验证',
    changes: fields.map(change => ({ ...change, reason: '客户要求与设计推断', evidenceRefs: [descriptionRef()] })),
    impact: ['参与组织改变'], unknowns: ['人数与执行条件待确认'] };
}

test('localized revision stores authoritative before and keeps confirmed concepts and historical links untouched until accept', () => {
  const project = revisionProject();
  const before = structuredClone(project.concepts);
  const evidence = structuredClone(project.evidence);
  const request = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '改为双人参与' });
  const pending = proposeRevision(project, revisionInput(request));
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.changes[0].before, before[0].mechanism);
  assert.match(pending.changes[0].evidenceRefs[0].observation, /Returned.*同步节奏/);
  assert.equal(pending.changes[0].evidenceRefs[0].basis, 'description');
  assert.deepEqual(project.concepts, before);
  assert.deepEqual(project.evidence, evidence);
  assert.equal(project.version, 1);
  decideRevision(project, pending.id, 'accept', { baseVersion: 1 });
  assert.equal(project.version, 2);
  assert.equal(project.concepts[0].mechanism.organization, 'pairs');
  assert.deepEqual(project.concepts[0].evidenceLinks, before[0].evidenceLinks);
  assert.deepEqual(project.concepts[1], before[1]);
  assert.deepEqual(project.evidence, evidence);
  assert.equal(project.versionHistory.at(-1).version, 2);
  assert.throws(() => decideRevision(project, pending.id, 'accept', { baseVersion: 2 }), /已处理/);
});

test('reject leaves confirmed version and both concepts unchanged', () => {
  const project = revisionProject();
  const before = structuredClone(project.concepts);
  const request = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '不同的反馈' });
  const pending = proposeRevision(project, revisionInput(request));
  decideRevision(project, pending.id, 'reject', { baseVersion: 1 });
  assert.equal(project.version, 1);
  assert.deepEqual(project.concepts, before);
  assert.equal(project.revisions[0].status, 'rejected');
});

test('server rejects target, stale binding, unauthorized fields and nonexistent or fabricated evidence atomically', () => {
  for (const mutate of [
    input => { input.targetConceptId = 'b'; }, input => { input.projectId = 'other'; },
    input => { input.baseVersion = 1; }, input => { input.changes[0].before = { injected: true }; },
    input => { input.changes[0].field = 'concepts'; }, input => { input.changes[0].evidenceRefs[0].evidenceId = 'missing'; },
    input => { input.changes[0].evidenceRefs[0].observedValue = '伪造描述'; },
    input => { input.changes[0].evidenceRefs[0].observedField = 'missing'; },
    input => { input.changes[0].evidenceRefs[0].basis = 'affinity'; },
  ]) {
    const project = revisionProject();
    const request = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '客户任意反馈' });
    const input = revisionInput(request); mutate(input);
    const before = structuredClone(project);
    assert.throws(() => proposeRevision(project, input));
    assert.deepEqual(project, before);
  }
  const project = revisionProject();
  assert.throws(() => beginRevision(project, { conceptId: 'b', baseVersion: 1, text: '不应跨目标' }), /选中/);
  assert.throws(() => beginRevision(project, { conceptId: 'a', baseVersion: 0, text: '过期' }), /过期/);
});

test('pending and running requests reject old-client replacement and selection changes atomically', () => {
  const project = revisionProject();
  const request = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '第一种局部改法' });
  const running = structuredClone(project);
  assert.throws(() => beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '运行中替换' }), /仍在处理/);
  assert.deepEqual(project, running);
  const first = proposeRevision(project, revisionInput(request));
  const pending = structuredClone(project);
  assert.throws(() => beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '另一个旧页面提交' }), /待审/);
  assert.throws(() => selectConcept(project, { conceptId: 'b', baseVersion: 1 }), /待审/);
  assert.deepEqual(project, pending);
  assert.equal(project.revisions.length, 1); assert.equal(project.revisions[0].id, first.id);
});

test('legacy stale pending can be explicitly rejected despite changed selection or malformed old changes', () => {
  const project = revisionProject();
  const request = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '旧待审修改' });
  const revision = proposeRevision(project, revisionInput(request));
  project.version = 2; project.selectedConceptId = 'missing-old-selection';
  revision.changes = [{ field: '__proto__', before: '旧损坏内容', after: '不应执行' }];
  const before = structuredClone(project);
  assert.throws(() => decideRevision(project, revision.id, 'accept', { baseVersion: 1 }), /过期/);
  assert.deepEqual(project, before);
  decideRevision(project, revision.id, 'reject', { baseVersion: 1 });
  assert.equal(revision.status, 'rejected'); assert.equal(typeof revision.decidedAt, 'string');
  assert.equal(project.status.phase, 'ready'); assert.match(project.status.detail, /已拒绝/);
  delete revision.decidedAt; revision.status = 'pending';
  assert.deepEqual({ ...project, status: before.status }, before, 'reject changes only decision/status metadata, never selection, concepts, version or history');
});

test('reject retains another pending headline or running-request status', () => {
  const project = revisionProject();
  const request = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '旧待审修改' });
  const first = proposeRevision(project, revisionInput(request));
  const second = { ...structuredClone(first), id: 'legacy-second-pending' };
  project.revisions.push(second);
  const pendingStatus = structuredClone(project.status);
  decideRevision(project, first.id, 'reject', { baseVersion: 1 });
  assert.deepEqual(project.status, pendingStatus); assert.equal(project.status.phase, 'revision_pending');
  project.revisionRequest.status = 'running'; project.status = { phase: 'busy', detail: '仍在处理' };
  const busyStatus = structuredClone(project.status);
  decideRevision(project, second.id, 'reject', { baseVersion: 1 });
  assert.deepEqual(project.status, busyStatus); assert.equal(project.version, 1);
});

test('clarification and conflict preserve arbitrary feedback and leave confirmed state intact', () => {
  for (const phase of ['needs_input', 'conflict']) {
    const project = revisionProject(); const before = structuredClone(project.concepts);
    const request = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '任意反馈：必须改变但还不清楚' });
    proposeRevision(project, { requestId: request.id, phase, summary: '关键条件待确认', question: '请明确参与者是否同时到场？', changes: [], impact: [], unknowns: ['参与条件未知'] });
    assert.equal(project.revisionRequest.status, phase);
    assert.deepEqual(project.concepts, before);
    assert.equal(project.revisions.length, 0);
    assert.equal(project.version, 1);
  }
});
