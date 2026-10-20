import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createProject, applyProposal, selectConcept, beginRevision, proposeRevision } from '../app/state.mjs';
import { createProductRuntime, recordEvidence } from '../app/runtime.mjs';
import { budgetedFetch, safeRuntimeFailure, serverUsage, validationRun, withHttpBudget } from '../app/transport.mjs';

const brief = { request: '模拟反馈验收：两个试穿机制', venue: '合成室内场地', references: ['合成参考'], mustKeep: ['试穿'], avoid: ['舞台演出'] };
const read = message => JSON.parse(message.content.filter(c => c.type === 'text').map(c => c.text).join(''));
const reset = () => {
  Object.assign(serverUsage, { modelHttpAttempts: 0, qlooHttpAttempts: 0 });
  Object.assign(validationRun, { queryStopped: false, liveStopped: false });
  validationRun.attempts.length = 0; delete validationRun.failure;
};
const fixtures = [];
const liveEnv = { ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'mock-feedback', ART_MODEL_ID: 'mock-model',
  ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://model.invalid', ART_MODEL_API_KEY: 'mock-key',
  QLOO_API_URL: 'https://qloo.invalid', QLOO_API_KEY: 'mock-qloo-key' };
function mockResponse(parts) {
  const calls = parts.filter(part => part.type === 'toolCall');
  const delta = calls.length ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index,
    id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
    : { role: 'assistant', content: parts.map(part => part.text ?? '').join('') };
  const chunk = (delta, finish_reason) => `data: ${JSON.stringify({ id: 'mock-response', object: 'chat.completion.chunk',
    created: 0, model: 'mock-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk(delta, null) + chunk({}, calls.length ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}
const proposalCall = (project, changes = {}, id = 'proposal') => ({ type: 'toolCall', id, name: 'propose_design_response',
  arguments: { baseVersion: project.version, phase: 'insufficient_evidence',
    summary: '模拟环境证据不足，明确暂停；未发生真实网络。', questions: [], concepts: [], ...changes } });
const concept = (project, index, links = []) => ({ id: `mock-concept-${index}`, title: `合成机制${index}`, coreClaim: '试穿任务形成个人脚感记录，效果待验证。',
  mechanism: { organization: index ? 'self_paced' : 'scheduled_group', description: index ? '个人自选任务顺序。' : '小组按时段同步完成任务。' },
  journey: [{ stage: '到场', action: '选择试穿任务。' }, { stage: '参与', action: '完成试穿并描述脚感。' }, { stage: '带走', action: '带走个人记录。' }],
  productTouchpoints: ['试穿后描述个人脚感。'], evidenceLinks: links,
  openQuestions: ['版权、场地与真实报价未知。'], unverifiedEffects: ['到场、参与和转化效果未验证。'] });
async function mockLive(project, modelReply, qlooReply) {
  const original = globalThis.fetch;
  let modelRequests = 0, qlooRequests = 0;
  let modelReplyError;
  const modelFeedback = [];
  globalThis.fetch = budgetedFetch(async (url, options) => {
    const destination = new URL(String(url));
    if (destination.origin === liveEnv.ART_MODEL_BASE_URL) {
      modelRequests++;
      const body = JSON.parse(options.body);
      for (const message of body.messages.filter(message => message.role === 'tool')) {
        try { const value = JSON.parse(message.content); if (value.feedback) modelFeedback.push(value.feedback); } catch {}
      }
      let reply;
      try { reply = modelReply(body, modelRequests, runtime); }
      catch (error) { modelReplyError = error; throw error; }
      return reply instanceof Response ? reply : mockResponse(reply);
    }
    assert.equal(destination.origin, liveEnv.QLOO_API_URL, 'offline mock must not reach any other host');
    qlooRequests++;
    assert(qlooReply, 'unexpected mocked Qloo request');
    const reply = qlooReply(destination);
    return reply instanceof Response ? reply : Response.json(reply);
  });
  let runtime;
  try {
    runtime = await createProductRuntime(project, { env: liveEnv });
    await runtime.submit(brief.request);
    if (modelReplyError) throw modelReplyError;
    return { modelRequests, qlooRequests, modelFeedback };
  } finally { if (runtime) await runtime.dispose(); globalThis.fetch = original; }
}

test('source boundary preserves local budget failure rather than a preceding HTTP 200', async () => {
  reset();
  const project = createProject({ brief, mode: 'live' });
  project.usage.qlooHttpAttempts = 6;
  project.runtime.httpAttempts = [{ kind: 'qloo', status: 200, outcome: 'response_ok' }];
  let fetches = 0;
  const guarded = budgetedFetch(async () => { fetches++; return new Response('{}'); });
  await assert.rejects(() => withHttpBudget(project, 'qloo', 'https://qloo.invalid', () => guarded('https://qloo.invalid/search')));
  const failure = safeRuntimeFailure(project, 'qloo');
  assert.equal(failure.code, 'QLOO_HTTP_BUDGET_EXHAUSTED');
  assert.equal(failure.status, null);
  assert.equal(failure.remainingBudget.qlooHttpAttempts, 0);
  assert.equal(fetches, 0);
  reset();
});

test('official session returns schema rejection as safe structured content.text to next simulated model turn', async () => {
  reset();
  const project = createProject({ brief });
  let observed;
  const runtime = await createProductRuntime(project, { env: {}, decide(context) {
    const result = context.messages.findLast(m => m.role === 'toolResult');
    if (!result) return [{ type: 'toolCall', id: 'schema-rejection', name: 'propose_design_response', arguments: { summary: 'DO_NOT_ECHO_PROPOSAL' } }];
    observed = read(result);
    assert.equal(result.isError, true);
    return [{ type: 'text', text: '模拟模型已收到结构化格式拒绝；等待修正。' }];
  } });
  try {
    await runtime.submit(brief.request);
    assert.equal(observed?.feedback?.code, 'PROPOSAL_SCHEMA_INVALID');
    assert.equal(observed.feedback.path, '/baseVersion');
    assert.equal(JSON.stringify(observed).includes('DO_NOT_ECHO_PROPOSAL'), false);
    assert.equal(project.version, 1);
    assert.equal(project.runtime.feedback.code, 'PROPOSAL_SCHEMA_INVALID');
    fixtures.push({ name: 'schema_invalid', project: structuredClone(project), modelFeedback: observed.feedback });
  } finally { await runtime.dispose(); }
});

test('official session sends precise business evidence rejection to the next simulated model turn', async () => {
  reset();
  const project = createProject({ brief });
  let observed;
  const runtime = await createProductRuntime(project, { env: {}, decide(context) {
    const result = context.messages.findLast(message => message.role === 'toolResult');
    if (!result) return [proposalCall(project, { phase: 'ready', concepts: [concept(project, 0), concept(project, 1)] })];
    observed = read(result);
    assert.equal(result.isError, true);
    return [{ type: 'text', text: '模拟模型收到证据不足拒绝，暂停等待。' }];
  } });
  try {
    await runtime.submit(brief.request);
    assert.equal(observed.feedback.code, 'EVIDENCE_INSUFFICIENT');
    assert.equal(observed.feedback.path, '/concepts/0/evidenceLinks');
    assert.equal(project.version, 1);
    assert.equal(project.concepts.length, 0);
    assert.equal(project.status.phase, 'insufficient_evidence');
    assert.equal(project.actions.find(action => action.label === 'propose_design_response').feedback.code, 'EVIDENCE_INSUFFICIENT');
    fixtures.push({ name: 'insufficient_evidence', project: structuredClone(project), modelFeedback: observed.feedback });
  } finally { await runtime.dispose(); }
});

test('mocked official session reads local Qloo budget exhaustion and never attributes its old 200', async () => {
  reset();
  const project = createProject({ brief, mode: 'live' });
  project.usage.qlooHttpAttempts = 6; // Explicit mock of an already exhausted case ledger.
  project.runtime.httpAttempts = [{ kind: 'qloo', status: 200, outcome: 'response_ok' }];
  const result = await mockLive(project, (_body, turn) => turn === 1
    ? [{ type: 'toolCall', id: 'budget-query', name: 'qloo_recommend', arguments: { target_type: 'artist', signals: ['合成参考'], limit: 2 } }]
    : [{ type: 'text', text: '模拟模型收到本地额度耗尽，停止研究并保留已有状态。' }]);
  assert.equal(result.qlooRequests, 0);
  assert.equal(result.modelRequests, 2);
  assert.equal(result.modelFeedback.at(-1).code, 'QLOO_HTTP_BUDGET_EXHAUSTED');
  assert.equal(result.modelFeedback.at(-1).remainingBudget.qlooHttpAttempts, 0);
  assert.match(result.modelFeedback.at(-1).nextAction, /禁止继续 Qloo/);
  assert.equal(project.runtime.failure.status, null);
  assert.equal(project.runtime.feedback.remainingBudget.modelHttpAttempts, 4, 'final state refreshes budget after the text-only closing model request');
  assert.equal(project.runtime.httpAttempts.filter(entry => entry.kind === 'qloo').length, 1);
  fixtures.push({ name: 'budget_exhausted', project: structuredClone(project), modelFeedback: result.modelFeedback.at(-1) });
  reset();
});

test('mocked Qloo HTTP error reaches the model, blocks both query tools and permits only validated closing proposals', async () => {
  for (const existingDraft of [false, true]) {
    reset();
    const project = createProject({ brief, mode: 'live' });
    const entity = { entity_id: 'saved-description', properties: { description: '合成既有描述；不是受众或效果证据。' } };
    const card = recordEvidence(project, 'describe', { entity: '合成参考' }, { correlationId: 'saved-no-network',
      result: { status: 'ok', results: [entity] } });
    const link = { evidenceId: card.id, entityId: entity.entity_id, observedField: 'properties.description',
      observedValue: entity.properties.description, observation: '只引用已有精确描述。', inspiration: '组织方式为设计推断，效果未知。' };
    const concepts = [concept(project, 0, [link]), concept(project, 1, [link])];
    if (existingDraft) {
      applyProposal(project, { ...proposalCall(project, { phase: 'ready', concepts }).arguments, projectId: project.id });
      selectConcept(project, { conceptId: concepts[0].id, baseVersion: project.version });
      const request = beginRevision(project, { conceptId: concepts[0].id, baseVersion: project.version, text: '保留正式内容，调整标题待审' });
      proposeRevision(project, { requestId: request.id, phase: 'pending', summary: '既有待审稿',
        changes: [{ field: 'title', after: '既有待审标题', reason: '设计师待审选择', evidenceRefs: [] }],
        impact: ['仅标题'], unknowns: ['效果未知'] });
    }
    const before = structuredClone({ concepts: project.concepts, revisions: project.revisions, version: project.version });
    const expectedRejection = existingDraft ? 'STALE_PROJECT_VERSION' : 'EVIDENCE_VALUE_MISMATCH';
    const result = await mockLive(project, (body, turn) => {
      const feedback = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).feedback);
      if (turn === 1) return [{ type: 'toolCall', id: 'remote-error', name: 'qloo_recommend', arguments: { target_type: 'artist', signals: ['合成参考'], limit: 2 } }];
      if (turn === 2) {
        assert.equal(feedback.at(-1).code, 'QLOO_REMOTE_ERROR');
        assert.equal(feedback.at(-1).remainingBudget.queryStopped, true);
        assert.equal(feedback.at(-1).remainingBudget.qlooHttpAttempts, 0);
        assert.equal(feedback.at(-1).remainingBudget.modelHttpAttempts, 5);
        assert.deepEqual({ concepts: project.concepts, revisions: project.revisions, version: project.version }, before);
        return [
          { type: 'toolCall', id: 'blocked-describe', name: 'qloo_describe', arguments: { entity: '合成参考', type: 'artist' } },
          { type: 'toolCall', id: 'blocked-recommend', name: 'qloo_recommend', arguments: { target_type: 'artist', signals: ['其他合成参考'], limit: 2 } },
        ];
      }
      if (turn === 3) {
        assert.deepEqual(feedback.slice(-2).map(value => value.code), ['QLOO_QUERY_STOPPED', 'QLOO_QUERY_STOPPED']);
        const invalid = proposalCall(project, { phase: 'ready', concepts: structuredClone(concepts) });
        if (existingDraft) invalid.arguments.baseVersion--;
        else invalid.arguments.concepts[0].evidenceLinks[0].observedValue = 'fabricated';
        return [invalid];
      }
      assert.equal(turn, 4, 'accepted closing proposal must terminate without another callback');
      assert.equal(feedback.at(-1).code, expectedRejection);
      assert.deepEqual({ concepts: project.concepts, revisions: project.revisions, version: project.version }, before);
      return [proposalCall(project, { phase: existingDraft ? 'ready' : 'insufficient_evidence', concepts,
        summary: '查询失败；仅保留既有描述的有限设计草案，受众与效果未知。' })];
    }, () => Response.json({ error: { code: 'INVALID_PARAMETER', message: 'synthetic Qloo HTTP error' } }, { status: 400 }));
    assert.equal(result.modelRequests, 4);
    assert.equal(result.qlooRequests, 1, 'blocked describe/recommend never reach the mocked HTTP boundary');
    assert.equal(project.usage.modelHttpAttempts, 4);
    assert.equal(project.usage.qlooHttpAttempts, 1);
    assert.equal(project.runtime.queryStopped, true);
    assert.equal(validationRun.liveStopped, false);
    assert.equal(project.runtime.failure.kind, 'qloo');
    assert.equal(project.runtime.failure.status, 400);
    assert.equal(project.runtime.feedback.code, 'PROPOSAL_ACCEPTED');
    assert.deepEqual(project.revisions, before.revisions);
    assert.deepEqual(project.concepts, existingDraft ? before.concepts : concepts);
    assert.equal(project.version, existingDraft ? before.version : before.version + 1);
  }
  reset();
});

test('case and shared Qloo exhaustion still bound closing model requests by their original budgets', async () => {
  for (const shared of [false, true]) {
    reset();
    const project = createProject({ brief, mode: 'live' });
    if (shared) { serverUsage.qlooHttpAttempts = 12; serverUsage.modelHttpAttempts = 10; }
    else project.usage.qlooHttpAttempts = 6;
    const result = await mockLive(project, (body, turn) => {
      if (turn === 1) return [{ type: 'toolCall', id: 'exhausted-query', name: 'qloo_describe', arguments: { entity: '合成参考', type: 'artist' } }];
      const feedback = JSON.parse(body.messages.findLast(message => message.role === 'tool').content).feedback;
      if (turn === 2) {
        assert.equal(feedback.code, 'QLOO_HTTP_BUDGET_EXHAUSTED');
        assert.equal(feedback.remainingBudget.queryStopped, true);
        assert.equal(feedback.remainingBudget.qlooHttpAttempts, 0);
        assert.equal(feedback.remainingBudget.sharedRemaining.qlooHttpAttempts, shared ? 0 : 12);
      }
      return [proposalCall(project, { phase: 'ready', concepts: [concept(project, 0), concept(project, 1)] }, `invalid-close-${turn}`)];
    });
    assert.equal(result.modelRequests, shared ? 2 : 6);
    assert.equal(result.qlooRequests, 0);
    assert.equal(project.runtime.feedback.code, 'EVIDENCE_INSUFFICIENT');
    assert.equal(project.runtime.feedback.remainingBudget.modelHttpAttempts, 0);
    assert.equal(project.version, 1);
    assert.deepEqual(project.concepts, []);
    assert.equal(serverUsage.modelHttpAttempts, shared ? 12 : 6);
  }
  reset();
});

test('global stop, session abort and unrecoverable model HTTP error never schedule a closing request', async () => {
  for (const stop of ['global', 'abort', 'model_error']) {
    reset();
    const project = createProject({ brief, mode: 'live' });
    const result = await mockLive(project, (_body, turn, runtime) => {
      assert.equal(turn, 1, `${stop} must not request another model response`);
      if (stop === 'model_error') return Response.json({ error: { code: 'invalid_api_key', message: 'synthetic model error' } }, { status: 401 });
      runtime.session.subscribe(event => {
        if (event.type !== 'tool_execution_end') return;
        if (stop === 'global') validationRun.liveStopped = true;
        else void runtime.session.abort();
      });
      return [{ type: 'toolCall', id: 'query-before-stop', name: 'qloo_describe', arguments: { entity: '合成参考', type: 'artist' } }];
    }, () => Response.json({ error: { message: 'synthetic query failure before explicit stop' } }, { status: 400 }));
    assert.equal(result.modelRequests, 1);
    assert.equal(result.qlooRequests, stop === 'model_error' ? 0 : 1);
    assert.equal(project.usage.modelHttpAttempts, 1);
    assert.equal(project.version, 1);
    if (stop === 'model_error') {
      assert.equal(project.runtime.failure.kind, 'model');
      assert.equal(project.runtime.failure.status, 401);
    }
  }
  reset();
});

test('mocked remote empty is a different official tool result and remains readable in model content.text', async () => {
  reset();
  const project = createProject({ brief, mode: 'live' });
  const result = await mockLive(project, (_body, turn) => turn === 1
    ? [{ type: 'toolCall', id: 'empty-query', name: 'qloo_recommend', arguments: { target_type: 'artist', signals: ['合成参考'], limit: 2 } }]
    : [{ type: 'text', text: '模拟模型确认远端 empty，本次没有关联实体证据，暂停。' }],
  destination => destination.pathname === '/search'
    ? { results: [{ entity_id: '11111111-1111-4111-8111-111111111111', name: '合成参考', type: 'urn:entity:artist', popularity: 0.1 }] }
    : { results: { entities: [] } });
  assert.equal(result.modelRequests, 2);
  assert.equal(result.qlooRequests, 2);
  assert.equal(result.modelFeedback.at(-1).code, 'QLOO_EMPTY');
  assert.equal(result.modelFeedback.at(-1).remainingBudget.qlooHttpAttempts, 4);
  assert.match(result.modelFeedback.at(-1).nextAction, /不要重复相同空查询/);
  assert.equal(project.runtime.queryStopped, undefined);
  assert.equal(project.evidence[0].returnedEntities.length, 0);
  assert.equal(project.status.phase, 'insufficient_evidence');
  assert.equal(project.version, 1, 'classification does not accept an invalid proposal');
  assert.equal(project.evidence[0].rawResult.status, 'ok', 'official raw status stays untouched');
  fixtures.push({ name: 'remote_empty', project: structuredClone(project), modelFeedback: result.modelFeedback.at(-1) });
  reset();
});

test('exact describe fields support two bounded drafts without recommendation entities or affinity', async () => {
  reset();
  const project = createProject({ brief });
  const entity = { entity_id: 'mock-describe-entity', name: '合成描述参考', properties: { description: '电子音乐与数字叙事；合成返回字段。' } };
  const card = recordEvidence(project, 'describe', { entity: '合成描述参考', type: 'artist' },
    { correlationId: 'mock-describe-no-network', result: { status: 'ok', results: [entity] } });
  const link = { evidenceId: card.id, entityId: entity.entity_id, observedField: 'properties.description', observedValue: entity.properties.description,
    observation: '描述字段仅确认文化参考的文本特征；未验证受众偏好。', inspiration: '将文本特征转译为两种参与组织，这是设计推断。' };
  const runtime = await createProductRuntime(project, { env: {}, decide() {
    return [proposalCall(project, { phase: 'ready', summary: '模拟 describe 精确字段支持的讨论草案，非受众或效果证据。',
      concepts: [concept(project, 0, [link]), concept(project, 1, [link])] })];
  } });
  try {
    await runtime.submit(brief.request);
    assert.equal(project.status.phase, 'ready');
    assert.equal(project.concepts.length, 2);
    assert.equal(project.usage.modelCalls, 1, 'accepted terminal proposal skips the unnecessary closing callback');
    assert.equal(project.usage.qlooHttpAttempts, 0);
    assert.equal(project.evidence.length, 1);
    assert.equal(project.evidence[0].query.workflow, 'describe');
    assert.equal(Object.hasOwn(entity, 'affinity'), false);
    fixtures.push({ name: 'describe_only_draft', project: structuredClone(project), modelFeedback: project.runtime.feedback });
    const invalid = proposalCall(project, { phase: 'ready', concepts: structuredClone(project.concepts) }).arguments;
    invalid.concepts[0].evidenceLinks[0].observedValue = 'fabricated';
    assert.throws(() => applyProposal(project, { ...invalid, projectId: project.id }), /实际返回不符/);
  } finally { await runtime.dispose(); }
});

test('sixth mocked model HTTP accepts terminal proposal or retains precise rejection without a seventh request', async () => {
  for (const accepted of [true, false]) {
    reset();
    const project = createProject({ brief, mode: 'live' });
    const result = await mockLive(project, (_body, turn) => {
      if (turn < 6) return [{ type: 'toolCall', id: `invalid-${turn}`, name: 'propose_design_response', arguments: {} }];
      return [proposalCall(project, accepted ? {} : { phase: 'ready', concepts: [concept(project, 0), concept(project, 1)] }, 'sixth-proposal')];
    });
    assert.equal(result.modelRequests, 6);
    assert.equal(project.usage.modelCalls, 6);
    assert.equal(project.usage.modelHttpAttempts, 6);
    assert.equal(project.runtime.failure, undefined);
    assert.equal(project.runtime.feedback.remainingBudget.modelHttpAttempts, 0);
    assert.equal(project.runtime.feedback.code, accepted ? 'PROPOSAL_ACCEPTED' : 'EVIDENCE_INSUFFICIENT');
    assert.equal(project.runtime.feedback.path, accepted ? '/' : '/concepts/0/evidenceLinks');
    assert.match(project.runtime.feedback.nextAction, /禁止继续模型请求/);
    assert.equal(project.status.phase, 'insufficient_evidence');
    assert.equal(project.version, accepted ? 2 : 1, 'an evidence refusal never applies the rejected proposal');
  }
  reset();
});

test('source model/shared budget blocks are safe and a later successful operation clears a local error', async () => {
  reset();
  const project = createProject({ brief, mode: 'live' });
  project.runtime.httpAttempts = [{ kind: 'model', status: 200, outcome: 'response_ok' }];
  serverUsage.modelHttpAttempts = 12;
  let fetches = 0;
  const guarded = budgetedFetch(async () => { fetches++; return Response.json({}); });
  await assert.rejects(() => withHttpBudget(project, 'model', 'https://model.invalid', () => guarded('https://model.invalid/chat/completions')));
  const failure = safeRuntimeFailure(project, 'model');
  assert.equal(failure.code, 'MODEL_HTTP_BUDGET_EXHAUSTED');
  assert.equal(failure.status, null);
  assert.equal(failure.remainingBudget.caseRemaining.modelHttpAttempts, 6);
  assert.equal(failure.remainingBudget.sharedRemaining.modelHttpAttempts, 0);
  assert.equal(failure.remainingBudget.modelHttpAttempts, 0);
  assert.equal(fetches, 0);
  serverUsage.modelHttpAttempts = 0;
  await withHttpBudget(project, 'model', 'https://model.invalid', () => guarded('https://model.invalid/chat/completions'));
  assert.equal(project.runtime.localFailure, undefined);
  assert.equal(fetches, 1);
  assert.equal(safeRuntimeFailure(project, 'model').status, null, 'an OK HTTP cannot itself be presented as a failed status');
  reset();
});

test('last model HTTP followed by a successful query reports model budget exhaustion rather than query failure', async () => {
  reset();
  const project = createProject({ brief, mode: 'live' });
  const entity = { entity_id: '11111111-1111-4111-8111-111111111111', name: '合成参考', type: 'urn:entity:artist', properties: { description: '模拟描述。' } };
  const result = await mockLive(project, (_body, turn) => turn < 6
    ? [{ type: 'toolCall', id: `invalid-before-query-${turn}`, name: 'propose_design_response', arguments: {} }]
    : [{ type: 'toolCall', id: 'last-turn-query', name: 'qloo_describe', arguments: { entity: '合成参考', type: 'artist' } }],
  destination => destination.pathname === '/search' ? { results: [entity] } : { results: { entities: [entity] } });
  assert.equal(result.modelRequests, 6);
  assert.equal(result.qlooRequests, 2);
  assert.equal(project.runtime.feedback.code, 'MODEL_HTTP_BUDGET_EXHAUSTED');
  assert.equal(project.runtime.feedback.remainingBudget.modelHttpAttempts, 0);
  assert.equal(project.runtime.failure, undefined);
  assert.equal(project.status.phase, 'error');
  assert.equal(project.version, 1);
  assert.equal(project.evidence.length, 1);
  reset();
});

test('official executor wrapping cannot erase a source block after the last available Qloo HTTP', async () => {
  reset();
  const project = createProject({ brief, mode: 'live' });
  project.usage.qlooHttpAttempts = 5; // Explicit mock: five earlier case attempts.
  const result = await mockLive(project, (_body, turn) => turn === 1
    ? [{ type: 'toolCall', id: 'last-qloo-http', name: 'qloo_recommend', arguments: { target_type: 'artist', signals: ['合成参考'], limit: 2 } }]
    : [{ type: 'text', text: '模拟模型收到源头额度拒绝，停止追加查询。' }], () => ({ results: [
      { entity_id: '11111111-1111-4111-8111-111111111111', name: '合成参考', type: 'urn:entity:artist' },
    ] }));
  assert.equal(result.qlooRequests, 1);
  assert.equal(result.modelRequests, 2);
  assert.equal(project.usage.qlooHttpAttempts, 6);
  assert.equal(project.runtime.failure.code, 'QLOO_HTTP_BUDGET_EXHAUSTED');
  assert.equal(project.runtime.failure.status, null);
  assert.equal(result.modelFeedback.at(-1).code, 'QLOO_HTTP_BUDGET_EXHAUSTED');
  assert.equal(project.runtime.httpAttempts.findLast(entry => entry.kind === 'qloo').status, 200);
  assert.equal(project.evidence.length, 0);
  reset();
});

test('write explicit mock-only evidence for four UI distinctions', () => {
  assert.equal(fixtures.length, 5);
  const outputDir = mkdtempSync(join(tmpdir(), 'art-feedback-test-'));
  const path = join(outputDir, 'offline-cases.json');
  try {
    writeFileSync(path, JSON.stringify({
    mode: 'OFFLINE MOCK / FIXTURE — NOT PRODUCT ACCEPTANCE', mock: true, fixture: true, noRealNetwork: true,
    outboundRealModelRequests: 0, outboundRealQlooRequests: 0, simulatedCounters: true,
    modelFeedbackBudgetSemantics: '模型读取到的反馈余额包含该次读取请求；project.runtime.feedback为submit结束后的当前余额，actions保留当时快照。',
    realHttpAttempts: { model: 0, qloo: 0 }, boundary: '实际使用安装的官方会话与公开钩子，模型及Qloo HTTP均被本地模拟；不构成真实产品验收。',
    cases: fixtures,
    }, null, 2) + '\n');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).cases.length, 5);
  } finally {
    assert.equal(dirname(resolve(outputDir)), resolve(tmpdir()));
    assert(outputDir.startsWith(join(tmpdir(), 'art-feedback-test-')));
    rmSync(outputDir, { recursive: true, force: true });
  }
});
