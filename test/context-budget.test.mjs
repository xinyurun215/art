import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { createQlooTools } from '@qloo/qloo-harness';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { evidenceView, assembleContext, readProjectEvidence, requestBudget } from '../app/context.mjs';
import { createProductRuntime, recordEvidence, wrapProjectExecutor } from '../app/runtime.mjs';
import { budgetedFetch, createDiagnosticFetch, remainingBudget, serverUsage, validationRun, withHttpBudget } from '../app/transport.mjs';
import { beginPendingFeedback, beginRevision, createProject, proposeRevision, selectConcept } from '../app/state.mjs';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
function sourceProject() {
  const project = createProject({ brief: { request: '合成材料观察项目', venue: '测试室内', mustKeep: ['触摸样本'] } });
  project.concepts = ['a', 'b'].map(id => ({ id, title: `正式标题${id}`, coreClaim: '触摸样本并记录观察',
    mechanism: { organization: `original-${id}`, description: '触摸样本，完成个人观察记录' },
    journey: [{ stage: '参与', action: '触摸样本并记录' }], productTouchpoints: ['触摸样本'],
    evidenceLinks: [{ evidenceId: 'synthetic-description', observation: '合成描述，仅用于上下文测试' }],
    openQuestions: ['参与容量未知'], unverifiedEffects: ['效果未验证'] }));
  project.evidence = [{ id: 'synthetic-description', projectId: project.id, query: { workflow: 'describe' },
    returnedEntities: [{ entity_id: 'synthetic-entity', properties: { short_description: 'Synthetic material observation reference.' } }] }];
  selectConcept(project, { conceptId: 'a', baseVersion: project.version });
  project.lockedFields = ['productTouchpoints'];
  const request = beginRevision(project, { conceptId: 'a', baseVersion: project.version, text: '增加记录互读' });
  proposeRevision(project, { requestId: request.id, phase: 'pending', summary: '合成待审稿，仅用于上下文测试',
    changes: [{ field: 'mechanism', after: { organization: 'draft-pairs', description: '触摸样本后轮流互读观察记录' },
      reason: '合成设计推断', evidenceRefs: [] }], impact: ['调整记录交流方式'], unknowns: ['参与意愿未知'] });
  return project;
}
const source = sourceProject();
const env = { ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'deepseek', ART_MODEL_ID: 'deepseek-flash',
  ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://api.deepseek.com',
  ART_MODEL_API_KEY: 'synthetic-local-only-key', QLOO_API_KEY: 'synthetic-local-only-qloo-key',
  QLOO_API_URL: 'https://hackathon.api.qloo.com' };

function replay(t) {
  validationRun.liveStopped = false;
  const project = structuredClone(source);
  project.id = randomUUID();
  project.mode = 'live';
  project.runtime.sessionFile = null;
  for (const evidence of project.evidence) evidence.projectId = project.id;
  for (const revision of project.revisions) revision.projectId = project.id;
  beginPendingFeedback(project, project.revisions[0].id,
    { baseVersion: project.version, text: '只调整当前待审稿的参与顺序' });
  project.status = { phase: 'busy', detail: '离线回放中' };
  const directory = join(root, '.art-runtime', project.id);
  t.after(() => {
    assert(resolve(directory).startsWith(resolve(root, '.art-runtime') + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  return { project, directory };
}

test('two live submissions use separate persisted sessions with the configured output capacity', async t => {
  const { project } = replay(t);
  const sent = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = budgetedFetch(async (_url, options) => {
    sent.push(JSON.parse(options.body));
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'offline-two-turns',
      object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: '合成回复' }) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  t.after(() => { globalThis.fetch = previousFetch; });
  const runtime = await createProductRuntime(project, { env });
  try {
    await runtime.submit(project.revisionRequest.text);
    const firstPath = project.runtime.sessionFile;
    const firstBytes = readFileSync(firstPath);
    beginPendingFeedback(project, project.revisions[0].id,
      { baseVersion: project.version, text: '第二轮只补充顺序反馈' });
    await runtime.submit(project.revisionRequest.text);
    assert.equal(sent.length, 2);
    assert(sent.every(body => body.max_tokens === 12000));
    assert(sent.every(body => body.thinking?.type === 'disabled'));
    assert(sent.every(body => body.tools.length === 2 && body.tools[0].function.name === 'propose_concept_revision' && body.tools[1].function.name === 'read_project_evidence'));
    const attempts = project.runtime.httpAttempts.filter(attempt => attempt.kind === 'model').slice(-2);
    assert.equal(attempts.length, 2);
    assert(attempts.every(attempt => attempt.generationBudget.model === 'deepseek-flash'
      && attempt.generationBudget.contextWindow === 65536
      && attempt.generationBudget.estimatedInputTokens > 0
      && attempt.generationBudget.safetyTokens === 4096
      && attempt.generationBudget.reservedOutputTokens === 12000
      && attempt.generationBudget.finalMaxTokens === 12000));
    assert.notEqual(project.runtime.sessionFile, firstPath);
    assert(project.runtime.sessionHistory.includes(firstPath));
    assert.deepEqual(readFileSync(firstPath), firstBytes);
    assert.equal(project.usage.modelHttpAttempts, source.usage.modelHttpAttempts + 2);
    assert.equal(project.usage.qlooHttpAttempts, source.usage.qlooHttpAttempts);
  } finally { await runtime.dispose(); }
});

test('fetch boundary accepts the supported max_completion_tokens field without changing the HTTP budget', async t => {
  const { project } = replay(t);
  project.runtime.generationBudget = { model: 'deepseek-flash', contextWindow: 32000,
    estimatedInputTokens: 8000, safetyTokens: 4096, reservedOutputTokens: 12000, finalMaxTokens: 12000 };
  let sends = 0;
  const fetch = budgetedFetch(async () => { sends++; return new Response('{}'); });
  const before = project.usage.modelHttpAttempts;
  await withHttpBudget(project, 'model', env.ART_MODEL_BASE_URL, () =>
    fetch('https://api.deepseek.com/chat/completions',
      { method: 'POST', body: JSON.stringify({ model: 'deepseek-flash', max_completion_tokens: 12000 }) }));
  assert.equal(sends, 1);
  assert.equal(project.usage.modelHttpAttempts, before + 1);
  assert.equal(project.runtime.httpAttempts.at(-1).generationBudget.finalMaxTokens, 12000);
});

function mockTransport() {
  const bodies = [];
  const guarded = createDiagnosticFetch(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'offline-capacity', object: 'chat.completion.chunk',
      created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: '合成回复' }) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return { bodies, guarded };
}

function evidenceResult(count) {
  return { schema_version: '1.0-preview.1', status: count ? 'ok' : 'empty',
    interpretation: { signals: [{ entityId: 'synthetic-reference', name: 'Synthetic reference', type: 'urn:entity:artist', match: 'exact' }] },
    results: Array.from({ length: count }, (_, index) => ({ entity_id: `synthetic-result-${index}`, name: `Synthetic result ${index}`,
      affinity: 0.43, popularity: 0.27, score: 0.39, explainability: { signal: 'synthetic-reference', weight: 0.1 },
      properties: { description: `Unabridged synthetic description ${index}. `.repeat(30), extra: { tags: ['one', 'two'] } } })),
    explainability: { method: 'synthetic-only', detail: 'Do not infer audience behavior' },
    provenance: { source: 'synthetic-no-http', requestId: 'synthetic-request' },
    query_intent: { operation: 'recommend', target_type: 'movie', limit: count },
    warnings: [{ code: 'SYNTHETIC_BOUNDARY', message: 'Complete synthetic warning' }] };
}

test('Qloo tool JSON keeps complete results once and evidence metadata maps to the intact authoritative card', async () => {
  for (const [operation, count] of [['describe', 1], ['recommend', 12], ['recommend', 0]]) {
    const project = createProject({ mode: 'live', brief: { request: 'Synthetic evidence projection', venue: 'Synthetic room' } });
    const result = evidenceResult(count);
    const before = structuredClone(result);
    const executor = wrapProjectExecutor(project, { transport: { kind: 'direct', remote: false },
      async execute() { return { correlationId: 'synthetic-no-http', result }; } }, { QLOO_API_URL: 'https://qloo.invalid' });
    const tool = createQlooTools({ executor }).find(tool => tool.name === `qloo_${operation}`);
    const input = operation === 'describe' ? { entity: 'Synthetic reference', type: 'artist' }
      : { target_type: 'movie', signals: ['Synthetic reference'], limit: 12 };
    const output = await tool.execute('synthetic-projection', input);
    const value = JSON.parse(output.content.find(block => block.type === 'text').text);
    const card = project.evidence.find(card => card.id === value.artEvidence.id);
    assert(card);
    assert.deepEqual(card.rawResult, before);
    assert.deepEqual(card.returnedEntities, before.results);
    const { rawResult, returnedEntities, ...metadata } = card;
    assert.equal(Object.hasOwn(value.artEvidence, 'rawResult'), false);
    assert.equal(Object.hasOwn(value.artEvidence, 'returnedEntities'), false);
    assert.deepEqual(value.artEvidence, metadata);
    assert.deepEqual(value.results, before.results);
    assert.deepEqual(value.provenance, before.provenance);
    assert.deepEqual(value.explainability, before.explainability);
    assert.deepEqual(value.warnings, before.warnings);
    if (count) assert.equal(card.returnedEntities.find(entity => entity.entity_id === value.results[0].entity_id).properties.description,
      value.results[0].properties.description);
    assert.deepEqual(result, before);
    assert.equal(project.usage.qlooHttpAttempts, 0);
  }
});

test('every mocked live send stays bounded through giant Qloo, exact read and proposal correction rounds', async t => {
  const { project } = replay(t);
  delete project.revisionRequest;
  Object.assign(project, { evidence: [], concepts: [], revisions: [], version: 1, selectedConceptId: null });
  Object.assign(serverUsage, { modelHttpAttempts: 0, qlooHttpAttempts: 0 });
  validationRun.queryStopped = false; delete validationRun.failure;
  const raw = evidenceResult(10);
  raw.results[0].properties.description = 'Synthetic giant field. '.repeat(20000);
  const rawBefore = structuredClone(raw);
  const sends = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = budgetedFetch(async (url, options) => {
    assert.equal(new URL(String(url)).origin, env.ART_MODEL_BASE_URL);
    const body = JSON.parse(options.body); sends.push(body);
    assert.equal(body.max_tokens, 12000);
    assert.equal(requestBudget(body, { contextWindow: 32000, maxTokens: 12000 }).fits, true);
    const card = project.evidence[0];
    let name = 'qloo_describe', args = { entity: 'Synthetic seed', type: 'artist' };
    if (sends.length === 2) { name = 'read_project_evidence'; args = { evidenceId: card.id, entityId: 'synthetic-result-1', field: 'properties.description' }; }
    if (sends.length >= 3) {
      name = 'propose_design_response';
      const link = { evidenceId: card.id, entityId: 'synthetic-result-1',
        observedField: sends.length === 3 ? 'properties.absent' : 'properties.description',
        observedValue: raw.results[1].properties.description, observation: 'Synthetic exact field', inspiration: 'Synthetic design inference; effects unknown' };
      args = { baseVersion: project.version, phase: 'ready', summary: 'Synthetic bounded proposal', concepts: ['a', 'b'].map(id => ({ id, title: id,
        coreClaim: '触摸样本并记录观察', mechanism: { organization: id, description: id === 'a'
          ? '小组按固定轮次触摸样本并互相记录观察' : '个人自选顺序触摸样本并独立记录观察' },
        journey: ['到场', '参与', '带走'].map(stage => ({ stage, action: '触摸样本并记录观察' })), productTouchpoints: ['触摸样本'],
        evidenceLinks: [link], openQuestions: ['容量未知'], unverifiedEffects: ['效果未知'] })) };
    }
    const chunk = (delta, finish_reason = null, usage) => `data: ${JSON.stringify({ id: 'synthetic-bounded-live', object: 'chat.completion.chunk', created: 0,
      model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
    return new Response(chunk({ role: 'assistant', reasoning_content: 'SYNTHETIC_PROTOCOL_ONLY', tool_calls: [{ index: 0, id: `live-${sends.length}`, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] }) + chunk({}, 'tool_calls', { prompt_tokens: 50000, completion_tokens: 20000, total_tokens: 70000 }) + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  });
  t.after(() => { globalThis.fetch = previousFetch; });
  const runtime = await createProductRuntime(project, { env });
  const fake = wrapProjectExecutor(project, { transport: { kind: 'direct', remote: false },
    async execute() { return { result: raw, correlationId: 'synthetic-no-qloo-http' }; } }, env);
  const qloo = createQlooTools({ executor: fake }).find(tool => tool.name === 'qloo_describe');
  const originalBefore = runtime.session.agent.beforeToolCall;
  runtime.session.agent.beforeToolCall = async context => {
    const previous = await originalBefore(context);
    if (context.toolCall.name === qloo.name) context.context.tools.find(tool => tool.name === qloo.name).execute = qloo.execute;
    return previous;
  };
  try {
    await runtime.submit('Synthetic giant evidence and continuous proposal correction');
    assert.equal(sends.length, 4, JSON.stringify({ failure: project.runtime.failure, budget: project.runtime.generationBudget,
      feedback: project.runtime.feedback, toolNames: project.runtime.toolNames }));
    assert.equal(project.version, 2); assert.equal(project.concepts.length, 2);
    assert.deepEqual(project.evidence[0].rawResult, rawBefore);
    assert.equal(project.usage.modelHttpAttempts, 4); assert.equal(project.usage.qlooHttpAttempts, 0);
    assert.equal(project.runtime.failure, undefined);
    assert.equal(project.runtime.sessionHistory?.length ?? 0, 0);
    assert.equal(project.runtime.generationBudget.finalMaxTokens, 12000);
    for (const body of sends.slice(1)) {
      assert.equal(body.messages.filter(message => message.role === 'assistant').length, 1);
      assert.equal(body.messages.filter(message => message.role === 'tool').length, 1);
    }
  } finally { await runtime.dispose(); }
});

test('initial model payload omits duplicate raw evidence results and preserves unique workflow context', async t => {
  const { project } = replay(t);
  delete project.revisionRequest;
  project.evidence = [];
  const result = evidenceResult(12);
  const card = recordEvidence(project, 'recommend', { target_type: 'movie', signals: ['Synthetic reference'], limit: 12 },
    { correlationId: 'synthetic-saved-evidence', result });
  const before = structuredClone(project.evidence);
  const { rawResult, ...modelCard } = card;
  const { results, ...workflowContext } = rawResult;
  const { bodies, guarded } = mockTransport();
  const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: guarded.fetch } });
  try {
    await runtime.submit('Use the complete saved synthetic evidence');
    assert.equal(bodies.length, 1);
    const user = bodies[0].messages.find(message => message.role === 'user');
    const current = JSON.parse(typeof user.content === 'string' ? user.content : user.content.map(block => block.text ?? '').join(''));
    assert.equal(JSON.stringify(current.project.evidence).includes('"rawResult"'), false);
    assert.deepEqual(current.project.evidence, [evidenceView(card)]);
    assert.equal(current.project.evidence[0].returnedEntities.length, result.results.length);
    assert.equal(current.project.evidence[0].returnedEntities[0].observedFields, undefined);
    assert.deepEqual(project.evidence, before);
    assert.equal(bodies[0].max_tokens, 12000);
    assert.equal(bodies[0].thinking, undefined);
  } finally { await runtime.dispose(); }
});

const authority = project => structuredClone(Object.fromEntries(['version', 'brief', 'concepts', 'revisions', 'evidence',
  'selectedConceptId', 'lockedFields'].map(key => [key, project[key]])));
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function contractRecovery(t, mode = 'proposal', condition = 'accept') {
  const { project } = replay(t);
  Object.assign(serverUsage, { modelHttpAttempts: 0, qlooHttpAttempts: 0 });
  validationRun.queryStopped = false; delete validationRun.failure;
  delete project.revisionRequest;
  if (mode === 'proposal') { project.concepts = []; project.revisions = []; project.version = 1; project.selectedConceptId = null; }
  const card = recordEvidence(project, 'recommend', { target_type: 'movie', signals: ['Synthetic reference'], limit: 12 },
    { correlationId: 'synthetic-recovery-evidence', result: evidenceResult(12) });
  const reference = { evidenceId: card.id, entityId: card.returnedEntities[0].entity_id,
    observedField: 'properties.description', observedValue: card.returnedEntities[0].properties.description,
    observation: 'Synthetic exact returned field', inspiration: 'Synthetic design inference, not an audience fact' };
  if (mode === 'revision') {
    project.revisions[0].changes[0].evidenceRefs = [reference];
    beginPendingFeedback(project, project.revisions[0].id, { baseVersion: project.version, text: 'Synthetic bounded correction' });
  }
  if (condition === 'oversized') project.brief.request = 'synthetic-oversized-evidence-context-'.repeat(7000);
  if (condition === 'stale-feedback') project.runtime.feedback = { code: 'EVIDENCE_FIELD_MISSING', path: '/old',
    reason: 'Synthetic previous-submit rejection', correctable: true };
  const before = authority(project);
  const bodies = [], states = [], events = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = budgetedFetch(async (url, options) => {
    assert.equal(new URL(String(url)).origin, env.ART_MODEL_BASE_URL, 'synthetic transport must never query Qloo');
    const body = JSON.parse(options.body); bodies.push(body); states.push(authority(project));
    const invalid = (bodies.length === 1 || condition === 'reject-again')
      && !['schema', 'mechanism-extra-key', 'mechanism-extra-key-again', 'no-change'].includes(condition) && !condition.startsWith('shape-');
    const link = { ...reference, ...(invalid ? { observedField: 'returnedEntities[].properties.description' } : {}) };
    let name = 'propose_design_response';
    let args = { baseVersion: project.version, phase: 'ready', summary: 'Synthetic contract candidate', questions: [],
      concepts: ['a', 'b'].map(id => ({ id: `synthetic-${id}`, title: id, coreClaim: '触摸样本并记录观察',
        mechanism: { organization: `synthetic-${id}`, description: id === 'a'
          ? '小组按固定轮次触摸样本并互相记录观察' : '个人自选顺序触摸样本并独立记录观察' },
        journey: ['到场', '参与', '带走'].map(stage => ({ stage, action: '触摸样本并记录观察' })),
        productTouchpoints: ['触摸样本'], evidenceLinks: [link], openQuestions: ['条件待验证'], unverifiedEffects: ['效果未验证'] })) };
    if (mode === 'revision') {
      name = 'propose_concept_revision';
      args = { phase: 'pending', summary: 'Synthetic contract correction', changes: [{ field: 'mechanism',
        after: { organization: 'corrected-pairs', description: '触摸样本后自主记录，再轮流互读' },
        reason: 'Synthetic bounded revision', evidenceRefs: [link] }], impact: ['记录顺序改变'], unknowns: ['效果未验证'] };
      if (condition === 'locked') Object.assign(args.changes[0], { field: 'productTouchpoints', after: ['触摸样本的新锁定变更'], evidenceRefs: [] });
      if (condition === 'schema' && bodies.length === 1) delete args.impact;
      if (condition === 'mechanism-extra-key-again' || condition === 'mechanism-extra-key' && bodies.length === 1)
        args.changes[0].after[''] = '';
      if (condition.startsWith('shape-')) {
        const field = condition.slice(6);
        const journey = ['到场', '参与', '带走'].map(stage => ({ stage, action: '触摸样本并互读记录' }));
        const values = { title: ['', '合成修订标题'], journey: [[{ ...journey[0], '': '' }, ...journey.slice(1)], journey],
          evidenceLinks: [{}, [...project.concepts[0].evidenceLinks, reference]], unverifiedEffects: [[], ['合成效果仍未验证']] };
        Object.assign(args.changes[0], { field, after: values[field][bodies.length === 1 ? 0 : 1] });
      }
      if (condition === 'no-change') args.changes[0].after = structuredClone(project.revisions[0].changes[0].after);
    }
    if (condition === 'exhausted') project.usage.modelHttpAttempts = remainingBudget(project).caseLimits.modelHttpAttempts;
    if (condition === 'global-stop') {
      validationRun.liveStopped = true;
      validationRun.failure = { code: 'SYNTHETIC_DURABLE_STOP' };
    }
    if (condition === 'existing-failure') project.runtime.failure = { kind: 'model', code: 'SYNTHETIC_EXISTING_FAILURE', summary: 'Synthetic stop' };
    if (condition === 'http-error') return Response.json({ error: { message: 'Synthetic HTTP failure' } }, { status: 500 });
    const delta = condition === 'stale-feedback' ? { role: 'assistant', content: 'Synthetic text, no current contract rejection' }
      : { role: 'assistant', ...(mode === 'proposal' ? { reasoning_content: 'SYNTHETIC_ONLY_OLD_SESSION_REASONING' } : {}),
        tool_calls: [{ index: 0, id: `synthetic-candidate-${bodies.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    const chunk = (delta, finish_reason, usage) => `data: ${JSON.stringify({ id: 'synthetic-contract-recovery', object: 'chat.completion.chunk',
      created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
    return new Response(chunk(delta, null) + chunk({}, condition === 'stale-feedback' ? 'stop' : 'tool_calls',
      { prompt_tokens: 11883, completion_tokens: 7720, total_tokens: 19603,
        completion_tokens_details: { reasoning_tokens: mode === 'proposal' ? 3756 : 0 } }) + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
  });
  const runtime = await createProductRuntime(project, { env });
  const originalSession = project.runtime.sessionFile;
  let endedHash, beforeToolCalls = 0;
  const originalBeforeToolCall = runtime.session.agent.beforeToolCall;
  runtime.session.agent.beforeToolCall = async (...args) => { beforeToolCalls++; return originalBeforeToolCall(...args); };
  runtime.session.subscribe(event => {
    if (event.type === 'agent_end' && !endedHash) endedHash = fileHash(originalSession);
    if (event.type === 'tool_execution_end') events.push({ feedback: event.result?.details?.feedback,
      accepted: event.result?.details?.accepted, completed: event.result?.details?.completed,
      isError: event.isError, feedbackCode: project.runtime.feedback?.code, feedbackPath: project.runtime.feedback?.path });
  });
  try { await runtime.submit(project.revisionRequest?.text ?? 'Use complete synthetic evidence and correct only invalid references'); }
  finally { await runtime.dispose(); globalThis.fetch = originalFetch; }
  return { project, before, bodies, states, events, originalSession, endedHash, beforeToolCalls };
}

test('proactive context accepts a contract correction in the same official session', async t => {
  for (const mode of ['proposal', 'revision']) {
    const { project, before, bodies, states, events, originalSession } = await contractRecovery(t, mode);
    assert.equal(bodies.length, 2);
    assert.equal(events[0].feedback.code, 'EVIDENCE_FIELD_MISSING');
    assert(events[1].accepted === true || events[1].completed === true);
    assert.deepEqual(states, [before, before]);
    const content = bodies[1].messages.find(message => message.role === 'user').content;
    const current = JSON.parse(typeof content === 'string' ? content : content.map(block => block.text).join(''));
    assert.equal(current.project.previousFeedback.code, 'EVIDENCE_FIELD_MISSING');
    for (const card of current.project.evidence) assert.deepEqual(card, evidenceView(before.evidence.find(saved => saved.id === card.id)));
    assert(bodies[1].messages.some(message => message.role === 'assistant'));
    assert(bodies[1].messages.some(message => message.role === 'tool'));
    assert(bodies.every(body => body.max_tokens === 12000));
    assert.equal(project.runtime.sessionFile, originalSession);
    assert.equal(project.runtime.sessionHistory?.length ?? 0, 0);
    assert.equal(project.actions.filter(action => action.type === 'recovery').length, 0);
    assert.deepEqual(project.evidence, before.evidence);
    assert.equal(project.usage.modelHttpAttempts, 2);
    assert.equal(project.usage.qlooHttpAttempts, 0);
    assert.equal(project.runtime.failure, undefined);
    assert.equal(validationRun.liveStopped, false);
    assert.equal(project.runtime.generationBudget.estimateMethod, 'offline-serialized-ascii4-other1');
    assert(project.runtime.generationBudget.estimatedInputTokens + 12000 + 4096 <= 65536);
  }
});

test('strict business and native schema corrections continue without a recovery session', async t => {
  for (const condition of ['schema', 'mechanism-extra-key', 'shape-title', 'shape-journey', 'shape-evidenceLinks', 'shape-unverifiedEffects']) {
    const { project, before, bodies, events, originalSession, beforeToolCalls } = await contractRecovery(t, 'revision', condition);
    assert.equal(bodies.length, 2, condition);
    assert.equal(beforeToolCalls, condition === 'schema' ? 1 : 2);
    assert.equal(events[0].isError, true);
    assert.equal(events[0].feedbackCode, 'REVISION_SCHEMA_INVALID');
    assert.equal(events[1].completed, true);
    assert.deepEqual(project.concepts, before.concepts);
    assert.deepEqual(project.evidence, before.evidence);
    assert.equal(project.version, before.version);
    assert.equal(project.revisions.at(-1).status, 'pending');
    assert.equal(project.runtime.sessionFile, originalSession);
    assert.equal(project.runtime.sessionHistory?.length ?? 0, 0);
    assert.equal(project.usage.modelHttpAttempts, 2);
    assert.equal(project.usage.qlooHttpAttempts, 0);
  }
});

test('continuous invalid proposals stop at the existing HTTP limit without changing authority', async t => {
  for (const [mode, condition] of [['proposal', 'reject-again'], ['revision', 'mechanism-extra-key-again'], ['revision', 'locked'], ['revision', 'no-change']]) {
    const { project, before, bodies, originalSession } = await contractRecovery(t, mode, condition);
    assert.equal(bodies.length, remainingBudget(project).caseLimits.modelHttpAttempts, condition);
    assert.deepEqual(authority(project), before);
    assert.equal(project.runtime.sessionFile, originalSession);
    assert.equal(project.runtime.sessionHistory?.length ?? 0, 0);
    assert.equal(project.runtime.feedback.remainingBudget.modelHttpAttempts, 0);
    assert.equal(project.usage.qlooHttpAttempts, 0);
  }
});

test('proactive context respects irreducible overflow and existing stop gates', async t => {
  for (const condition of ['oversized', 'stale-feedback', 'exhausted', 'global-stop', 'existing-failure', 'http-error']) {
    const { project, before, bodies } = await contractRecovery(t, 'proposal', condition);
    assert.equal(bodies.length, condition === 'oversized' ? 0 : 1, condition);
    assert.equal(project.runtime.sessionHistory?.length ?? 0, 0);
    assert.deepEqual(authority(project), before);
    if (condition === 'oversized') {
      assert.equal(project.runtime.failure.code, 'MODEL_CONTEXT_CAPACITY_INSUFFICIENT');
      assert(project.runtime.generationBudget.components.work > 32000);
      assert.equal(project.runtime.generationBudget.largestComponent, 'work');
      assert(project.runtime.failure.reason.includes('the current working state'));
      assert(project.runtime.generationBudget.overByTokens > 0);
    }
    if (condition === 'global-stop') assert.equal(validationRun.failure.code, 'SYNTHETIC_DURABLE_STOP');
    if (condition === 'existing-failure') assert.equal(project.runtime.failure.code, 'SYNTHETIC_EXISTING_FAILURE');
  }
});

test('revision thinking override preserves payload hooks and the final output-capacity gate', async t => {
  for (const kind of ['mutate', 'replace', 'reduced-output', 'oversized-wrapper']) {
    const { project } = replay(t);
    if (kind === 'mutate') {
      project.revisions = [];
      delete project.revisionRequest;
      beginRevision(project, { conceptId: 'a', baseVersion: project.version, text: 'Synthetic local revision' });
    }
    const { bodies, guarded } = mockTransport();
    const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: guarded.fetch } });
    let hooks = 0;
    runtime.session.agent.onPayload = async (payload, model) => {
      hooks++;
      assert.equal(model.api, 'openai-completions');
      await Promise.resolve();
      const updated = { ...payload, temperature: 0.25, thinking: { type: 'enabled' },
        ...(kind === 'reduced-output' ? { max_tokens: 11999 } : {}),
        ...(kind === 'oversized-wrapper' ? { injectedWrapper: 'synthetic oversized wrapper '.repeat(10000) } : {}) };
      if (kind === 'mutate') Object.assign(payload, updated);
      else return updated;
    };
    try {
      await runtime.submit(project.revisionRequest.text);
      assert.equal(hooks, 1);
      if (['reduced-output', 'oversized-wrapper'].includes(kind)) {
        assert.equal(bodies.length, 0);
        assert.equal(project.runtime.failure?.code, 'MODEL_CONTEXT_CAPACITY_INSUFFICIENT');
        assert.equal(project.runtime.generationBudget.finalMaxTokens, kind === 'reduced-output' ? 11999 : 12000);
        if (kind === 'oversized-wrapper') assert(project.runtime.generationBudget.components.wrappers > 65536);
      } else {
        assert.equal(bodies.length, 1);
        assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
        assert.equal(bodies[0].temperature, 0.25);
        assert.equal(bodies[0].max_tokens, 12000);
      }
    } finally { await runtime.dispose(); }
  }
});

test('thinking stays unchanged outside running official DeepSeek completion revisions', async t => {
  for (const variation of [
    { status: null }, { status: 'error' },
    { ART_MODEL_PROVIDER: 'openai', ART_MODEL_BASE_URL: 'https://api.openai.com/v1' },
    { ART_MODEL_BASE_URL: 'https://api.deepseek.com.example.invalid' },
    { ART_MODEL_BASE_URL: 'http://api.deepseek.com' },
    { ART_MODEL_BASE_URL: 'https://api.deepseek.com:8443' },
    { ART_MODEL_API: 'openai-responses' },
  ]) {
    const { project } = replay(t);
    const { status, ...environment } = variation;
    if (status === null) delete project.revisionRequest;
    else if (status) project.revisionRequest.status = status;
    const bodies = [];
    const runtime = await createProductRuntime(project, { env: { ...env, ...environment }, diagnostic: {
      async fetch(_url, options) {
        bodies.push(JSON.parse(options.body));
        return new Response('{"error":{"message":"Synthetic local stop"}}', { status: 400 });
      },
    } });
    try {
      await runtime.submit('Synthetic request');
      assert.equal(bodies.length, 1, JSON.stringify(variation));
      assert.equal(bodies[0].thinking, undefined, JSON.stringify(variation));
    } finally { await runtime.dispose(); }
  }
});

test('saved pending-feedback state starts a fresh live context and preserves its older session', async t => {
  const { project, directory } = replay(t);
  const sessionDir = join(directory, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  const old = SessionManager.create(root, sessionDir);
  old.appendMessage({ role: 'user', content: [{ type: 'text', text: 'synthetic-history-'.repeat(9000) }], timestamp: Date.now() });
  old.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'synthetic-prior-answer' }],
    stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, timestamp: Date.now() });
  const oldPath = old.getSessionFile();
  const oldBytes = readFileSync(oldPath);
  project.runtime.sessionFile = oldPath;
  project.runtime.feedback = { code: 'REVISION_SCHEMA_INVALID', path: '/changes', reason: '合成校验反馈',
    correctable: true, privateInternal: 'must-not-enter-context' };
  project.revisionFeedback.unshift({ id: randomUUID(), requestId: randomUUID(), sourceRevisionId: project.revisions[0].id,
    baseVersion: project.version, text: '之前反馈：先独立观察，再轮流互读', status: 'error' });
  const confirmed = structuredClone(project.concepts);
  const pending = structuredClone(project.revisions);
  const { bodies, guarded } = mockTransport();
  const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: guarded.fetch } });
  try {
    await runtime.submit(project.revisionRequest.text);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].max_tokens, 12000);
    const user = bodies[0].messages.find(message => message.role === 'user');
    const current = JSON.parse(typeof user.content === 'string' ? user.content : user.content.map(block => block.text ?? '').join(''));
    assert.equal(current.project.id, project.id);
    assert.equal(current.project.version, project.version);
    assert.deepEqual(current.project.brief.mustKeep, project.brief.mustKeep);
    assert.deepEqual(current.project.lockedFields, project.lockedFields ?? []);
    assert.deepEqual(current.project.concepts, confirmed);
    assert.equal(current.project.currentPendingRevision.id, pending[0].id);
    assert.equal(current.project.revisionRequest.sourceRevisionId, pending[0].id);
    assert.equal(current.project.revisionRequest.text, project.revisionFeedback.at(-1).text);
    assert.equal(current.project.previousFeedback.code, 'REVISION_SCHEMA_INVALID');
    assert.equal(current.project.previousFeedback.reason, '合成校验反馈');
    assert.equal(current.project.priorFeedback.text, '之前反馈：先独立观察，再轮流互读');
    assert.equal(current.project.priorFeedback.status, 'error');
    assert.equal(JSON.stringify(current.project).includes('must-not-enter-context'), false);
    assert(current.project.evidence.every(card => card.projectId === project.id));
    assert.equal(guarded.ledger.modelHttpAttempts, 1);
    assert.notEqual(project.runtime.sessionFile, oldPath);
    assert(existsSync(project.runtime.sessionFile));
    assert.deepEqual(readFileSync(oldPath), oldBytes);
    assert.equal(project.version, source.version);
    assert.deepEqual(project.concepts, confirmed);
    assert.deepEqual(project.revisions, pending);
  } finally { await runtime.dispose(); }
});

test('unconfirmed saved observations survive fresh user submissions and runtime restart without rewriting closed sessions', async t => {
  const { project, directory } = replay(t);
  const sessionDir = join(directory, 'sessions'); mkdirSync(sessionDir, { recursive: true });
  const old = SessionManager.create(root, sessionDir);
  old.appendMessage({ role: 'user', content: [{ type: 'text', text: '{"message":"Synthetic original research"}' }], timestamp: 1 });
  old.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'unconfirmed', name: 'qloo_describe', arguments: { entity: 'Synthetic ambiguous input' } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: 'toolUse', timestamp: 2 });
  const unresolved = { status: 'needs_input', resolution: { candidates: [{ entity_id: 'candidate', name: 'Synthetic unconfirmed candidate' }], confirmed: false }, results: [] };
  old.appendMessage({ role: 'toolResult', toolCallId: 'unconfirmed', toolName: 'qloo_describe', details: unresolved,
    content: [{ type: 'text', text: JSON.stringify(unresolved) }], timestamp: 3 });
  const oldPath = old.getSessionFile(), oldBytes = readFileSync(oldPath);
  project.runtime.sessionFile = oldPath;
  const closed = new Map([[oldPath, oldBytes]]);
  for (let pass = 0; pass < 2; pass++) {
    if (pass) beginPendingFeedback(project, project.revisions[0].id, { baseVersion: project.version, text: 'Synthetic next user feedback' });
    const { bodies, guarded } = mockTransport();
    const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: guarded.fetch } });
    try {
      await runtime.submit(project.revisionRequest.text);
      assert.equal(bodies.length, 1);
      const content = bodies[0].messages.find(message => message.role === 'user').content;
      const current = JSON.parse(typeof content === 'string' ? content : content.map(block => block.text).join('')).project;
      assert.equal(current.openResearchQuestions.length, 1);
      assert.equal(current.openResearchQuestions[0].confirmed, false);
      assert.deepEqual(current.openResearchQuestions[0].result.resolution, unresolved.resolution);
      for (const [path, bytes] of closed) assert.deepEqual(readFileSync(path), bytes);
    } finally { await runtime.dispose(); }
    closed.set(project.runtime.sessionFile, readFileSync(project.runtime.sessionFile));
  }
});

test('pending feedback keeps current draft and change metadata within capacity while historical delta stays authoritative', async t => {
  const { project } = replay(t);
  const target = project.concepts[0], pending = project.revisions[0];
  target.mechanism.description = 'Synthetic confirmed material observation. '.repeat(450);
  pending.changes[0].before = structuredClone(target.mechanism);
  pending.changes[0].after.description = 'Synthetic revised material observation. '.repeat(450);
  pending.draftDelta = [{ field: 'mechanism',
    before: { organization: 'Synthetic earlier organization', description: 'Synthetic historical observation. '.repeat(700) },
    after: structuredClone(pending.changes[0].after), reason: 'Synthetic historical change reason', evidenceRefs: [] }];
  project.revisionRequest.status = 'error';
  beginPendingFeedback(project, pending.id, { baseVersion: project.version, text: 'Synthetic follow-up for the complete current draft' });
  const before = authority(project);
  const { bodies, guarded } = mockTransport();
  const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: guarded.fetch } });
  try {
    await runtime.submit(project.revisionRequest.text);
    assert.equal(bodies.length, 1, 'duplicate confirmed/draft values must not consume the configured output capacity');
    assert.equal(bodies[0].max_tokens, 12000);
    const user = bodies[0].messages.find(message => message.role === 'user');
    const current = JSON.parse(typeof user.content === 'string' ? user.content : user.content.map(block => block.text ?? '').join('')).project;
    assert.deepEqual(current.concepts, before.concepts);
    assert.deepEqual(current.currentPendingDraft, { ...before.concepts[0],
      ...Object.fromEntries(before.revisions[0].changes.map(change => [change.field, change.after])) });
    const { draftDelta, ...currentMetadata } = before.revisions[0];
    assert(!Object.hasOwn(current.currentPendingRevision, 'draftDelta'));
    assert.deepEqual(current.currentPendingRevision, { ...currentMetadata,
      changes: currentMetadata.changes.map(({ before, after, ...metadata }) => metadata) });
    const reconstructed = { ...current.currentPendingRevision, changes: current.currentPendingRevision.changes.map(change => ({ ...change,
      before: current.concepts.find(concept => concept.id === pending.targetConceptId)[change.field],
      after: current.currentPendingDraft[change.field] })) };
    assert.deepEqual(reconstructed, currentMetadata);
    assert.deepEqual(authority(project), before);
    assert.deepEqual(project.revisions[0].draftDelta, draftDelta);
    assert.equal(guarded.ledger.modelHttpAttempts, 1);
    assert.equal(guarded.ledger.qlooHttpAttempts, 0);
  } finally { await runtime.dispose(); }
});

test('pending change reference view omits only canonical derived observations and preserves unique observations', async t => {
  const { project } = replay(t);
  const entity = project.evidence[0].returnedEntities[0];
  const pending = proposeRevision(project, { requestId: project.revisionRequest.id, phase: 'pending',
    summary: 'Synthetic evidence projection draft', changes: [{ field: 'mechanism',
      after: { organization: 'Synthetic independent observation', description: '触摸样本并独立记录，再互读' },
      reason: 'Synthetic current change reason', evidenceRefs: [{ evidenceId: project.evidence[0].id,
        entityId: entity.entity_id, observedField: 'properties.short_description',
        observedValue: entity.properties.short_description, inspiration: 'Synthetic design inference; effect unknown' }] }],
    impact: ['Synthetic current scope'], unknowns: ['Synthetic feasibility unknown'] });
  const canonical = structuredClone(pending.changes[0].evidenceRefs[0]);
  const unique = { ...canonical, observation: 'Unique historical observation, retain this wording' };
  pending.changes[0].evidenceRefs.push(unique);
  beginPendingFeedback(project, pending.id, { baseVersion: project.version, text: 'Synthetic follow-up preserving exact evidence' });
  const before = authority(project), { bodies, guarded } = mockTransport();
  const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: guarded.fetch } });
  try {
    await runtime.submit(project.revisionRequest.text);
    assert.equal(bodies.length, 1);
    const user = bodies[0].messages.find(message => message.role === 'user');
    const current = JSON.parse(typeof user.content === 'string' ? user.content : user.content.map(block => block.text ?? '').join('')).project;
    const references = current.currentPendingRevision.changes[0].evidenceRefs;
    const { observation, ...exactFields } = canonical;
    assert(!Object.hasOwn(references[0], 'observation'));
    assert.deepEqual(references[0], exactFields);
    assert.deepEqual({ ...references[0], observation }, canonical);
    assert.deepEqual(references[1], unique);
    assert.deepEqual(current.concepts, before.concepts);
    assert.deepEqual(authority(project), before);
    assert.equal(guarded.ledger.qlooHttpAttempts, 0);
  } finally { await runtime.dispose(); }
});

test('length finish without text or tool is a distinct failure and retains both drafts', async t => {
  const { project } = replay(t);
  const confirmed = structuredClone(project.concepts);
  const pending = structuredClone(project.revisions);
  let fetched = 0;
  const guarded = createDiagnosticFetch(async () => {
    fetched++;
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'offline-length', object: 'chat.completion.chunk',
      created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(chunk({ role: 'assistant' }) + chunk({}, 'length') + 'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: guarded.fetch } });
  try {
    await runtime.submit(project.revisionRequest.text);
    assert.equal(fetched, 1);
    assert.equal(project.runtime.failure?.code, 'MODEL_OUTPUT_LENGTH_EMPTY');
    assert.deepEqual(project.concepts, confirmed);
    assert.deepEqual(project.revisions, pending);
  } finally { await runtime.dispose(); }
});

test('insufficient context capacity stops locally before the provider fetch', async t => {
  const { project } = replay(t);
  project.brief.request = 'synthetic-oversized-brief-'.repeat(10000);
  const confirmed = structuredClone(project.concepts);
  const pending = structuredClone(project.revisions);
  const { bodies, guarded } = mockTransport();
  const runtime = await createProductRuntime(project, { env, diagnostic: { fetch: guarded.fetch } });
  try {
    await runtime.submit(project.revisionRequest.text);
    assert.equal(bodies.length, 0);
    assert.equal(guarded.ledger.modelHttpAttempts, 0);
    assert.equal(project.runtime.failure?.code, 'MODEL_CONTEXT_CAPACITY_INSUFFICIENT');
    assert.deepEqual(project.concepts, confirmed);
    assert.deepEqual(project.revisions, pending);
  } finally { await runtime.dispose(); }
});
