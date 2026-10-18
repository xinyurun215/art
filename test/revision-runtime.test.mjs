import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createProject, selectConcept, beginRevision, applyProposal } from '../app/state.mjs';
import { createProductRuntime, REVISION_TOOL_NAMES } from '../app/runtime.mjs';
import { createAppServer } from '../app/server.mjs';

function fixtureProject() {
  const project = createProject({ brief: { request: '离线快闪项目', venue: '室内', mustKeep: ['试穿'] } });
  project.status = { phase: 'ready', detail: '初始正式内容' };
  project.concepts = ['a', 'b'].map(id => ({ id, title: id, coreClaim: '共同试穿体验',
    mechanism: { organization: id, description: '集体试穿' }, journey: [{ stage: '到场', action: '领取任务' },
      { stage: '参与', action: '完成试穿' }, { stage: '离开', action: '带走记录' }], productTouchpoints: ['试穿'],
    evidenceLinks: [{ evidenceId: 'historical-missing', observation: '错误历史引用保留原样' }], openQuestions: [], unverifiedEffects: ['效果未知'] }));
  project.evidence = [{ id: 'existing-description', projectId: project.id, query: { workflow: 'describe' },
    returnedEntities: [{ entity_id: 'real-shaped-id', affinity: 0.42, properties: { short_description: 'Actual saved description of a music duo.' } }] }];
  selectConcept(project, { conceptId: 'a', baseVersion: project.version });
  return project;
}
function local(port, method, path, input) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', value => { text += value; });
      response.on('end', () => resolve({ status: response.statusCode, ...JSON.parse(text) }));
    });
    req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function listen(app) { await new Promise(done => app.server.listen(0, '127.0.0.1', done)); return app.server.address().port; }
async function waitProject(port, id) {
  for (let i = 0; i < 150; i++) {
    const result = await local(port, 'GET', `/api/projects/${id}`);
    if (result.project.status.phase !== 'busy') return result.project;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('局部修改没有结束');
}

test('explicit offline pair fixture uses official tool executor, authoritative descriptions and zero external HTTP', async () => {
  const project = fixtureProject();
  project.concepts[0].productTouchpoints = ['真实上脚试穿新日常鞋款（每对一双轮换，含半码备用）',
    '鞋垫、鞋底分区剖面样块（可手压、可弯折对照）', '三段地面材质垫：硬地、薄毯、斜坡垫',
    '双人共写记录卡（四问＋互相订正栏）', '可选尺码对照卡，不做扫码与留资'];
  project.concepts[0].openQuestions = ['每对一双鞋轮换是否够用：需确认鞋款尺码分布与可试穿双数，本方案不假定库存',
    '双人配对是否需提前分组，参与意愿与记录质量未验证', '四问措辞待确认'];
  const before = structuredClone(project.concepts); const evidence = structuredClone(project.evidence);
  beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '这是任意输入，不作为固定回复触发词', offlineFixture: 'pair_45' });
  project.status.phase = 'busy';
  const runtime = await createProductRuntime(project, { env: {} });
  try {
    await runtime.submit(project.revisionRequest.text);
    assert.deepEqual(project.runtime.toolNames, REVISION_TOOL_NAMES);
    assert.equal(project.revisions.length, 1, JSON.stringify(project.runtime.feedback));
    assert.equal(project.revisions[0].synthetic, true);
    assert.equal(project.status.phase, 'revision_pending');
    assert.equal(project.version, 1); assert.deepEqual(project.concepts, before); assert.deepEqual(project.evidence, evidence);
    const toolResult = runtime.session.messages.findLast(message => message.role === 'toolResult');
    assert.equal(toolResult.toolName, 'propose_concept_revision');
    assert.equal(toolResult.isError, false);
    assert.equal(JSON.parse(toolResult.content[0].text).completed, true);
    const refs = project.revisions[0].changes.flatMap(change => change.evidenceRefs);
    assert(refs.length > 0); assert(refs.every(ref => ref.observedField === 'properties.short_description' && ref.basis === 'description'));
    assert.equal(project.usage.modelHttpAttempts, 0); assert.equal(project.usage.qlooHttpAttempts, 0);
    assert.equal(project.actions.filter(action => action.type === 'query').length, 0);
    const changes = project.revisions[0].changes;
    assert.deepEqual(changes.map(change => change.field).sort(), ['journey', 'mechanism', 'openQuestions', 'productTouchpoints']);
    const after = { ...before[0], ...Object.fromEntries(changes.map(change => [change.field, change.after])) };
    for (const field of ['title', 'coreClaim', 'evidenceLinks', 'unverifiedEffects']) assert.deepEqual(after[field], before[0][field]);
    assert.deepEqual(after.productTouchpoints.slice(1), before[0].productTouchpoints.slice(1));
    assert(after.productTouchpoints[0].startsWith('真实上脚试穿新日常鞋款（'));
    assert(after.openQuestions.includes(before[0].openQuestions[1])); assert(after.openQuestions.includes(before[0].openQuestions[2]));
    assert.deepEqual(after.journey.map(step => step.stage.match(/\d+–\d+分钟/)?.[0]), ['0–5分钟', '5–20分钟', '20–35分钟', '35–40分钟', '40–45分钟']);
    const allText = JSON.stringify(after);
    assert.match(allText, /各自.*尺码/); assert.match(allText, /至少15分钟/); assert.match(allText, /只换角色.*不换鞋/);
    assert.match(allText, /库存.*不足.*暂停/); assert.match(allText, /设计时间分配.*效果/);
    assert.equal(after.productTouchpoints.some(item => item.includes('每对一双轮换')), false);
    assert(refs.every(ref => !ref.inspiration.includes('文化数据证明尺码') && ref.inspiration.includes('不证明尺码')));
  } finally { await runtime.dispose(); }
});

test('default offline arbitrary feedback pauses honestly; explicit clarification/conflict/error keep official content unchanged', async () => {
  for (const offlineFixture of [undefined, 'needs_input', 'conflict', 'invalid_reference']) {
    const project = fixtureProject(); const before = structuredClone(project.concepts);
    beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '随意输入：取消排队并换为深夜访谈', offlineFixture });
    project.status.phase = 'busy'; const runtime = await createProductRuntime(project, { env: {} });
    try {
      await runtime.submit(project.revisionRequest.text);
      assert.deepEqual(project.concepts, before); assert.equal(project.version, 1); assert.equal(project.revisions.length, 0);
      assert.equal(project.revisionRequest.status, offlineFixture === 'conflict' ? 'conflict' : offlineFixture === 'invalid_reference' ? 'error' : 'needs_input');
      if (!offlineFixture) assert.match(project.status.detail, /不能解释任意反馈/);
      if (offlineFixture === 'invalid_reference') assert.equal(project.runtime.feedback.code, 'EVIDENCE_REFERENCE_INVALID');
    } finally { await runtime.dispose(); }
  }
});

test('model tool cannot choose identity, mutate whole concepts or query Qloo during a localized revision', async () => {
  const project = fixtureProject(); const before = structuredClone(project.concepts);
  const text = '完全不同的任意反馈，包含现场时间与参与方式';
  beginRevision(project, { conceptId: 'a', baseVersion: 1, text });
  let calls = 0; let seenInput;
  const runtime = await createProductRuntime(project, { env: {}, decide(context) {
    calls++; seenInput = context.messages.findLast(message => message.role === 'user').content[0].text;
    if (calls === 1) return [
      { type: 'toolCall', id: 'cross', name: 'propose_concept_revision', arguments: { projectId: 'other', concepts: [], phase: 'pending', changes: [], summary: 'illegal', impact: [], unknowns: [] } },
      { type: 'toolCall', id: 'whole', name: 'propose_design_response', arguments: {} },
      { type: 'toolCall', id: 'query', name: 'qloo_describe', arguments: { entity: 'should not query' } },
    ];
    return [{ type: 'text', text: '拒绝已收到' }];
  } });
  try {
    await runtime.submit(text);
    assert.equal(JSON.parse(seenInput).message, text); assert.equal(JSON.parse(seenInput).project.revisionRequest.text, text);
    const results = runtime.session.messages.filter(message => message.role === 'toolResult');
    assert.equal(results.length, 3); assert(results.every(message => message.isError));
    assert.deepEqual(project.concepts, before); assert.equal(project.revisions.length, 0); assert.equal(project.evidence.length, 1);
    const schema = runtime.session.getToolDefinition('propose_concept_revision').parameters;
    for (const name of ['projectId', 'conceptId', 'targetConceptId', 'baseVersion', 'requestId', 'concepts']) assert.equal(Object.hasOwn(schema.properties, name), false);
    const direct = await runtime.session.getToolDefinition('propose_concept_revision').execute('direct', {
      phase: 'needs_input', summary: 'injected', question: 'what?', changes: [], impact: [], unknowns: [], baseVersion: 1 });
    assert.equal(direct.details.feedback.code, 'REVISION_SCHEMA_INVALID');
  } finally { await runtime.dispose(); }
});

test('legacy full-project proposal executor cannot bypass review after concepts exist', async () => {
  const project = fixtureProject();
  // Legitimate historical links are allowed to be present; no localized path validates or repairs them.
  project.concepts.forEach(concept => { concept.evidenceLinks = []; });
  const before = structuredClone(project.concepts);
  const legacy = { baseVersion: 1, phase: 'insufficient_evidence', summary: '企图绕过批准', questions: [], concepts: structuredClone(project.concepts) };
  legacy.concepts[0].coreClaim = '未经批准覆盖试穿机制';
  const runtime = await createProductRuntime(project, { env: {} });
  try {
    const result = await runtime.session.getToolDefinition('propose_design_response').execute('legacy-direct', legacy);
    assert.equal(result.details.accepted, false); assert.equal(result.details.feedback.code, 'LOCAL_REVISION_REQUIRED');
    assert.deepEqual(project.concepts, before); assert.equal(project.version, 1);
    const noChange = { ...legacy, concepts: structuredClone(project.concepts), projectId: project.id };
    assert.equal(applyProposal(project, noChange).unchanged, true); assert.equal(project.version, 1);
    beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '已进入局部修改' });
    assert.throws(() => applyProposal(project, noChange), /完整提案工具/);
  } finally { await runtime.dispose(); }
});

test('HTTP selected target, concurrent accepts, reject and restart restore confirmed, pending and official session state', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'art-revision-'));
  let app = createAppServer({ env: {}, dataDir }); let port = await listen(app);
  const seed = fixtureProject(); app.saveProject(seed);
  const route = `/api/projects/${seed.id}`;
  try {
    assert.equal((await local(port, 'POST', `${route}/messages`, { text: 'legacy overwrite attempt' })).status, 409);
    assert.equal((await local(port, 'POST', `${route}/revisions`, { text: 'wrong target', conceptId: 'b', baseVersion: 1 })).code, 'TARGET_MISMATCH');
    assert.equal((await local(port, 'POST', `${route}/revisions`, { text: 'cross project', conceptId: 'a', baseVersion: 1, projectId: 'other' })).status, 400);
    const request = { text: '首次测试反馈', conceptId: 'a', baseVersion: 1, offlineFixture: 'pair_45' };
    const parallel = await Promise.all([1, 2].map(() => local(port, 'POST', `${route}/revisions`, request)));
    assert.deepEqual(parallel.map(result => result.status).sort(), [202, 409]);
    const pending = await waitProject(port, seed.id); const firstSession = pending.runtime.sessionId;
    const firstRevisionId = pending.revisions[0].id;
    const duplicatePending = await Promise.all([1, 2].map(() => local(port, 'POST', `${route}/revisions`, request)));
    assert(duplicatePending.every(result => result.status === 409 && result.code === 'PENDING_REVISION_EXISTS'));
    assert.equal((await local(port, 'POST', `${route}/select`, { conceptId: 'b', baseVersion: 1 })).status, 409);
    const unchangedPending = (await local(port, 'GET', route)).project;
    assert.deepEqual(unchangedPending.concepts, pending.concepts); assert.equal(unchangedPending.revisions.length, 1);
    assert.equal(unchangedPending.revisions[0].id, firstRevisionId);
    await app.dispose(); app = createAppServer({ env: {}, dataDir }); port = await listen(app);
    let restored = (await local(port, 'GET', route)).project;
    assert.equal(restored.selectedConceptId, 'a'); assert.equal(restored.revisions[0].status, 'pending'); assert.equal(restored.version, 1);
    const accepts = await Promise.all([1, 2].map(() => local(port, 'POST', `${route}/revisions/${firstRevisionId}/accept`, { baseVersion: 1 })));
    assert.deepEqual(accepts.map(result => result.status).sort(), [200, 400]);
    restored = (await local(port, 'GET', route)).project;
    assert.equal(restored.version, 2); assert.equal(restored.versionHistory.length, 2);
    assert.deepEqual(restored.concepts[1], seed.concepts[1]);
    assert.equal((await local(port, 'POST', `${route}/revisions`, { ...request, baseVersion: 1 })).status, 409);
    assert.equal((await local(port, 'POST', `${route}/revisions`, { ...request, text: '第二次反馈', baseVersion: 2, offlineFixture: 'needs_input' })).status, 202);
    restored = await waitProject(port, seed.id); assert.equal(restored.runtime.sessionId, firstSession);
    assert.equal(restored.revisionRequest.status, 'needs_input');
    // An interrupted snapshot is seeded through the same supported storage path.
    restored.status.phase = 'busy'; restored.revisionRequest.status = 'running'; app.saveProject(restored);
    await app.dispose(); app = createAppServer({ env: {}, dataDir }); port = await listen(app);
    restored = (await local(port, 'GET', route)).project;
    assert.equal(restored.status.phase, 'interrupted'); assert.equal(restored.revisionRequest.status, 'interrupted');
    assert.equal(restored.version, 2); assert.equal(restored.revisions[0].status, 'accepted');
    assert.equal(restored.usage.modelHttpAttempts, 0); assert.equal(restored.usage.qlooHttpAttempts, 0);
    restored.selectedConceptId = 'legacy-missing-selection';
    restored.revisions.push({ id: 'legacy-stale', projectId: seed.id, targetConceptId: 'missing-old-target',
      baseVersion: 1, status: 'pending', changes: [{ field: '__proto__', after: 'must not run' }] });
    app.saveProject(restored);
    const confirmed = structuredClone(restored);
    const discarded = await local(port, 'POST', `${route}/revisions/legacy-stale/reject`, { baseVersion: 1 });
    assert.equal(discarded.status, 200); assert.equal(discarded.project.revisions.at(-1).status, 'rejected');
    assert.equal(discarded.project.status.phase, 'ready'); assert.match(discarded.project.status.detail, /已拒绝/);
    const discardingOnly = discarded.project;
    delete discardingOnly.revisions.at(-1).decidedAt; discardingOnly.revisions.at(-1).status = 'pending';
    assert.deepEqual({ ...discardingOnly, status: confirmed.status }, confirmed);
  } finally {
    await app.dispose();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert(dataDir.startsWith(join(tmpdir(), 'art-revision-')));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
