import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createProject, selectConcept, beginRevision, beginPendingFeedback, proposeRevision, decideRevision,
  pendingRevisionDraft, revisionFingerprint, finishRevisionRequest } from '../app/state.mjs';
import { createProductRuntime, REVISION_TOOL_NAMES } from '../app/runtime.mjs';
import { createAppServer } from '../app/server.mjs';
import { createDiagnosticFetch } from '../app/transport.mjs';

const change = (field, after) => ({ field, after, reason: '根据本次反馈作设计推断，效果未知', evidenceRefs: [] });
const response = changes => ({ phase: 'pending', summary: '继续修订当前待审稿', changes,
  impact: ['保留未受影响的原待审修改，调整参与流程'], unknowns: ['现场容量与参与意愿仍待验证'] });
function projectWithDraft() {
  const project = createProject({ brief: { request: '合成材料体验项目', venue: '测试室内', mustKeep: ['触摸样本'] } });
  project.status = { phase: 'ready', detail: '正式方案已保存' };
  project.concepts = ['a', 'b'].map(id => ({ id, title: `正式标题${id}`, coreClaim: '邀请参与者触摸样本并记录',
    mechanism: { organization: `original-${id}`, description: '共同触摸样本，完成观察记录' },
    journey: [{ stage: '到场', action: '领取观察卡' }, { stage: '参与', action: '触摸样本，记录感受' }, { stage: '离开', action: '带走观察卡' }],
    productTouchpoints: ['触摸样本', '保留对照标本'], evidenceLinks: [{ evidenceId: 'old-unresolved', observation: '历史内容原样保留' }],
    openQuestions: ['场地容量待确认'], unverifiedEffects: ['效果未经验证'] }));
  selectConcept(project, { conceptId: 'a', baseVersion: project.version });
  const first = beginRevision(project, { conceptId: 'a', baseVersion: project.version, text: '原始修改请求：增加双人互读' });
  const pending = proposeRevision(project, { ...response([
    change('title', '待审标题：材料互读'),
    change('mechanism', { organization: 'draft-pairs', description: '双人触摸样本后互读记录' }),
    change('productTouchpoints', ['触摸样本', '保留对照标本', '增加个人观察记录']),
    change('openQuestions', ['场地容量待确认', '互读说明是否易懂待确认']),
  ]), requestId: first.id });
  return { project, pending };
}
const correctedMechanism = () => ({ organization: 'revised-pairs', description: '双人先独立触摸样本并记录，再轮流互读；保留原观察卡' });
const startFeedback = (project, pending, text = '先各自观察再互读，保留观察卡及无关内容') =>
  beginPendingFeedback(project, pending.id, { baseVersion: project.version, text });

test('pending feedback binds immutable draft and confirmed version while retaining both during generation', () => {
  const { project, pending } = projectWithDraft();
  const confirmed = structuredClone(project.concepts); const old = structuredClone(pending);
  const request = startFeedback(project, pending);
  assert.equal(request.kind, 'pending_feedback'); assert.equal(request.sourceRevisionId, pending.id);
  assert.equal(request.sourceRevisionNumber, 1); assert.equal(request.sourceFingerprint, revisionFingerprint(pending));
  assert.equal(project.revisionFeedback[0].text, request.text); assert.equal(project.revisionFeedback[0].status, 'running');
  assert.deepEqual(project.concepts, confirmed); assert.deepEqual(pending, old); assert.equal(project.version, 1);
  for (const decision of ['accept', 'reject']) assert.throws(() => decideRevision(project, pending.id, decision, { baseVersion: 1 }),
    error => error.code === 'REVISION_IN_PROGRESS' && error.statusCode === 409);
  assert.throws(() => startFeedback(project, pending), error => error.code === 'REVISION_IN_PROGRESS');
  assert.deepEqual(project.concepts, confirmed); assert.deepEqual(pending, old);
});

test('feedback delta merges prior draft changes, records lineage and accepts exactly the latest displayed consolidated draft once', () => {
  const { project, pending } = projectWithDraft(); const old = structuredClone(pending);
  const confirmed = structuredClone(project.concepts); const oldDraft = pendingRevisionDraft(project, pending);
  const request = startFeedback(project, pending);
  const next = proposeRevision(project, { ...response([change('mechanism', correctedMechanism())]), requestId: request.id });
  assert.equal(project.version, 1); assert.deepEqual(project.concepts, confirmed);
  assert.equal(pending.status, 'superseded'); assert.equal(pending.supersededByRevisionId, next.id);
  const { status, supersededByRevisionId, supersededAt, ...oldContent } = pending;
  const { status: oldStatus, ...expectedOldContent } = old;
  assert.deepEqual(oldContent, expectedOldContent);
  assert.equal(next.parentRevisionId, pending.id); assert.equal(next.revisionNumber, 2);
  assert.equal(next.feedbackId, project.revisionFeedback[0].id);
  assert.equal(project.revisionFeedback[0].revisionId, next.id); assert.equal(project.revisionFeedback[0].status, 'completed');
  assert.equal(next.draftDelta.length, 1); assert.deepEqual(next.draftDelta[0].before, oldDraft.mechanism);
  assert.deepEqual(next.changes.find(item => item.field === 'mechanism').before, confirmed[0].mechanism);
  const shown = pendingRevisionDraft(project, next);
  assert.deepEqual(shown, { ...oldDraft, mechanism: correctedMechanism() });
  for (const decision of ['accept', 'reject']) assert.throws(() => decideRevision(project, pending.id, decision, { baseVersion: 1 }), /已处理/);
  decideRevision(project, next.id, 'accept', { baseVersion: 1 });
  assert.equal(project.version, 2); assert.deepEqual(project.concepts[0], shown); assert.deepEqual(project.concepts[1], confirmed[1]);
  assert.equal(project.versionHistory.at(-1).revisionId, next.id);
  assert.throws(() => decideRevision(project, next.id, 'accept', { baseVersion: 2 }), /已处理/);
});

test('feedback may revert one earlier field while retaining other prior draft changes', () => {
  const { project, pending } = projectWithDraft();
  const request = startFeedback(project, pending);
  const next = proposeRevision(project, { ...response([change('title', project.concepts[0].title)]), requestId: request.id });
  assert(!next.changes.some(item => item.field === 'title'));
  assert.equal(next.draftDelta[0].before, '待审标题：材料互读');
  assert.equal(next.changes.length, 3);
});

test('clarification, conflict and failed feedback preserve source draft and keep attempt history for retry', () => {
  for (const phase of ['needs_input', 'conflict', 'error']) {
    const { project, pending } = projectWithDraft(); const old = structuredClone(pending); const confirmed = structuredClone(project.concepts);
    const request = startFeedback(project, pending);
    if (phase === 'error') {
      assert.throws(() => proposeRevision(project, { ...response([change('selectedConceptId', 'b')]), requestId: request.id }), /不允许修改/);
      finishRevisionRequest(project, request, 'error', '合成模型失败；原稿保留');
    } else proposeRevision(project, { requestId: request.id, phase, summary: '需要确认参与条件', question: '参与者是否同时到场？',
      changes: [], impact: [], unknowns: ['参与条件未知'] });
    assert.deepEqual(pending, old); assert.deepEqual(project.concepts, confirmed); assert.equal(project.version, 1);
    assert.equal(project.revisions.length, 1); assert.equal(project.revisionFeedback[0].status, phase);
    assert(project.revisionFeedback[0].finishedAt);
    const retry = startFeedback(project, pending, '补充说明：参与者同时到场');
    assert.equal(project.revisionFeedback.length, 2); assert.notEqual(retry.id, request.id);
    if (phase !== 'error') assert.equal(retry.priorRequest.question, '参与者是否同时到场？');
    assert.throws(() => proposeRevision(project, { ...response([change('mechanism', correctedMechanism())]), requestId: request.id }),
      error => error.code === 'REVISION_REQUEST_MISMATCH');
    assert.deepEqual(pending, old);
  }
});

test('stale feedback source, fingerprint, target and late responses cannot create or accept a replacement draft', () => {
  for (const mutate of [
    ({ pending }) => { pending.changes[0].after = '并发改变'; },
    ({ pending }) => { pending.revisionNumber = 9; },
    ({ pending }) => { pending.status = 'superseded'; },
    ({ project }) => { project.version++; },
    ({ project }) => { project.selectedConceptId = 'b'; },
    ({ project }) => { project.concepts[0].mechanism.description = '版本号未变但正式内容被意外更改'; },
  ]) {
    const seed = projectWithDraft(); const request = startFeedback(seed.project, seed.pending); mutate(seed);
    const before = structuredClone(seed.project);
    assert.throws(() => proposeRevision(seed.project, { ...response([change('mechanism', correctedMechanism())]), requestId: request.id }),
      error => ['STALE_PENDING_REVISION', 'STALE_PROJECT_VERSION', 'TARGET_MISMATCH'].includes(error.code));
    assert.deepEqual(seed.project, before);
  }
  const { project, pending } = projectWithDraft();
  for (const input of [{ baseVersion: 0, text: '旧版本' }, { baseVersion: 1, text: '越权', conceptId: 'b' }]) {
    const before = structuredClone(project); assert.throws(() => beginPendingFeedback(project, pending.id, input)); assert.deepEqual(project, before);
  }
});

test('official dispatcher receives confirmed concepts, reconstructable pending metadata and full draft using unchanged revision schema', async () => {
  const { project, pending } = projectWithDraft(); const oldDraft = pendingRevisionDraft(project, pending);
  const confirmed = structuredClone(project.concepts); const source = structuredClone(pending);
  const request = startFeedback(project, pending, '先独立观察；保留原记录中的材料对照与离场流程');
  let seen; let modelCalls = 0;
  const runtime = await createProductRuntime(project, { env: {}, decide(context) {
    modelCalls++; assert.equal(modelCalls, 1);
    seen = JSON.parse(context.messages.findLast(message => message.role === 'user').content[0].text);
    assert.deepEqual(context.tools.map(tool => tool.name), REVISION_TOOL_NAMES);
    return [{ type: 'toolCall', id: 'generic-feedback', name: 'propose_concept_revision',
      arguments: response([change('mechanism', correctedMechanism())]) }];
  } });
  try {
    await runtime.submit(request.text);
    assert.deepEqual(seen.project.concepts, confirmed);
    assert.deepEqual(seen.project.currentPendingRevision, { ...source,
      changes: source.changes.map(({ before, after, ...metadata }) => metadata) });
    assert.deepEqual({ ...seen.project.currentPendingRevision,
      changes: seen.project.currentPendingRevision.changes.map(change => ({ ...change,
        before: confirmed.find(concept => concept.id === source.targetConceptId)[change.field],
        after: seen.project.currentPendingDraft[change.field] })) }, source);
    assert.deepEqual(seen.project.currentPendingDraft, oldDraft); assert.equal(seen.message, request.text);
    assert.equal(seen.project.revisionRequest.sourceRevisionId, pending.id); assert.deepEqual(seen.project.lockedFields, []);
    const schema = runtime.session.getToolDefinition('propose_concept_revision').parameters;
    for (const name of ['projectId', 'conceptId', 'targetConceptId', 'baseVersion', 'requestId', 'before', 'sourceRevisionId'])
      assert.equal(Object.hasOwn(schema.properties, name), false);
    assert.equal(project.revisions.length, 2); assert.equal(project.revisions[1].status, 'pending');
    assert.deepEqual(project.concepts, confirmed); assert.equal(project.version, 1);
    const result = runtime.session.messages.findLast(message => message.role === 'toolResult');
    assert.equal(result.toolName, 'propose_concept_revision'); assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0].text).completed, true);
    assert.equal(project.usage.modelHttpAttempts, 0); assert.equal(project.usage.qlooHttpAttempts, 0);
    assert.equal(project.actions.filter(item => item.type === 'query').length, 0);
  } finally { await runtime.dispose(); }
});

test('pending feedback adapter sends the existing 12000-token output allowance on the actual mocked provider request', async () => {
  const { project, pending } = projectWithDraft();
  project.mode = 'live';
  const request = startFeedback(project, pending, '核对观察任务组织，保留材料记录与未验证条件');
  const env = { ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'deepseek', ART_MODEL_ID: 'deepseek-flash',
    ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://api.deepseek.com',
    ART_MODEL_API_KEY: 'synthetic-local-only-key', QLOO_API_KEY: 'synthetic-local-only-qloo-key',
    QLOO_API_URL: 'https://hackathon.api.qloo.com' };
  let wireBody; let mockFetches = 0;
  const transport = createDiagnosticFetch(async (_url, options) => {
    mockFetches++; wireBody = JSON.parse(options.body);
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'synthetic-output-capacity',
      object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: '合成响应；仅核对请求容量，不代表实际修订。' })
      + chunk({}, 'stop') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: transport.fetch } });
  try {
    await runtime.submit(request.text);
    assert.equal(mockFetches, 1); assert.equal(runtime.diagnostic.modelCallbacks, 1);
    assert.equal(transport.ledger.qlooHttpAttempts, 0); assert.equal(runtime.diagnostic.toolExecutionAttempts, 0);
    assert.equal(wireBody.model, 'deepseek-flash'); assert.equal(wireBody.stream, true);
    assert.deepEqual(wireBody.tools.map(tool => tool.function.name), REVISION_TOOL_NAMES);
    assert.equal(wireBody.max_tokens, 12000);
    assert.equal(wireBody.max_completion_tokens, undefined);
    assert.equal(project.version, 1); assert.equal(pending.status, 'pending'); assert.equal(project.revisions.length, 1);
  } finally { await runtime.dispose(); }
});

test('official model failure and clarification retain old pending contents and persist feedback outcome', async () => {
  for (const outcome of ['error', 'needs_input']) {
    const { project, pending } = projectWithDraft(); const old = structuredClone(pending); const confirmed = structuredClone(project.concepts);
    const request = startFeedback(project, pending);
    const runtime = await createProductRuntime(project, { env: {}, decide() {
      if (outcome === 'error') throw new Error('Synthetic model failure');
      return [{ type: 'toolCall', id: 'generic-question', name: 'propose_concept_revision', arguments: {
        phase: 'needs_input', summary: '参与条件不明', question: '能否同时到场？', changes: [], impact: [], unknowns: ['到场方式未知'] } }];
    } });
    try {
      await runtime.submit(request.text);
      assert.equal(project.revisionRequest.status, outcome); assert.equal(project.revisionFeedback[0].status, outcome);
      assert.deepEqual(pending, old); assert.deepEqual(project.concepts, confirmed); assert.equal(project.revisions.length, 1);
      assert.equal(project.version, 1); assert.equal(project.usage.modelHttpAttempts, 0); assert.equal(project.usage.qlooHttpAttempts, 0);
    } finally { await runtime.dispose(); }
  }
});

function local(port, method, path, input) {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value; });
      res.on('end', () => resolveRequest({ status: res.statusCode, ...JSON.parse(text) }));
    });
    req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function listen(app) { await new Promise(done => app.server.listen(0, '127.0.0.1', done)); return app.server.address().port; }
async function settled(port, id) {
  for (let index = 0; index < 200; index++) {
    const result = await local(port, 'GET', `/api/projects/${id}`);
    if (result.project.status.phase !== 'busy') return result.project;
    await new Promise(done => setTimeout(done, 15));
  }
  throw new Error('Local feedback request did not settle');
}

test('HTTP feedback stores supersession, rejects old accept and restores exactly the latest accepted draft across restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'art-pending-feedback-'));
  const runtimeOptions = { decide() { return [{ type: 'toolCall', id: 'http-generic-revision', name: 'propose_concept_revision',
    arguments: response([change('mechanism', correctedMechanism())]) }]; } };
  let app = createAppServer({ env: {}, dataDir, runtimeOptions }); let port = await listen(app);
  const { project, pending } = projectWithDraft(); const confirmed = structuredClone(project.concepts); const old = structuredClone(pending);
  app.saveProject(project); const route = `/api/projects/${project.id}`;
  try {
    assert.equal((await local(port, 'POST', `${route}/revisions/${pending.id}/feedback`, { baseVersion: 0, text: '旧版本反馈' })).status, 409);
    const submitted = await local(port, 'POST', `${route}/revisions/${pending.id}/feedback`, { baseVersion: 1, text: '先独立观察再互读' });
    assert.equal(submitted.status, 202); assert.equal(submitted.project.status.phase, 'busy');
    assert.deepEqual(submitted.project.concepts, confirmed); assert.deepEqual(submitted.project.revisions[0], old);
    const revised = await settled(port, project.id); assert.equal(revised.version, 1); assert.equal(revised.revisions.length, 2);
    assert.equal(revised.revisions[0].status, 'superseded'); assert.equal(revised.revisionFeedback[0].status, 'completed');
    const latest = revised.revisions[1]; const shown = pendingRevisionDraft(revised, latest);
    await app.dispose(); app = createAppServer({ env: {}, dataDir, runtimeOptions }); port = await listen(app);
    const restored = (await local(port, 'GET', route)).project;
    assert.deepEqual(restored.revisions, revised.revisions); assert.deepEqual(restored.revisionFeedback, revised.revisionFeedback);
    for (const decision of ['accept', 'reject']) assert.equal((await local(port, 'POST', `${route}/revisions/${pending.id}/${decision}`, { baseVersion: 1 })).code, 'REVISION_ALREADY_DECIDED');
    assert.equal((await local(port, 'POST', `${route}/revisions/${pending.id}/feedback`, { baseVersion: 1, text: '旧稿反馈' })).status, 409);
    const accepts = await Promise.all([1, 2].map(() => local(port, 'POST', `${route}/revisions/${latest.id}/accept`, { baseVersion: 1 })));
    assert.deepEqual(accepts.map(result => result.status).sort(), [200, 400]);
    const accepted = (await local(port, 'GET', route)).project;
    assert.equal(accepted.version, 2); assert.deepEqual(accepted.concepts[0], shown); assert.deepEqual(accepted.concepts[1], confirmed[1]);
    await app.dispose(); app = createAppServer({ env: {}, dataDir, runtimeOptions }); port = await listen(app);
    assert.deepEqual((await local(port, 'GET', route)).project, accepted);
    assert.equal(accepted.usage.modelHttpAttempts, 0); assert.equal(accepted.usage.qlooHttpAttempts, 0);
  } finally {
    await app.dispose(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert(dataDir.startsWith(join(tmpdir(), 'art-pending-feedback-'))); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('restart interrupts running feedback and retains source pending and failed attempt lineage', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'art-pending-feedback-'));
  let app = createAppServer({ env: {}, dataDir });
  const { project, pending } = projectWithDraft(); const old = structuredClone(pending); const confirmed = structuredClone(project.concepts);
  startFeedback(project, pending); project.status = { phase: 'busy', detail: '处理中' }; app.saveProject(project);
  try {
    await app.dispose(); app = createAppServer({ env: {}, dataDir });
    const restored = app.projects.get(project.id);
    assert.equal(restored.revisionRequest.status, 'interrupted'); assert.equal(restored.revisionFeedback[0].status, 'interrupted');
    assert.deepEqual(restored.revisions[0], old); assert.deepEqual(restored.concepts, confirmed); assert.equal(restored.version, 1);
  } finally {
    await app.dispose(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert(dataDir.startsWith(join(tmpdir(), 'art-pending-feedback-'))); rmSync(dataDir, { recursive: true, force: true });
  }
});
