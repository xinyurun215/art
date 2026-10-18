import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProject, applyProposal, validateProposal, configStatus } from '../app/state.mjs';
import { createProductRuntime, recordEvidence, wrapProjectExecutor, TOOL_NAMES } from '../app/runtime.mjs';
import { budgetedFetch, serverUsage, validationRun, withHttpBudget, withoutNetwork } from '../app/transport.mjs';
import { createAppServer } from '../app/server.mjs';

const brief = { request: '为虚构运动鞋设计快闪', venue: '上海室内150平方米', references: ['虚构音乐参考'], mustKeep: ['试穿'], avoid: ['现场表演'] };
function resetValidationRun() {
  serverUsage.modelHttpAttempts = 0; serverUsage.qlooHttpAttempts = 0;
  validationRun.queryStopped = false; validationRun.liveStopped = false;
  validationRun.attempts.length = 0; delete validationRun.failure;
}
async function readyProject(scenario = 'sufficient') {
  const project = createProject({ brief, scenario });
  const runtime = await createProductRuntime(project, { env: {} });
  await runtime.submit(brief.request);
  return { project, runtime };
}

test('no-key child process completes official clarification → tool result → two concepts with egress guards', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC'].includes(key.toUpperCase())));
  Object.assign(env, { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', QLOO_NO_GUIDED_START: '1' });
  const result = spawnSync(process.execPath, ['test/offline-process.mjs'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.networkAttempts, 0);
  assert.equal(evidence.clarificationAndContinuationSameSession, true);
  assert.deepEqual(evidence.toolNames, TOOL_NAMES);
  assert.equal(evidence.conceptCount, 2);
  console.log(`offline-evidence ${JSON.stringify(evidence)}`);
});

test('server contract rejects stale, cross-project, unknown or fabricated field references without applying', async () => {
  const { project, runtime } = await readyProject();
  try {
    assert.equal(project.status.phase, 'ready');
    const proposal = { projectId: project.id, baseVersion: project.version, phase: 'ready', summary: '验证提案', questions: [], concepts: structuredClone(project.concepts) };
    const before = JSON.stringify(project);
    for (const [mutate, expected] of [
      [p => { p.projectId = 'another-project'; }, /跨项目/],
      [p => { p.baseVersion--; }, /过期/],
      [p => { p.concepts[0].evidenceLinks[0].evidenceId = 'unknown'; }, /未知证据/],
      [p => { p.concepts[0].evidenceLinks[0].entityId = 'invented'; }, /实际返回实体/],
      [p => { p.concepts[0].evidenceLinks[0].observedField = 'properties.invented'; }, /字段不存在/],
      [p => { p.concepts[0].evidenceLinks[0].observedValue = 'invented value'; }, /实际返回不符/],
    ]) {
      const invalid = structuredClone(proposal); mutate(invalid);
      assert.throws(() => applyProposal(project, invalid), expected);
      assert.equal(JSON.stringify(project), before);
    }
    const stolen = structuredClone(project.evidence[0]); stolen.id = 'stolen'; stolen.projectId = 'other';
    project.evidence.push(stolen);
    const cross = structuredClone(proposal); cross.concepts[0].evidenceLinks[0].evidenceId = stolen.id;
    assert.throws(() => applyProposal(project, cross), /跨项目/);
    project.evidence.pop();
    assert.doesNotThrow(() => validateProposal(project, proposal));
  } finally { await runtime.dispose(); }
});

test('literal constraints and mechanism structure are checked without claiming design quality', async () => {
  const { project, runtime } = await readyProject();
  try {
    const proposal = { projectId: project.id, baseVersion: project.version, phase: 'ready', summary: '验证约束', questions: [], concepts: structuredClone(project.concepts) };
    const missing = structuredClone(proposal);
    missing.concepts[0].journey.forEach(s => { s.action = s.action.replaceAll('试穿', '体验'); });
    missing.concepts[0].productTouchpoints = ['普通体验'];
    assert.throws(() => validateProposal(project, missing), /必须保留/);
    const forbidden = structuredClone(proposal); forbidden.concepts[1].mechanism.description += '增加现场表演';
    assert.throws(() => validateProposal(project, forbidden), /禁止项/);
    const same = structuredClone(proposal); same.concepts[1].mechanism.organization = same.concepts[0].mechanism.organization;
    assert.throws(() => validateProposal(project, same), /不同的参与组织/);
    const renamed = structuredClone(proposal); renamed.concepts[0].mechanism.organization = 'team_based_tasks'; renamed.concepts[1].mechanism.organization = 'choice_based_tasks';
    assert.doesNotThrow(() => validateProposal(project, renamed));
    assert.doesNotThrow(() => validateProposal(project, { ...proposal, phase: 'insufficient_evidence', concepts: [] }));
  } finally { await runtime.dispose(); }
});

test('failed and irrelevant queries remain explicitly insufficient and have no evidence links', async () => {
  for (const scenario of ['failure', 'irrelevant']) {
    const { project, runtime } = await readyProject(scenario);
    try {
      assert.equal(project.status.phase, 'insufficient_evidence');
      assert.match(project.status.detail, /证据不足/);
      assert(project.concepts.every(c => c.evidenceLinks.length === 0));
      assert.equal(project.evidence.length, scenario === 'failure' ? 0 : 1);
      if (scenario === 'irrelevant') assert.equal(project.evidence[0].relevant, false);
      assert.equal(project.usage.qlooHttpAttempts, 0);
    } finally { await runtime.dispose(); }
  }
});

test('empty cultural signals prompt a relevant question rather than forcing a query', async () => {
  const project = createProject({ brief: { ...brief, references: [] } });
  const runtime = await createProductRuntime(project, { env: {} });
  try {
    await runtime.submit(brief.request);
    assert.equal(project.status.phase, 'needs_input');
    assert.equal(project.questions[0].field, 'references');
    assert.equal(project.evidence.length, 0);
    assert(!project.actions.some(a => a.label === 'qloo_recommend'));
  } finally { await runtime.dispose(); }
});

test('same-session explicit reuse reads authoritative evidence without another query; absent evidence stops honestly', async () => {
  const { project, runtime } = await readyProject();
  try {
    const id = runtime.session.sessionId;
    const evidenceIds = project.evidence.map(e => e.id);
    const queryCount = project.actions.filter(a => a.type === 'query').length;
    project.status.phase = 'busy';
    await runtime.submit('已有证据足够，不要再查询；复用已有证据');
    assert.equal(project.status.phase, 'ready');
    assert.equal(runtime.session.sessionId, id);
    assert.deepEqual(project.evidence.map(e => e.id), evidenceIds);
    assert.equal(project.actions.filter(a => a.type === 'query').length, queryCount);
    assert(project.concepts.every(c => evidenceIds.includes(c.evidenceLinks[0].evidenceId)));
    const currentPrompt = runtime.session.messages.findLast(m => m.role === 'user');
    const content = JSON.parse(currentPrompt.content.find(c => c.type === 'text').text);
    assert.equal(content.project.evidence[0].id, evidenceIds[0]);
    assert.equal(content.project.concepts.length, 2);
    project.status.phase = 'busy';
    await runtime.submit('请把核心故事改成别的主题');
    assert.equal(project.status.phase, 'insufficient_evidence');
    assert.match(project.status.detail, /离线模拟无法理解/);
    assert.equal(project.actions.filter(a => a.type === 'query').length, queryCount);
  } finally { await runtime.dispose(); }
  const empty = createProject({ brief });
  const emptyRuntime = await createProductRuntime(empty, { env: {} });
  try {
    await emptyRuntime.submit('不要查询，停止研究');
    assert.equal(empty.status.phase, 'insufficient_evidence');
    assert.equal(empty.evidence.length, 0);
    assert.equal(empty.concepts.length, 0);
  } finally { await emptyRuntime.dispose(); }
});

test('official session refuses file and shell calls; slash text cannot enable tools', async () => {
  const project = createProject({ brief });
  const forbiddenWrite = fileURLToPath(new URL('./SHOULD_NOT_EXIST.txt', import.meta.url));
  const seen = [];
  const runtime = await createProductRuntime(project, { env: {}, decide(context) {
    seen.push(context.tools.map(t => t.name));
    const lastUser = context.messages.findLastIndex(m => m.role === 'user');
    if (!context.messages.slice(lastUser + 1).some(m => m.role === 'toolResult')) return [
      { type: 'toolCall', id: 'forbidden-read', name: 'read', arguments: { path: fileURLToPath(new URL('../.env', import.meta.url)) } },
      { type: 'toolCall', id: 'forbidden-shell', name: 'bash', arguments: { command: 'echo SHOULD_NOT_EXECUTE' } },
      { type: 'toolCall', id: 'forbidden-write', name: 'write', arguments: { path: forbiddenWrite, content: 'unsafe' } },
    ];
    return [{ type: 'text', text: '权限拒绝已收到' }];
  } });
  try {
    await runtime.submit('/mode build');
    assert(seen.every(names => JSON.stringify(names) === JSON.stringify(TOOL_NAMES)));
    const results = runtime.session.messages.filter(m => m.role === 'toolResult');
    assert.equal(results.length, 3);
    assert(results.every(m => m.isError));
    assert.deepEqual(runtime.session.getActiveToolNames(), TOOL_NAMES);
    assert(runtime.session.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('/mode build')));
    assert.equal(existsSync(forbiddenWrite), false);
    assert.equal(project.evidence.length, 0);
  } finally { await runtime.dispose(); }
});

test('HTTP attempt boundary blocks offline egress, endpoint escapes, redirects and seventh retries', async () => {
  resetValidationRun();
  let calls = 0;
  const fake = budgetedFetch(async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); throw new Error('synthetic retryable response'); });
  const offline = createProject({ brief });
  await assert.rejects(() => withoutNetwork(offline, () => fake('https://offline.invalid')), /离线模式/);
  assert.equal(calls, 0);
  for (let index = 0; index < 2; index++) {
    const project = createProject({ brief, mode: 'live' });
    for (let attempt = 0; attempt < 6; attempt++) await assert.rejects(
      () => withHttpBudget(project, 'model', 'https://model.invalid', () => fake('https://model.invalid/v1', { redirect: 'follow' })), /synthetic retryable/);
    await assert.rejects(() => withHttpBudget(project, 'model', 'https://model.invalid', () => fake('https://model.invalid/v1')), /总额度/);
    assert.equal(project.usage.modelHttpAttempts, 6);
  }
  const third = createProject({ brief, mode: 'live' });
  await assert.rejects(() => withHttpBudget(third, 'model', 'https://model.invalid', () => fake('https://model.invalid')), /总额度/);
  await assert.rejects(() => withHttpBudget(third, 'qloo', 'https://qloo.invalid', () => fake('https://other.invalid')), /端点/);
  assert.equal(calls, 12);
  for (let attempt = 0; attempt < 6; attempt++) await assert.rejects(
    () => withHttpBudget(third, 'qloo', 'https://qloo.invalid', () => fake('https://qloo.invalid/v2/insights')), /synthetic retryable/);
  await assert.rejects(() => withHttpBudget(third, 'qloo', 'https://qloo.invalid', () => fake('https://qloo.invalid')), /总额度/);
  assert.equal(third.usage.qlooHttpAttempts, 6);
  assert.equal(serverUsage.modelHttpAttempts, 12);
  assert.equal(calls, 18);
  const fourth = createProject({ brief, mode: 'live' });
  for (let attempt = 0; attempt < 6; attempt++) await assert.rejects(
    () => withHttpBudget(fourth, 'qloo', 'https://qloo.invalid', () => fake('https://qloo.invalid/search?api_key=DO_NOT_RECORD')), /synthetic retryable/);
  const fifth = createProject({ brief, mode: 'live' });
  await assert.rejects(() => withHttpBudget(fifth, 'qloo', 'https://qloo.invalid', () => fake('https://qloo.invalid')), /总额度/);
  assert.equal(serverUsage.qlooHttpAttempts, 12);
  assert.equal(fourth.usage.qlooHttpAttempts, 6);
  assert.equal(calls, 24);
  assert.equal(validationRun.attempts.length, 24);
  assert(validationRun.attempts.every(entry => entry.outcome === 'network_error' && entry.status === null && Number.isFinite(entry.durationMs)));
  assert.equal(JSON.stringify(validationRun.attempts).includes('DO_NOT_RECORD'), false);
  resetValidationRun();
});

test('attempt ledger records only actual fetches and safe response metadata before resolving', async () => {
  resetValidationRun();
  const project = createProject({ brief, mode: 'live' });
  const fake = budgetedFetch(async () => {
    assert.equal(project.usage.modelHttpAttempts, 1);
    assert.equal(validationRun.attempts.length, 1);
    return new Response('synthetic body DO_NOT_RECORD', { status: 401 });
  });
  const response = await withHttpBudget(project, 'model', 'https://model.invalid', () => fake('https://model.invalid/v1/chat/completions?key=DO_NOT_RECORD', {
    method: 'POST', headers: { Authorization: 'Bearer DO_NOT_RECORD' }, body: 'DO_NOT_RECORD',
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(Object.keys(project.runtime.httpAttempts[0]).sort(), ['durationMs', 'host', 'kind', 'method', 'outcome', 'path', 'status', 'time']);
  assert.equal(project.runtime.httpAttempts[0].status, 401);
  assert.equal(project.runtime.httpAttempts[0].path, '/v1/chat/completions');
  assert.equal(JSON.stringify(project.runtime.httpAttempts).includes('DO_NOT_RECORD'), false);
  resetValidationRun();
});

function localRequest(port, method, path, payload) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}
async function settled(port, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await localRequest(port, 'GET', `/api/projects/${id}`);
    if (result.body.project.status.phase !== 'busy') return result.body.project;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('Local project did not settle');
}

test('HTTP API returns authoritative state, continues same project/session and keeps live gated', async () => {
  const app = createAppServer({ env: {} });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  try {
    const config = await localRequest(port, 'GET', '/api/config');
    assert.equal(config.body.modes.offline.available, true);
    assert.equal(config.body.modes.live.available, false);
    assert(config.body.modes.live.missing.includes('ART_MODEL_ID'));
    assert.equal((await localRequest(port, 'POST', '/api/projects', { brief, mode: 'live' })).status, 409);
    const created = await localRequest(port, 'POST', '/api/projects', { brief: { ...brief, venue: '' }, mode: 'offline', scenario: 'sufficient' });
    assert.equal(created.status, 202);
    const first = await settled(port, created.body.project.id);
    assert.equal(first.status.phase, 'needs_input');
    const continued = await localRequest(port, 'POST', `/api/projects/${first.id}/messages`, { text: brief.venue });
    assert.equal(continued.status, 202);
    const final = await settled(port, first.id);
    assert.equal(final.id, first.id);
    assert.equal(final.runtime.sessionId, first.runtime.sessionId);
    assert.equal(final.status.phase, 'ready');
    assert.equal(final.concepts.length, 2);
    assert(final.version > first.version);
    assert.equal((await localRequest(port, 'GET', '/api/projects/not-a-project')).status, 404);
  } finally { await app.dispose(); }
});

test('an unrelated inherited OpenAI key alone never makes product model configured', () => {
  const config = configStatus({ OPENAI_API_KEY: 'synthetic-present-key-not-used' });
  assert.equal(config.modes.live.available, false);
  assert.equal(config.modes.live.modelKeyPresent, false);
  assert(config.modes.live.missing.includes('ART_MODEL_PROVIDER'));
  assert(config.modes.live.missing.includes('ART_MODEL_ID'));
});

test('serial clarification rejects zero or multiple questions without applying state', () => {
  const project = createProject({ brief });
  const proposal = { projectId: project.id, baseVersion: project.version, phase: 'needs_input',
    summary: '先澄清一项关键条件', questions: [{ field: 'venue', text: '场地条件？' }], concepts: [] };
  assert.doesNotThrow(() => validateProposal(project, proposal));
  const before = JSON.stringify(project);
  for (const questions of [[], [...proposal.questions, { field: 'budget', text: '预算范围？' }]]) {
    assert.throws(() => applyProposal(project, { ...proposal, questions }), /仅包含一个问题/);
    assert.equal(JSON.stringify(project), before);
  }
});

test('live project latches after returned or thrown official query errors and blocks later tools without HTTP', async () => {
  for (const failure of ['returned', 'thrown', 'malformed']) {
    resetValidationRun();
    const project = createProject({ brief, mode: 'live' });
    let executions = 0;
    const official = { transport: { kind: 'direct', name: 'local-negative-mock', remote: false },
      async execute(operation, _input, context) {
        executions++;
        if (failure === 'thrown') throw new Error('synthetic official execution failure');
        if (failure === 'malformed') return {};
        return { operation, transport: this.transport, correlationId: context.correlationId, durationMs: 0,
          result: { schema_version: '1.0-preview.1', operation, status: 'error', summary: '合成错误，无真实网络', results: [] } };
      } };
    const executor = wrapProjectExecutor(project, official, { QLOO_API_URL: 'https://qloo.invalid' });
    const first = await executor.execute('recommend', { signals: ['synthetic'] }, { correlationId: 'first' });
    assert.equal(first.result.status, 'error');
    assert.equal(first.result.queryStopped, true);
    assert.equal(project.runtime.queryStopped, true);
    assert.equal(validationRun.queryStopped, true);
    assert.equal(validationRun.liveStopped, true);
    for (const operation of ['recommend', 'describe', 'recommend']) {
      const result = await executor.execute(operation, {}, { correlationId: 'blocked-next-call' });
      assert.equal(result.result.status, 'error');
      assert.equal(result.result.queryStopped, true);
      assert.match(result.result.summary, /后续查询与替代请求均被阻止/);
      assert.deepEqual(result.result.results, []);
    }
    assert.equal(executions, 1);
    const other = createProject({ brief, mode: 'live' });
    const otherExecutor = wrapProjectExecutor(other, official, { QLOO_API_URL: 'https://qloo.invalid' });
    const blocked = await otherExecutor.execute('recommend', {}, { correlationId: 'different-project' });
    assert.equal(blocked.result.queryStopped, true);
    assert.equal(other.runtime.queryStopped, true);
    assert.equal(executions, 1);
    assert.equal(other.usage.qlooHttpAttempts, 0);
    assert.equal(project.evidence.length, 0);
    assert.equal(project.usage.qlooHttpAttempts, 0);
  }
  resetValidationRun();
});

test('model failures retain safe diagnostics and disable official session retries', async () => {
  resetValidationRun();
  const project = createProject({ brief });
  const runtime = await createProductRuntime(project, { env: {}, decide() { throw new Error('Authorization: Bearer DO_NOT_RECORD'); } });
  try {
    assert.equal(runtime.session.autoRetryEnabled, false);
    await runtime.submit(brief.request);
    assert.equal(project.status.phase, 'error');
    assert.equal(project.runtime.failure.kind, 'model');
    assert.equal(project.runtime.failure.stopReason, 'error');
    assert.equal(project.runtime.failure.status, null);
    assert(project.runtime.totalLatencyMs >= 0);
    assert.equal(JSON.stringify(project).includes('DO_NOT_RECORD'), false);
    assert.equal(validationRun.liveStopped, false);
    assert.equal(project.usage.modelCalls, 1);
  } finally { await runtime.dispose(); resetValidationRun(); }
});

test('tool action evidence retains redacted official arguments and explicit error result', async () => {
  const project = createProject({ brief: { ...brief, references: ['synthetic-private-key'] }, scenario: 'failure' });
  const runtime = await createProductRuntime(project, { env: { ART_MODEL_API_KEY: 'synthetic-private-key' } });
  try {
    await runtime.submit(brief.request);
    const query = project.actions.find(a => a.label === 'qloo_recommend');
    assert.deepEqual(query.arguments.signals, ['[REDACTED]']);
    assert.equal(query.result.status, 'error');
    assert.equal(query.status, 'error');
    assert.equal(query.result.resultCount, 0);
    assert.equal(JSON.stringify(project.actions).includes('synthetic-private-key'), false);
  } finally { await runtime.dispose(); }
});

test('a run failure blocks later live cases at the server before creating a project', async () => {
  resetValidationRun();
  validationRun.liveStopped = true;
  const app = createAppServer({ env: {} });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  try {
    const result = await localRequest(app.server.address().port, 'POST', '/api/projects', { brief, mode: 'live' });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /不能启动后续真实案例/);
    assert.equal(app.projects.size, 0);
  } finally { await app.dispose(); resetValidationRun(); }
});

test('a live task accepted before the run stops is blocked again when its queue entry starts', async () => {
  resetValidationRun();
  const env = { ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'synthetic', ART_MODEL_ID: 'synthetic',
    ART_MODEL_API: 'unsupported-no-network', ART_MODEL_BASE_URL: 'https://model.invalid', ART_MODEL_API_KEY: 'synthetic',
    QLOO_API_URL: 'https://qloo.invalid', QLOO_API_KEY: 'synthetic' };
  const app = createAppServer({ env });
  // Reproduce the acceptance/queue-entry race without a model or external HTTP:
  // the earlier task stops the run after this request's arrival gate passed.
  const store = app.projects.set.bind(app.projects);
  app.projects.set = (id, project) => { validationRun.liveStopped = true; return store(id, project); };
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  try {
    const created = await localRequest(app.server.address().port, 'POST', '/api/projects', { brief, mode: 'live' });
    assert.equal(created.status, 202);
    const project = await settled(app.server.address().port, created.body.project.id);
    assert.equal(project.status.phase, 'error');
    assert.equal(project.runtime.failure.code, 'VALIDATION_RUN_STOPPED');
    assert.equal(project.runtime.sessionId, null);
    assert.equal(project.usage.modelCalls, 0);
    assert.equal(project.usage.modelHttpAttempts, 0);
    assert.equal(project.usage.qlooHttpAttempts, 0);
  } finally { await app.dispose(); resetValidationRun(); }
});

test('official-shaped resolution IDs and untouched entity_id fields survive evidence extraction and validation', async () => {
  const { project, runtime } = await readyProject();
  try {
    project.mode = 'live';
    const returned = { entity_id: 'official-shaped-result', name: 'Actual returned name', type: 'urn:entity:artist', affinity: 0.41,
      properties: { description: 'Actual returned description' } };
    const interpretation = { signals: [{ input: 'Customer input', entityId: 'official-shaped-input', name: 'Resolved name', type: 'urn:entity:artist', match: 'exact' }] };
    const card = recordEvidence(project, 'recommend', { signals: ['Customer input'], target_type: 'artist' },
      { correlationId: 'local-contract-test-no-http', result: { status: 'ok', interpretation, results: [returned] } });
    assert.equal(card.inputReferences[0].id, 'official-shaped-input');
    assert.equal(card.inputReferences[0].type, 'urn:entity:artist');
    assert.deepEqual(card.inputReferences[0].resolution, interpretation.signals[0]);
    assert.deepEqual(card.returnedEntities[0], returned);
    assert.equal(Object.hasOwn(card.returnedEntities[0], 'id'), false);
    const proposal = { projectId: project.id, baseVersion: project.version, phase: 'ready', summary: '官方形状合成契约测试', questions: [], concepts: structuredClone(project.concepts) };
    proposal.concepts.forEach(c => { c.evidenceLinks = [{ evidenceId: card.id, entityId: returned.entity_id,
      observedField: 'properties.description', observedValue: returned.properties.description, observation: '精确描述字段', inspiration: '设计推断，非事实证明' }]; });
    assert.doesNotThrow(() => validateProposal(project, proposal));
    const describe = recordEvidence(project, 'describe', { entity: 'Customer input' }, { correlationId: 'describe-contract',
      result: { status: 'ok', interpretation: { entity: interpretation.signals[0] }, results: [returned] } });
    assert.equal(describe.inputReferences[0].id, 'official-shaped-input');
    assert.equal(recordEvidence(project, 'recommend', {}, { result: { status: 'needs_input' } }), undefined);
    assert.equal(project.usage.qlooHttpAttempts, 0);
  } finally { await runtime.dispose(); }
});
