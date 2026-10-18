import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createProductRuntime } from '../app/runtime.mjs';
import { budgetedFetch, createDiagnosticFetch, validationRun, withHttpBudget } from '../app/transport.mjs';
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
    const attempts = project.runtime.httpAttempts.filter(attempt => attempt.kind === 'model').slice(-2);
    assert.equal(attempts.length, 2);
    assert(attempts.every(attempt => attempt.generationBudget.model === 'deepseek-flash'
      && attempt.generationBudget.contextWindow === 32000
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
  project.brief.request = 'synthetic-oversized-brief-'.repeat(7000);
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
