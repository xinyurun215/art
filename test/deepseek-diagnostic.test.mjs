import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProject } from '../app/state.mjs';
import { createProductRuntime } from '../app/runtime.mjs';
import { createDiagnosticFetch, safeProviderError, safeRuntimeFailure } from '../app/transport.mjs';
import { mockCalls, mockToolResponse, runDiagnostic } from '../validation/deepseek-diagnostic/diagnose.mjs';

test('bounded provider diagnostics preserve only safe code/type/param/message and status', async () => {
  const key = 'local-model-secret-value';
  const qlooKey = 'local-qloo-secret-value';
  const response = new Response(JSON.stringify({ error: { code: 'invalid_request', type: 'invalid_request_error',
    param: 'model', message: `Unknown model. Bearer ${key}; sk-another-secret; api_key=${qlooKey}; headers: {"Authorization":"Bearer hidden","other":"discard-this"}`,
    request: { headers: { authorization: key } }, extra: key } }), { status: 400 });
  const error = await safeProviderError(response, [key, qlooKey]);
  assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'param', 'type']);
  assert.equal(error.code, 'invalid_request');
  assert.equal(error.type, 'invalid_request_error');
  assert.equal(error.param, 'model');
  for (const value of [key, qlooKey, 'sk-another-secret', 'hidden', 'discard-this']) assert.equal(JSON.stringify(error).includes(value), false);
  assert.match(error.message, /Unknown model/);
  const project = createProject({ mode: 'live', brief: { request: 'diagnostic' } });
  project.runtime.httpAttempts = [{ kind: 'model', status: 400, providerError: error }];
  assert.equal(safeRuntimeFailure(project, 'model').status, 400);
  assert.deepEqual(safeRuntimeFailure(project, 'model').providerError, error);
  assert.equal((await response.json()).error.extra, key, 'the original SDK response remains readable');
  for (const message of [
    'Request payload: {"Authorization":"opaque-credential","prompt":"client content"}',
    'Invalid field. "Authorization":"opaque-credential"',
    'Request body: ["client content", "opaque-credential"]',
  ]) {
    const safe = await safeProviderError(new Response(JSON.stringify({ error: { message } })));
    assert.equal(safe.message.includes('opaque-credential'), false);
    assert.equal(safe.message.includes('client content'), false);
  }
});

test('malformed bodies/types are ignored; redaction precedes field caps and oversized bodies are bounded', async () => {
  for (const body of ['not json', 'null', '[]', '{"error":[]}', '{"error":{"code":{},"type":[],"param":4,"message":{"request":"hidden"}}}'])
    assert.deepEqual(await safeProviderError(new Response(body)), {});
  const key = 'secret-crosses-the-length-boundary';
  const error = await safeProviderError(new Response(JSON.stringify({ error: {
    code: 'c'.repeat(300), type: 't'.repeat(300), param: null,
    message: 'a'.repeat(500) + key + 'z'.repeat(1000) } })), [key]);
  assert.equal(error.code.length, 128);
  assert.equal(error.type.length, 128);
  assert.equal(error.param, null);
  assert.equal(error.message.length, 512);
  assert.equal(error.message.includes('secret-'), false);
  assert.deepEqual(await safeProviderError(new Response(JSON.stringify({ error: { message: 'x'.repeat(9000) } }))), {});
});

test('one-request guard rejects a second model request, all Qloo requests and redirects before fetch', async () => {
  let executions = 0;
  const transport = createDiagnosticFetch(async (_url, options) => {
    executions++;
    assert.equal(options.redirect, 'error');
    return new Response('{}');
  });
  const options = { method: 'POST', body: JSON.stringify({ model: 'deepseek-flash', messages: [], stream: true }) };
  await transport.fetch('https://api.deepseek.com/chat/completions', options);
  await assert.rejects(transport.fetch('https://api.deepseek.com/chat/completions', options), /只允许一次/);
  await assert.rejects(transport.fetch('https://hackathon.api.qloo.com/search'), /所有 Qloo/);
  assert.equal(executions, 1);
  assert.equal(transport.ledger.modelHttpAttempts, 1);
  assert.equal(transport.ledger.qlooHttpAttempts, 0);
  assert.equal(transport.ledger.blockedHttpAttempts, 2);
});

test('one-request reservation is atomic for parallel Request inputs and rejects other wire models', async () => {
  let executions = 0;
  const transport = createDiagnosticFetch(async () => { executions++; return new Response('{}'); });
  const request = () => new Request('https://api.deepseek.com/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'deepseek-flash', messages: [], stream: true }) });
  const results = await Promise.allSettled([transport.fetch(request()), transport.fetch(request())]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(executions, 1);
  const other = createDiagnosticFetch(async () => { assert.fail('unapproved model cannot reach fetch'); });
  await assert.rejects(other.fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'other-model' }) }), /未批准/);
  assert.equal(other.ledger.modelHttpAttempts, 0);
});

test('actual installed SDK final JSON and official session pause all three parallel product tools', async () => {
  let body;
  let syntheticFetches = 0;
  const result = await runDiagnostic({ implementation: async (_url, options) => {
    syntheticFetches++;
    body = JSON.parse(options.body);
    return mockToolResponse();
  } });
  assert.equal(result.runnerFailure, false);
  assert.equal(result.integrationPassed, true);
  assert.equal(syntheticFetches, 1);
  assert.equal(result.session.modelCallbacks, 1);
  assert.equal(result.session.blockedModelCallbacks, 0);
  assert.equal(result.session.toolExecutionAttempts, 0);
  assert.deepEqual(result.session.pausedToolNames, mockCalls.map(call => call.name));
  assert.deepEqual(result.response.proposedToolNames, mockCalls.map(call => call.name));
  assert.equal(result.underlyingToolExecutions, 0);
  assert.deepEqual(result.projectState, { version: 1, evidenceCount: 0, conceptCount: 0 });
  assert.deepEqual(result.realHttp, { model: 0, qloo: 0 });
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.store, undefined);
  assert.equal(body.max_tokens, 12000);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.thinking, undefined);
  assert.deepEqual(body.tools.map(tool => tool.function.name), ['qloo_describe', 'qloo_recommend', 'propose_design_response']);
  const schemaRuntime = await createProductRuntime(createProject({ brief: { request: 'offline schema inspection' } }), { env: {} });
  try {
    for (const tool of body.tools) {
      assert.equal(tool.type, 'function');
      assert.equal(tool.function.strict, false);
      assert.equal(tool.function.parameters.type, 'object');
      assert.equal(tool.function.parameters.additionalProperties, false);
      assert.deepEqual(tool.function.parameters, schemaRuntime.session.getToolDefinition(tool.function.name).parameters);
      const summary = result.ledger.attempts[0].request.tools.find(item => item.name === tool.function.name);
      assert.equal(summary.parametersSha256, createHash('sha256').update(JSON.stringify(tool.function.parameters)).digest('hex'));
    }
  } finally { await schemaRuntime.dispose(); }
  assert.equal(result.ledger.attempts[0].request.unexpectedFieldCount, 0);
});

test('single proposal call is paused before project mutation and without another callback', async () => {
  const result = await runDiagnostic({ implementation: async () => mockToolResponse([mockCalls[2]]) });
  assert.equal(result.session.modelCallbacks, 1);
  assert.equal(result.integrationPassed, true);
  assert.equal(result.session.blockedModelCallbacks, 0);
  assert.equal(result.session.toolExecutionAttempts, 0);
  assert.deepEqual(result.session.pausedToolNames, ['propose_design_response']);
  assert.deepEqual(result.projectState, { version: 1, evidenceCount: 0, conceptCount: 0 });
});

test('unknown and invalid parallel tool calls stop after the first model callback', async () => {
  const result = await runDiagnostic({ implementation: async () => mockToolResponse([
    { name: 'unknown_tool', arguments: {} }, { name: 'qloo_recommend', arguments: {} }, mockCalls[0] ]) });
  assert.equal(result.session.modelCallbacks, 1);
  assert.equal(result.integrationPassed, false);
  assert.equal(result.session.blockedModelCallbacks, 0);
  assert.equal(result.session.toolExecutionAttempts, 0);
  assert.deepEqual(result.session.pausedToolNames, ['qloo_describe']);
  assert.deepEqual(result.response.proposedToolNames, ['unknown', 'qloo_recommend', 'qloo_describe']);
  assert.deepEqual(result.projectState, { version: 1, evidenceCount: 0, conceptCount: 0 });
});

test('HTTP 400/429/500 are safely captured before SDK error conversion and neither layer retries', async () => {
  for (const status of [400, 429, 500]) {
    let fetches = 0;
    const result = await runDiagnostic({ implementation: async () => {
      fetches++;
      return new Response(JSON.stringify({ error: { code: 'bad_model', type: 'invalid_request_error', param: 'model', message: 'Unknown model' } }), { status });
    } });
    assert.equal(fetches, 1);
    assert.equal(result.integrationPassed, false);
    assert.equal(result.session.modelCallbacks, 1);
    assert.equal(result.session.blockedModelCallbacks, 0);
    assert.equal(result.ledger.blockedHttpAttempts, 0);
    assert.equal(result.response.stopReason, 'error');
    assert.equal(result.ledger.attempts[0].status, status);
    assert.deepEqual(result.ledger.attempts[0].providerError, { code: 'bad_model', type: 'invalid_request_error', param: 'model', message: 'Unknown model' });
    assert.equal(result.session.toolExecutionAttempts, 0);
  }
});
