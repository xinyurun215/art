import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createProject, applyProposal, selectConcept, beginRevision, beginPendingFeedback, proposeRevision, decideRevision } from '../app/state.mjs';

// New synthetic inputs for the validator, not a reconstruction of the lost live proposal.
const avoid = ['现场表演', '强制注册', '强制购买'];
function fixture(brief = {}) {
  const project = createProject({ brief: { request: '本地雨格禁用项测试', mustKeep: ['试握', '开合'], avoid, ...brief } });
  const contact = project.brief.mustKeep.join('和');
  const concepts = ['scheduled', 'self_paced'].map(id => ({ id, title: id, coreClaim: '体验产品',
    mechanism: { organization: id, description: '自主完成产品体验' },
    journey: [{ stage: '到场', action: '领取任务卡' }, { stage: '参与', action: contact },
      { stage: '离开', action: '带走体验记录' }],
    productTouchpoints: [contact], evidenceLinks: [], openQuestions: [], unverifiedEffects: ['效果未验证'] }));
  return { project, proposal: { projectId: project.id, baseVersion: project.version, phase: 'insufficient_evidence',
    summary: '仅供本地校验的无证据草案', concepts } };
}
const fields = [
  ['coreClaim', (c, text) => { c.coreClaim = text; }],
  ['mechanism/description', (c, text) => { c.mechanism.description = text; }],
  ['journey/1/action', (c, text) => { c.journey[1].action = text; }],
  ['productTouchpoints/1', (c, text) => { c.productTouchpoints.push(text); }],
];
function rejectsWithoutMutation(project, run, path, item) {
  const before = structuredClone(project);
  assert.throws(run, error => {
    assert.equal(error.feedback.code, 'FORBIDDEN_ITEM_PRESENT');
    assert.equal(error.feedback.path, path);
    assert(error.feedback.reason.includes(`/brief/avoid/${project.brief.avoid.indexOf(item)}`));
    assert(error.feedback.reason.includes(item));
    assert.equal(error.feedback.reason.includes('PRIVATE_CANDIDATE_TEXT'), false);
    return true;
  });
  assert.deepEqual(project, before);
}

test('standalone explicit exclusions are not active forbidden activities in any checked field', () => {
  for (const exclusion of ['不安排现场表演。', '不强制注册', '不强制购买', '禁止现场表演']) {
    for (const [, set] of fields) {
      const { project, proposal } = fixture();
      set(proposal.concepts[1], exclusion);
      assert.doesNotThrow(() => applyProposal(project, proposal), exclusion);
    }
  }
});

test('each positive forbidden item reports its exact field and constraint without saving candidate text', () => {
  for (const item of avoid) for (const [field, set] of fields) {
    const { project, proposal } = fixture();
    set(proposal.concepts[1], `PRIVATE_CANDIDATE_TEXT：安排${item}`);
    rejectsWithoutMutation(project, () => applyProposal(project, proposal), `/concepts/1/${field}`, item);
  }
});

test('negated mentions cannot hide positives, double negation, exceptions or quoted labels', () => {
  for (const text of ['不取消现场表演', '并非不安排现场表演', '不得不强制注册',
    '不强制购买，但强制注册', '不安排现场表演，但VIP除外', '不安排现场表演。上述限制不适用。',
    '“不安排现场表演”主题活动', '非现场表演', '不安排现场表演，并安排现场表演']) {
    const { project, proposal } = fixture();
    proposal.concepts[1].mechanism.description = text;
    assert.throws(() => applyProposal(project, proposal), error => error.feedback.code === 'FORBIDDEN_ITEM_PRESENT', text);
  }
  const { project, proposal } = fixture();
  proposal.concepts[1].coreClaim = '不安排现场表演';
  proposal.concepts[1].journey[2].action = '安排现场表演';
  rejectsWithoutMutation(project, () => applyProposal(project, proposal), '/concepts/1/journey/2/action', avoid[0]);
});

test('forbidden strings do not span unrelated fields but still match inside a single field', () => {
  const { project, proposal } = fixture();
  project.brief.avoid = ['任务 卡'];
  proposal.concepts[1].coreClaim = '领取任务';
  proposal.concepts[1].mechanism.description = '卡片记录体验';
  assert.doesNotThrow(() => applyProposal(project, proposal));
  const other = fixture(); other.project.brief.avoid = ['任务 卡'];
  other.proposal.concepts[1].coreClaim = '领取任务 卡片记录体验';
  assert.throws(() => applyProposal(other.project, other.proposal), error => error.feedback.code === 'FORBIDDEN_ITEM_PRESENT');
});

test('required product contact remains mandatory', () => {
  const { project, proposal } = fixture();
  proposal.concepts[1].journey[1].action = '不强制购买';
  proposal.concepts[1].productTouchpoints = ['不强制注册'];
  assert.throws(() => applyProposal(project, proposal), error => error.feedback.code === 'REQUIRED_ITEM_MISSING');
});

const scenarios = [
  { request: '耳机试听快闪：禁止采集手机号和扫码关注，保留试听', mustKeep: ['试听'], avoid: ['采集手机号', '扫码关注'] },
  { request: '儿童用品体验：禁止酒精饮品，保留试用', mustKeep: ['试用'], avoid: ['酒精饮品'] },
  { request: '室内灯具体验：禁止烟雾装置，保留亮度调节', mustKeep: ['亮度调节'], avoid: ['烟雾装置'] },
];

test('representative briefs enforce explicit bans and contradictory activities across the same concept', () => {
  for (const brief of scenarios) for (const item of brief.avoid) {
    const { project, proposal } = fixture(brief);
    proposal.concepts[1].mechanism.description = `禁止${item}。`;
    proposal.concepts[1].journey[0].action = `体验前安排${item}`;
    rejectsWithoutMutation(project, () => applyProposal(project, proposal), '/concepts/1/journey/0/action', item);
    proposal.concepts[1].journey[0].action = '领取匿名体验卡';
    assert.doesNotThrow(() => applyProposal(project, proposal));
    assert.deepEqual(project.brief.avoid, brief.avoid);
  }
});

test('ordinary compound denials and exceptions remain explicit literal-check limitations', () => {
  for (const text of ['不采集手机号，体验卡现场自取', '不采集手机号。仅用匿名编号。',
    '无需扫码关注即可试听', '不安排采集手机号，但抽奖参与者除外']) {
    const { project, proposal } = fixture(scenarios[0]);
    proposal.concepts[1].mechanism.description = text;
    const item = text.includes('采集手机号') ? '采集手机号' : '扫码关注';
    rejectsWithoutMutation(project, () => applyProposal(project, proposal), '/concepts/1/mechanism/description', item);
  }
});

test('accepting or rejecting a revision preserves the original ban for subsequent edits in different projects', () => {
  for (const brief of scenarios) for (const decision of ['accept', 'reject']) {
    const { project, proposal } = fixture(brief);
    const item = brief.avoid[0];
    proposal.concepts[1].mechanism.description = `不安排${item}`;
    applyProposal(project, proposal);
    selectConcept(project, { conceptId: 'self_paced', baseVersion: project.version });
    const before = structuredClone(project.concepts), version = project.version;
    const request = beginRevision(project, { conceptId: 'self_paced', baseVersion: version, text: '调整参与方式，原限制不变' });
    const input = { requestId: request.id, phase: 'pending', summary: '本地代表场景修改',
      changes: [{ field: 'coreClaim', after: `安排${item}`, reason: '检验原约束', evidenceRefs: [] }],
      impact: [], unknowns: ['效果未验证'] };
    rejectsWithoutMutation(project, () => proposeRevision(project, input), '/changes/0/after', item);
    input.changes[0].after = '按自己的节奏体验产品';
    const pending = proposeRevision(project, input);
    assert.deepEqual(project.concepts, before, 'approval remains necessary');
    decideRevision(project, pending.id, decision, { baseVersion: version });
    assert.equal(project.version, decision === 'accept' ? version + 1 : version);
    assert.equal(project.concepts[1].coreClaim, decision === 'accept' ? input.changes[0].after : before[1].coreClaim);
    assert.deepEqual(project.brief.avoid, brief.avoid);
    const next = beginRevision(project, { conceptId: 'self_paced', baseVersion: project.version, text: '下一次修改' });
    input.requestId = next.id; input.changes[0].after = `安排${item}`;
    rejectsWithoutMutation(project, () => proposeRevision(project, input), '/changes/0/after', item);
  }
});

function revisionFixture(field, after) {
  const { project, proposal } = fixture();
  applyProposal(project, proposal);
  selectConcept(project, { conceptId: 'self_paced', baseVersion: project.version });
  const request = beginRevision(project, { conceptId: 'self_paced', baseVersion: project.version, text: '本地修订测试' });
  return { project, input: { requestId: request.id, phase: 'pending', summary: '本地修订',
    changes: [{ field, after, reason: '测试禁用项', evidenceRefs: [] }], impact: [], unknowns: ['效果未验证'] } };
}

test('revision uses the same rule and reports the changed field while leaving confirmed state intact', () => {
  for (const text of ['不安排现场表演', '不强制注册', '不强制购买']) {
    const { project, input } = revisionFixture('coreClaim', text);
    const before = structuredClone(project.concepts);
    assert.equal(proposeRevision(project, input).status, 'pending');
    assert.deepEqual(project.concepts, before);
  }
  for (const [field, set] of fields) {
    const { project, input } = revisionFixture('coreClaim', '占位');
    const candidate = structuredClone(project.concepts[1]); set(candidate, '安排现场表演');
    const topField = field.split('/')[0];
    input.changes[0] = { ...input.changes[0], field: topField, after: candidate[topField] };
    const suffix = field.slice(topField.length);
    rejectsWithoutMutation(project, () => proposeRevision(project, input), `/changes/0/after${suffix}`, avoid[0]);
  }
  const { project, input } = revisionFixture('coreClaim', '不安排现场表演');
  project.concepts[1].journey[2].action = '安排现场表演';
  rejectsWithoutMutation(project, () => proposeRevision(project, input), '/concepts/1/journey/2/action', avoid[0]);
});

test('feedback on a pending revision still checks unchanged draft fields against current constraints', () => {
  const { project, input } = revisionFixture('coreClaim', '安排现场表演');
  project.brief.avoid = [];
  const pending = proposeRevision(project, input);
  project.brief.avoid = [...avoid];
  const request = beginPendingFeedback(project, pending.id, { baseVersion: project.version, text: '调整标题' });
  input.requestId = request.id;
  input.changes = [{ field: 'title', after: '新的合成标题', reason: '本地测试', evidenceRefs: [] }];
  rejectsWithoutMutation(project, () => proposeRevision(project, input), '/revisions/0/changes/0/after', avoid[0]);
});

test('offline dispatcher returns and retains exact forbidden diagnostics without retaining rejected prose', async () => {
  const { createProductRuntime } = await import('../app/runtime.mjs');
  const { withoutNetwork } = await import('../app/transport.mjs');
  const { project, proposal } = fixture();
  proposal.concepts[1].journey[2].action = 'PRIVATE_CANDIDATE_TEXT：安排强制购买';
  delete proposal.projectId;
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'art-forbidden-test-'));
  let runtime, observed;
  try {
    runtime = await createProductRuntime(project, { env: {}, memorySession: true, runtimeRoot, decide(context) {
      const result = context.messages.findLast(message => message.role === 'toolResult');
      if (!result) return [{ type: 'toolCall', id: 'forbidden-test', name: 'propose_design_response', arguments: proposal }];
      observed = JSON.parse(result.content.find(part => part.type === 'text').text);
      return [{ type: 'text', text: '本地测试结束' }];
    } });
    await withoutNetwork(project, () => runtime.submit(project.brief.request));
    const feedback = project.actions.find(item => item.toolCallId === 'forbidden-test').feedback;
    assert.equal(observed.feedback.path, '/concepts/1/journey/2/action');
    assert.equal(observed.feedback.code, 'FORBIDDEN_ITEM_PRESENT');
    assert.match(feedback.reason, /\/brief\/avoid\/2.*强制购买/);
    assert.equal(feedback.reason, observed.feedback.reason);
    assert.equal(project.runtime.feedback.path, observed.feedback.path);
    assert.equal(project.concepts.length, 0);
    assert.equal(project.version, 1);
    assert.equal(project.usage.modelHttpAttempts, 0);
    assert.equal(project.usage.qlooHttpAttempts, 0);
    assert.equal(JSON.stringify(project).includes('PRIVATE_CANDIDATE_TEXT'), false);
  } finally {
    await runtime?.dispose();
    assert.equal(dirname(resolve(runtimeRoot)), resolve(tmpdir()));
    assert(runtimeRoot.startsWith(join(tmpdir(), 'art-forbidden-test-')));
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
