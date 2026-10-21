import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from '../app/state.mjs';
import { createProductRuntime, recordEvidence } from '../app/runtime.mjs';
import { estimateSerializedTokens, requestBudget } from '../app/context.mjs';
import { budgetedFetch, serverUsage, validationRun } from '../app/transport.mjs';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../.art-runtime');
const env = { ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'deepseek', ART_MODEL_ID: 'deepseek-flash',
  ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://api.deepseek.com',
  ART_MODEL_API_KEY: 'synthetic-local-only-key', QLOO_API_KEY: 'synthetic-local-only-qloo-key',
  QLOO_API_URL: 'https://hackathon.api.qloo.com' };
// Invented protocol content, calibrated by character classes rather than private text.
const opaque = '\n'.repeat(196) + 'x'.repeat(8026) + '合'.repeat(2077);
assert.equal(estimateSerializedTokens({ type: 'thinking', thinking: opaque, thinkingSignature: 'reasoning_content' }), 4200);

function response(call, reasoning = '') {
  const delta = call ? { role: 'assistant', ...(reasoning ? { reasoning_content: reasoning } : {}),
    tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
    : { role: 'assistant', content: 'Synthetic closing text; no accepted proposal.' };
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'synthetic-context-window',
    object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk(delta) + chunk({}, call ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(t, { environment = {}, mode = 'live', reply = () => response() } = {}) {
  Object.assign(serverUsage, { modelHttpAttempts: 0, qlooHttpAttempts: 0 });
  Object.assign(validationRun, { liveStopped: false, queryStopped: false });
  validationRun.attempts.length = 0;
  delete validationRun.failure;
  const project = createProject({ mode, brief: { request: 'Synthetic model capacity boundary', venue: 'Synthetic room' } });
  const directory = resolve(runtimeRoot, project.id), configuration = { ...env, ...environment };
  assert(directory.startsWith(runtimeRoot + sep));
  assert.equal(existsSync(directory), false);
  const originalFetch = globalThis.fetch, bodies = [], capacities = [];
  let runtime, qloo = 0;
  globalThis.fetch = budgetedFetch(async (url, options) => {
    assert.equal(new URL(String(url)).origin, new URL(configuration.ART_MODEL_BASE_URL).origin);
    const body = JSON.parse(options.body);
    bodies.push(body); capacities.push(structuredClone(project.runtime.generationBudget));
    return reply(bodies.length, body, project);
  });
  t.after(async () => {
    await runtime?.dispose();
    globalThis.fetch = originalFetch;
    assert(directory.startsWith(runtimeRoot + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  runtime = await createProductRuntime(project, { env: mode === 'live' ? configuration : {},
    qlooExecutor: { transport: { kind: 'direct', remote: false }, async execute() { qloo++; assert.fail('No Qloo in capacity tests'); } } });
  return { project, runtime, bodies, capacities, get qloo() { return qloo; } };
}

test('only the official live flash completion endpoint gets the 65536 context window', async t => {
  for (const [name, environment, mode, expected] of [
    ['official', {}, 'live', 65536],
    ['provider label is not a capability', { ART_MODEL_PROVIDER: 'display-only', ART_MODEL_BASE_URL: 'https://api.deepseek.com/v1' }, 'live', 65536],
    ['other host', { ART_MODEL_BASE_URL: 'https://model.invalid' }, 'live', 32000],
    ['other model', { ART_MODEL_ID: 'synthetic-other-model' }, 'live', 32000],
    ['other API', { ART_MODEL_API: 'anthropic-messages' }, 'live', 32000],
    ['invalid URL', { ART_MODEL_BASE_URL: 'not-a-url' }, 'live', 32000],
    ['offline', {}, 'offline', 32000],
  ]) await t.test(name, async t => {
    const state = await fixture(t, { environment, mode });
    assert.equal(state.runtime.session.model.contextWindow, expected);
    assert.equal(state.runtime.session.model.maxTokens, 12000);
    assert.equal(state.bodies.length, 0);
  });
});

async function invalidDraftFlow(t, summaryLength) {
  let card, proposal;
  const state = await fixture(t, { reply(turn) {
    if (turn === 1) return response({ id: 'synthetic-read', name: 'read_project_evidence', arguments: {
      evidenceId: card.id, entityId: 'synthetic-entity', field: 'properties.description' } });
    if (turn === 2) return response({ id: 'synthetic-invalid', name: 'propose_design_response', arguments: proposal }, opaque);
    assert.equal(turn, 3);
    return response();
  } });
  card = recordEvidence(state.project, 'describe', { entity: 'Synthetic reference' }, { correlationId: 'synthetic-no-http',
    result: { status: 'ok', results: [{ entity_id: 'synthetic-entity', properties: { description: 'Synthetic exact saved description.' } }] } });
  Object.assign(card, { source: 'Synthetic local fixture', synthetic: true });
  proposal = { baseVersion: state.project.version, phase: 'ready', summary: '合'.repeat(summaryLength), concepts: ['a', 'b'].map(id => ({
    id, title: `Synthetic ${id}`, coreClaim: 'Synthetic sample interaction',
    mechanism: { organization: id, description: 'Synthetic mechanism', productTouchpoints: ['Deliberately at the wrong level'] },
    journey: ['arrive', 'try', 'leave'].map(stage => ({ stage, action: 'Synthetic sample interaction' })),
    evidenceLinks: [], openQuestions: ['Synthetic feasibility unknown'], unverifiedEffects: ['Synthetic effect unverified'],
  })) };
  const before = structuredClone({ version: state.project.version, concepts: state.project.concepts, evidence: state.project.evidence });
  const failures = [];
  state.runtime.session.subscribe(event => {
    if (event.type === 'tool_execution_end' && event.toolName === 'propose_design_response') failures.push(event.isError);
  });
  await state.runtime.submit(state.project.brief.request);
  assert.deepEqual(failures, [true], 'the original wrong-level proposal reaches native schema rejection');
  assert.deepEqual({ version: state.project.version, concepts: state.project.concepts, evidence: state.project.evidence }, before);
  assert.equal(state.qloo, 0);
  return { ...state, proposal };
}

test('schema feedback reaches the final SDK boundary without editing the original draft or opaque block', async t => {
  const { project, bodies, capacities, proposal } = await invalidDraftFlow(t, 8000);
  assert.equal(bodies.length, 3);
  for (const [index, body] of bodies.entries()) {
    assert.equal(body.max_tokens, 12000);
    assert.equal(capacities[index].contextWindow, 65536);
    assert.equal(capacities[index].safetyTokens, 4096);
    assert.equal(capacities[index].reservedOutputTokens, 12000);
    assert(requestBudget(body, { contextWindow: 65536, maxTokens: 12000 }).fits);
    const calls = body.messages.flatMap(message => message.tool_calls ?? []);
    const results = body.messages.filter(message => message.role === 'tool');
    assert.equal(calls.length, results.length);
    for (const call of calls) assert.equal(results.filter(result => result.tool_call_id === call.id).length, 1);
  }
  const third = bodies[2];
  assert.equal(requestBudget(third, { contextWindow: 32000, maxTokens: 12000 }).fits, false,
    'this feedback payload exercises the expanded capacity');
  const assistant = third.messages.find(message => message.tool_calls?.some(call => call.id === 'synthetic-invalid'));
  assert.equal(assistant.reasoning_content, opaque);
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), proposal);
  const result = JSON.parse(third.messages.find(message => message.tool_call_id === 'synthetic-invalid').content);
  assert.equal(result.feedback.code, 'PROPOSAL_SCHEMA_INVALID');
  assert.equal(result.feedback.path, '/concepts/0/productTouchpoints');
  assert.equal(project.usage.modelHttpAttempts, 3);
});

test('irreducible input beyond 65536 still stops before the provider fetch', async t => {
  const { project, bodies } = await invalidDraftFlow(t, 60000);
  assert.equal(bodies.length, 2);
  assert.equal(project.runtime.localFailure.code, 'MODEL_CONTEXT_CAPACITY_INSUFFICIENT');
  assert.equal(project.runtime.generationBudget.contextWindow, 65536);
  assert(project.runtime.generationBudget.estimatedInputTokens > 65536);
  assert.equal(project.runtime.generationBudget.reservedOutputTokens, 12000);
  assert.equal(project.runtime.generationBudget.safetyTokens, 4096);
  assert.equal(project.usage.modelHttpAttempts, 2);
});
