import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createAppServer } from '../app/server.mjs';
import { applyProposal, createProject, validateProposal } from '../app/state.mjs';
import { createProductRuntime } from '../app/runtime.mjs';
import { createAndStart } from './project-http.mjs';

const original = '  上海快闪；预算20万元以内；必须保留试穿；禁止现场演出；文化参考仅作研究信号。\n';
const brief = { request: original, venue: '上海室内150平方米', budget: '20万元以内',
  mustKeep: ['试穿'], avoid: ['现场演出', '强制注册'], references: ['明确合成音乐信号'] };
function call(port, method, path, payload) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; });
      response.on('end', () => done({ status: response.statusCode, ...JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
  });
}
async function settled(port, id) {
  for (let n = 0; n < 300; n++) {
    const value = await call(port, 'GET', `/api/projects/${id}`);
    if (value.project.status.phase !== 'busy') return value.project;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('isolated clarification did not settle');
}
const answer = (project, text, extra = {}) => ({ text, clarification: {
  questionId: project.questions[0].id, baseVersion: project.version }, ...extra });
const proposal = (project, field) => ({ projectId: project.id, baseVersion: project.version, phase: 'needs_input',
  summary: '明确离线测试问题', questions: [{ field, text: `${field}还有什么需要确认？` }], concepts: [] });

test('actual save/restart/model path keeps verbatim request, consecutive Q/A, constraints, entities, evidence and HTTP ledger', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'art-clarification-save-'));
  const contexts = [];
  const options = { env: {}, dataDir, runtimeOptions: { decide(context, project) {
    contexts.push(JSON.parse(context.messages[0].content[0].text));
    const count = project.clarifications?.length ?? 0;
    const value = count < 2 ? proposal(project, count === 0 ? 'request' : 'budget')
      : { baseVersion: project.version, phase: 'insufficient_evidence', summary: '离线验证暂停，无外部请求', concepts: [] };
    delete value.projectId;
    return [{ type: 'toolCall', id: `synthetic-${contexts.length}`, name: 'propose_design_response', arguments: value }];
  } } };
  let app = createAppServer(options), id;
  const start = async () => { await new Promise(done => app.server.listen(0, '127.0.0.1', done)); return app.server.address().port; };
  let port = await start();
  t.after(async () => {
    await app.dispose();
    if (id) { const directory = resolve('.art-runtime', id); assert(directory.startsWith(resolve('.art-runtime') + sep)); rmSync(directory, { recursive: true, force: true }); }
    assert(dataDir.startsWith(join(tmpdir(), 'art-clarification-save-'))); rmSync(dataDir, { recursive: true, force: true });
  });
  id = (await createAndStart((...args) => call(port, ...args), { mode: 'offline', brief })).project.id;
  const first = await settled(port, id), question = structuredClone(first.questions[0]);
  const authority = app.projects.get(id);
  authority.referenceResolutions = [{ id: 'synthetic-confirmed', projectId: id, baseVersion: first.version,
    status: 'user_confirmed', confirmed: true, selectedId: 'synthetic-entity' }];
  authority.evidence = [{ id: 'synthetic-evidence', projectId: id, relevant: false, returnedEntities: [], rawResult: { status: 'ok', results: [] } }];
  authority.versionHistory = [{ version: 1, concepts: [], selectedConceptId: null }];
  app.saveProject(authority);
  const preserved = structuredClone({ referenceResolutions: authority.referenceResolutions, evidence: authority.evidence,
    versionHistory: authority.versionHistory });
  const ledger = readFileSync(join(dataDir, '.http-budget', 'run.json'), 'utf8');
  const shortAnswer = '  暂无其他条件，按你建议就行\n';
  assert.equal((await call(port, 'POST', `/api/projects/${id}/messages`, answer(first, shortAnswer))).status, 202);
  const second = await settled(port, id);
  assert.equal(second.brief.request, original);
  assert.deepEqual(second.brief, { brand: '', goal: '', ...brief });
  assert.equal(second.clarifications[0].questionId, question.id);
  assert.equal(second.clarifications[0].question, question.text);
  assert.equal(second.clarifications[0].answer, shortAnswer);
  assert.equal(second.questions[0].field, 'budget');
  const saved = JSON.parse(readFileSync(join(dataDir, `${id}.json`), 'utf8')).project;
  assert.deepEqual(saved.clarifications, second.clarifications);
  await app.dispose(); app = createAppServer(options); port = await start();
  const restored = (await call(port, 'GET', `/api/projects/${id}`)).project;
  assert.deepEqual(restored, second);
  const changedBudget = answer(restored, '客户明确改为15万元以内', { briefUpdate: { field: 'budget', value: '15万元以内' } });
  assert.equal((await call(port, 'POST', `/api/projects/${id}/messages`, changedBudget)).status, 202);
  const final = await settled(port, id), work = contexts.at(-1).project;
  assert.equal(final.brief.request, original); assert.equal(final.brief.budget, '15万元以内');
  assert.equal(final.clarifications.length, 2);
  assert.equal(final.clarifications[1].questionId, restored.questions[0].id);
  assert.deepEqual(final.clarifications[1].briefUpdate, { field: 'budget', before: '20万元以内', after: '15万元以内', explicit: true });
  assert.equal(work.brief.request, original); assert.equal(work.clarifications[0].answer, shortAnswer);
  assert.equal(work.clarifications[0].question, question.text);
  assert.equal(work.clarifications[1].answer, changedBudget.text);
  assert.equal(work.brief.budget, '15万元以内'); assert.deepEqual(work.brief.mustKeep, brief.mustKeep); assert.deepEqual(work.brief.avoid, brief.avoid);
  for (const [field, value] of Object.entries(preserved)) assert.deepEqual(final[field], value);
  assert.equal(readFileSync(join(dataDir, '.http-budget', 'run.json'), 'utf8'), ledger);
  assert.equal(final.usage.modelHttpAttempts, 0); assert.equal(final.usage.qlooHttpAttempts, 0);
  console.log('clarification-save evidence: HTTP save -> graceful restart -> actual bounded model callback; DeepSeek=0 Qloo=0');
});

test('vague answers preserve constraints; only explicit typed revisions change validator constraints; invalid/stale input is atomic', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'art-clarification-save-'));
  const contexts = [];
  const app = createAppServer({ env: {}, dataDir, runtimeOptions: { decide(context, project) {
    contexts.push(JSON.parse(context.messages[0].content[0].text).project);
    return [{ type: 'toolCall', id: `stop-${project.version}`, name: 'propose_design_response', arguments: {
      baseVersion: project.version, phase: 'insufficient_evidence', summary: '明确离线停止', concepts: [] } }];
  } } });
  const value = createProject({ brief }); applyProposal(value, proposal(value, 'avoid')); app.saveProject(value);
  await new Promise(done => app.server.listen(0, '127.0.0.1', done)); const port = app.server.address().port;
  t.after(async () => { await app.dispose(); const directory = resolve('.art-runtime', value.id); assert(directory.startsWith(resolve('.art-runtime') + sep)); rmSync(directory, { recursive: true, force: true }); assert(dataDir.startsWith(join(tmpdir(), 'art-clarification-save-'))); rmSync(dataDir, { recursive: true, force: true }); });
  const endpoint = `/api/projects/${value.id}/messages`;
  for (const payload of [{ text: '都可以' }, answer(value, '都可以', { clarification: { questionId: 'other-project-question', baseVersion: value.version } }),
    answer(value, '都可以', { clarification: { questionId: value.questions[0].id, baseVersion: value.version - 1 } }),
    answer(value, '都可以', { clarification: { questionId: value.questions[0].id, baseVersion: value.version, reviseRequest: true } }),
    answer(value, '都可以', { briefUpdate: { field: 'request', value: '丢失原文' } }),
    answer(value, '都可以', { briefUpdate: { field: 'avoid', value: '都可以' } })]) {
    const before = JSON.stringify(value), saved = readFileSync(join(dataDir, `${value.id}.json`), 'utf8');
    assert([400, 409].includes((await call(port, 'POST', endpoint, payload)).status));
    assert.equal(JSON.stringify(value), before); assert.equal(readFileSync(join(dataDir, `${value.id}.json`), 'utf8'), saved);
  }
  const oldAnswer = answer(value, '都可以，按你建议');
  assert.equal((await call(port, 'POST', endpoint, oldAnswer)).status, 202); await settled(port, value.id);
  assert.deepEqual(value.brief.avoid, brief.avoid); assert.deepEqual(value.brief.mustKeep, brief.mustKeep);
  applyProposal(value, proposal(value, 'avoid')); app.saveProject(value);
  const beforeStale = JSON.stringify(value); assert.equal((await call(port, 'POST', endpoint, oldAnswer)).status, 409); assert.equal(JSON.stringify(value), beforeStale);
  assert.equal((await call(port, 'POST', endpoint, answer(value, '明确只撤销现场演出禁令，保留禁止强制注册', {
    briefUpdate: { field: 'avoid', value: [' 强制注册 '] } }))).status, 202);
  await settled(port, value.id); assert.deepEqual(value.brief.avoid, ['强制注册']);
  const concepts = ['a', 'b'].map(id => ({ id, title: id, coreClaim: '试穿与现场演出', mechanism: { organization: id, description: id === 'a'
    ? '同组轮流试穿并一起观看现场演出' : '个人自选时间试穿后自由观看现场演出' },
    journey: ['来', '做', '走'].map(stage => ({ stage, action: '试穿与现场演出' })), productTouchpoints: ['试穿'], evidenceLinks: [], openQuestions: [], unverifiedEffects: ['效果未知'] }));
  const candidate = { projectId: value.id, baseVersion: value.version, phase: 'insufficient_evidence', summary: '仅验证约束，无真实方案依据', concepts };
  assert.doesNotThrow(() => validateProposal(value, candidate));
  candidate.concepts[0].mechanism.description += '强制注册'; assert.throws(() => validateProposal(value, candidate), /excluded item/);
  applyProposal(value, proposal(value, 'request')); app.saveProject(value);
  const revisionText = '明确将城市从上海改为杭州，预算与其他条件不变。';
  const revised = answer(value, revisionText); revised.clarification.reviseRequest = true;
  assert.equal((await call(port, 'POST', endpoint, revised)).status, 202); await settled(port, value.id);
  assert.equal(value.clarifications.at(-1).revisesRequest, true);
  assert.equal(contexts.at(-1).clarifications.at(-1).revisesRequest, true);
  assert.equal(contexts.at(-1).clarifications.at(-1).answer, revisionText);
  assert.deepEqual(contexts.at(-1).brief.avoid, ['强制注册']);
  assert.equal(value.brief.request, original);
  applyProposal(value, proposal(value, 'mustKeep')); app.saveProject(value);
  assert.equal((await call(port, 'POST', endpoint, answer(value, '都可以'))).status, 202); await settled(port, value.id);
  assert.deepEqual(value.brief.mustKeep, ['试穿']);
  candidate.baseVersion = value.version;
  for (const concept of candidate.concepts) {
    concept.coreClaim = '触摸样本'; concept.mechanism.description = concept.id === 'a' ? '同组轮流触摸样本' : '个人自选顺序触摸样本';
    concept.journey.forEach(step => { step.action = '触摸样本'; }); concept.productTouchpoints = ['触摸样本'];
  }
  assert.throws(() => validateProposal(value, candidate), /must-keep/);
  applyProposal(value, proposal(value, 'request')); app.saveProject(value);
  const targeted = answer(value, '客户明确用触摸样本替代试穿', { briefUpdate: { field: 'mustKeep', value: ['触摸样本'] } });
  const beforeTarget = JSON.stringify(value);
  assert.equal((await call(port, 'POST', endpoint, targeted)).status, 400, 'cross-target update requires explicit request-revision intent');
  assert.equal(JSON.stringify(value), beforeTarget);
  targeted.clarification.reviseRequest = true;
  assert.equal((await call(port, 'POST', endpoint, { ...targeted, briefUpdate: { field: 'brand', value: '越界修改' } })).status, 400);
  assert.equal(JSON.stringify(value), beforeTarget);
  assert.equal((await call(port, 'POST', endpoint, targeted)).status, 202);
  await settled(port, value.id); candidate.baseVersion = value.version;
  assert.doesNotThrow(() => validateProposal(value, candidate));
  assert.deepEqual(value.brief.mustKeep, ['触摸样本']);
  assert.equal(value.clarifications.at(-1).field, 'request');
  assert.equal(value.clarifications.at(-1).briefUpdate.field, 'mustKeep');
  assert.equal(contexts.at(-1).brief.mustKeep[0], '触摸样本');
  assert.deepEqual(value.brief.avoid, ['强制注册']);
  applyProposal(value, proposal(value, 'request')); app.saveProject(value);
  const restoredAvoid = answer(value, '明确恢复禁止现场演出，同时保留禁止强制注册', {
    briefUpdate: { field: 'avoid', value: ['现场演出', '强制注册'] } });
  restoredAvoid.clarification.reviseRequest = true;
  assert.equal((await call(port, 'POST', endpoint, restoredAvoid)).status, 202); await settled(port, value.id);
  candidate.baseVersion = value.version; candidate.concepts[0].mechanism.description += '现场演出';
  assert.throws(() => validateProposal(value, candidate), /excluded item/);
  applyProposal(value, proposal(value, 'request')); app.saveProject(value);
  const removedAvoid = answer(value, '明确仅取消现场演出禁令', { briefUpdate: { field: 'avoid', value: ['强制注册'] } });
  removedAvoid.clarification.reviseRequest = true;
  assert.equal((await call(port, 'POST', endpoint, removedAvoid)).status, 202); await settled(port, value.id);
  candidate.baseVersion = value.version; assert.doesNotThrow(() => validateProposal(value, candidate));
  candidate.concepts[0].mechanism.description += '强制注册'; assert.throws(() => validateProposal(value, candidate), /excluded item/);
  applyProposal(value, proposal(value, 'request')); app.saveProject(value);
  const venueChange = answer(value, '明确将城市改成杭州，其余条件保留', { briefUpdate: { field: 'venue', value: '杭州室内150平方米' } });
  venueChange.clarification.reviseRequest = true;
  assert.equal((await call(port, 'POST', endpoint, venueChange)).status, 202); await settled(port, value.id);
  assert.equal(contexts.at(-1).brief.venue, '杭州室内150平方米');
  assert.deepEqual(contexts.at(-1).brief.mustKeep, ['触摸样本']); assert.deepEqual(contexts.at(-1).brief.avoid, ['强制注册']);
  assert.equal(value.brief.request, original);
});

test('bounded actual model view keeps older active request decisions and current updates while omitting superseded structured history', async t => {
  const project = createProject({ brief });
  project.clarifications = [
    { questionId: 'old-access', field: 'request', question: '无障碍条件？', answer: '必须有无障碍通道' },
    { questionId: 'old-city-revision', field: 'request', question: '城市需要改吗？', answer: '明确改为杭州，其余不变', revisesRequest: true },
    { questionId: 'old-venue-access', field: 'venue', question: '已知场地还有哪些条件？', answer: '必须保留无障碍通道' },
    { questionId: 'newer-venue-area', field: 'venue', question: '面积还有补充吗？', answer: '另有100平方米可用区域' },
    { questionId: 'old-current-budget', field: 'budget', question: '预算？', answer: '明确改为15万元',
      briefUpdate: { field: 'budget', before: '20万元以内', after: '15万元以内', explicit: true } },
    ...Array.from({ length: 20 }, (_, index) => ({ questionId: `avoid-${index}`, field: 'avoid', question: '当前完整禁止项？', answer: `明确替换为禁止-${index}`,
      briefUpdate: { field: 'avoid', before: [`禁止-${index - 1}`], after: [`禁止-${index}`], explicit: true } })) ];
  project.brief.budget = '15万元以内'; project.brief.avoid = ['禁止-19'];
  const before = structuredClone(project.clarifications);
  let work;
  const runtime = await createProductRuntime(project, { env: {}, decide(context, snapshot) {
    work = JSON.parse(context.messages[0].content[0].text).project;
    return [{ type: 'toolCall', id: 'bounded-clarification', name: 'propose_design_response', arguments: {
      baseVersion: snapshot.version, phase: 'insufficient_evidence', summary: '仅离线上下文验证', concepts: [] } }];
  } });
  t.after(async () => { await runtime.dispose(); const directory = resolve('.art-runtime', project.id); assert(directory.startsWith(resolve('.art-runtime') + sep)); rmSync(directory, { recursive: true, force: true }); });
  await runtime.submit('依据仍有效的需求继续，缺证据则暂停');
  assert.equal(work.clarificationHistory.total, 25); assert.equal(work.clarificationHistory.omitted, 8);
  assert.equal(work.clarifications.length, 17);
  assert(work.clarifications.some(record => record.questionId === 'old-access' && record.answer === '必须有无障碍通道'));
  assert(work.clarifications.some(record => record.questionId === 'old-city-revision' && record.revisesRequest));
  assert(work.clarifications.some(record => record.questionId === 'old-venue-access' && record.answer === '必须保留无障碍通道'));
  assert(work.clarifications.some(record => record.questionId === 'newer-venue-area'));
  assert(work.clarifications.some(record => record.questionId === 'old-current-budget' && record.briefUpdate.after === '15万元以内'));
  assert(!work.clarifications.some(record => record.questionId === 'avoid-0'));
  assert.equal(work.clarifications.at(-1).questionId, 'avoid-19');
  assert.equal(work.brief.request, original); assert.deepEqual(work.brief.avoid, ['禁止-19']);
  assert.deepEqual(project.clarifications, before);
  assert.equal(project.usage.modelHttpAttempts, 0); assert.equal(project.usage.qlooHttpAttempts, 0);
});

test('too many independent unmaterialized supplements across fields stop before a model callback rather than dropping conditions', async t => {
  const project = createProject({ brief });
  project.clarifications = Array.from({ length: 13 }, (_, index) => ({ questionId: `independent-${index}`, field: index === 0 ? 'request' : index % 2 ? 'venue' : 'budget',
    question: `独立条件${index}？`, answer: `保留独立条件${index}` }));
  const before = structuredClone(project.clarifications);
  let callbacks = 0;
  const runtime = await createProductRuntime(project, { env: {}, decide() { callbacks++; return []; } });
  t.after(async () => { await runtime.dispose(); const directory = resolve('.art-runtime', project.id); assert(directory.startsWith(resolve('.art-runtime') + sep)); rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(runtime.submit('继续'), /more than 12/);
  assert.equal(callbacks, 0); assert.equal(project.runtime.localFailure.code, 'MODEL_CONTEXT_CLARIFICATION_LIMIT');
  assert.deepEqual(project.clarifications, before); assert.equal(project.brief.request, original);
  assert.equal(project.usage.modelHttpAttempts, 0); assert.equal(project.usage.qlooHttpAttempts, 0);
});
