import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

let externalAttempts = 0;
const deny = () => { externalAttempts++; throw new Error('Save test attempted external network'); };
globalThis.fetch = deny;
tls.connect = deny;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'object' ? first.host ?? first.hostname ?? 'localhost'
    : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return deny();
  return connect.apply(this, args);
};
syncBuiltinESMExports();
const { createAppServer } = await import('../app/server.mjs');
const { createProject, applyProposal, selectConcept, beginRevision, proposeRevision } = await import('../app/state.mjs');
const { referenceQuestion } = await import('../app/references.mjs');
const { offlineDecision } = await import('../app/runtime.mjs');
after(() => assert.equal(externalAttempts, 0));

const brief = { request: '明确离线保存一致性验证；保留原始需求。', venue: '上海测试室内', budget: '20万元', mustKeep: ['试穿'] };
function questionProject() {
  const project = createProject({ brief });
  applyProposal(project, { projectId: project.id, baseVersion: project.version, phase: 'needs_input',
    summary: '明确离线测试问题', questions: [{ field: 'budget', text: '预算是否需要明确修改？' }], concepts: [] });
  return project;
}
const answer = project => ({ text: '  明确预算改为15万元，其余原始条件保持。\n',
  clarification: { questionId: project.questions[0].id, baseVersion: project.version },
  briefUpdate: { field: 'budget', value: '15万元' } });
function decision(_context, project) {
  return [{ type: 'toolCall', id: `save-test-${project.version}`, name: 'propose_design_response', arguments: {
    baseVersion: project.version, phase: 'needs_input', summary: '离线保存后继续；无外部请求。',
    questions: [{ field: 'request', text: '还有其他条件吗？' }], concepts: [] } }];
}
function call(port, method, path, payload) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; });
      response.on('end', () => done({ status: response.statusCode, ...JSON.parse(raw) }));
    });
    req.on('error', reject); req.end(payload ? JSON.stringify(payload) : undefined);
  });
}
async function listen(app) {
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  return app.server.address().port;
}
async function settled(port, id) {
  for (let n = 0; n < 300; n++) {
    const { project } = await call(port, 'GET', `/api/projects/${id}`);
    if (project.status.phase !== 'busy') return project;
    await new Promise(done => setTimeout(done, 15));
  }
  throw new Error('isolated save test did not settle');
}
function failReplacements(t, dataDir, condition = () => true) {
  const rename = fs.renameSync;
  let enabled = true, failures = 0;
  t.mock.method(fs, 'renameSync', (source, target) => {
    const path = resolve(String(target));
    if (enabled && path.startsWith(resolve(dataDir) + sep) && !path.includes(`${sep}.http-budget${sep}`) && condition(source, target)) {
      failures++; throw Object.assign(new Error('Injected replacement failure'), { code: 'EPERM', syscall: 'rename' });
    }
    return rename(source, target);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { clear() { enabled = false; }, get failures() { return failures; } };
}
function fixture(t) {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'art-project-save-'));
  let app, modelCallbacks = 0;
  const options = { env: {}, dataDir, runtimeOptions: { decide(...args) { modelCallbacks++; return decision(...args); } } };
  t.after(async () => {
    await app.dispose();
    assert(resolve(dataDir).startsWith(resolve(tmpdir()) + sep));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, options, get modelCallbacks() { return modelCallbacks; }, start() { app = createAppServer(options); return app; } };
}

test('replacement EPERM keeps saved authority and counters; normal retry applies the retained answer once and survives restart', async t => {
  const f = fixture(t), app = f.start(), seed = questionProject(); app.saveProject(seed);
  const port = await listen(app), route = `/api/projects/${seed.id}`, input = answer(seed);
  const path = join(f.dataDir, `${seed.id}.json`), before = fs.readFileSync(path, 'utf8');
  const ledger = fs.readFileSync(join(f.dataDir, '.http-budget', 'run.json'), 'utf8');
  const injected = failReplacements(t, f.dataDir);
  const failed = await call(port, 'POST', `${route}/messages`, input);
  assert.equal(injected.failures, 1);
  assert.equal(fs.readFileSync(path, 'utf8'), before);
  assert.deepEqual(app.projects.get(seed.id), JSON.parse(before).project);
  assert.equal(failed.status, 503); assert.equal(failed.code, 'PROJECT_SAVE_FAILED'); assert.match(failed.error, /未保存/);
  assert.deepEqual((await call(port, 'GET', route)).project, JSON.parse(before).project);
  assert.equal(fs.readFileSync(join(f.dataDir, '.http-budget', 'run.json'), 'utf8'), ledger);
  assert.equal(seed.version, 2); assert.equal(seed.clarifications.length, 0); assert.equal(seed.usage.modelCalls, 0);
  assert.equal(f.modelCallbacks, 0);
  assert.equal(seed.usage.modelHttpAttempts, 0); assert.equal(seed.usage.qlooHttpAttempts, 0);
  assert.equal(input.text, '  明确预算改为15万元，其余原始条件保持。\n');
  injected.clear();
  assert.equal((await call(port, 'POST', `${route}/messages`, input)).status, 202);
  const saved = await settled(port, seed.id);
  assert.equal(saved.clarifications.length, 1); assert.equal(saved.clarifications[0].answer, input.text);
  assert.equal(saved.brief.budget, '15万元'); assert.equal(saved.brief.request, brief.request);
  assert.equal(saved.version, 4); assert.equal(saved.usage.modelCalls, 1);
  assert.equal((await call(port, 'POST', `${route}/messages`, input)).status, 409);
  assert.deepEqual((await call(port, 'GET', route)).project, saved);
  fs.writeFileSync(`${path}.tmp`, JSON.stringify({ schemaVersion: 1, project: { ...saved, version: 999 } }));
  await app.dispose(); const restarted = f.start(); const nextPort = await listen(restarted);
  assert.deepEqual((await call(nextPort, 'GET', route)).project, saved, 'temporary candidates never replace the formal snapshot on restart');
  const nextInput = { text: '保留已成功保存的预算', clarification: { questionId: saved.questions[0].id, baseVersion: saved.version } };
  assert.equal((await call(nextPort, 'POST', `${route}/messages`, nextInput)).status, 202);
  const final = await settled(nextPort, seed.id);
  assert.equal(final.clarifications.length, 2); assert.equal(final.brief.budget, '15万元');
  assert.equal(final.runtime.sessionId, saved.runtime.sessionId);
  assert.deepEqual(JSON.parse(fs.readFileSync(path, 'utf8')).project, final);
});

function readyProject(pending = false) {
  const project = createProject({ brief }); project.status = { phase: 'ready', detail: '已保存正式版本' };
  project.concepts = ['a', 'b'].map(id => ({ id, title: id, coreClaim: '试穿并记录',
    mechanism: { organization: id, description: '试穿并记录' }, journey: ['来', '做', '走'].map(stage => ({ stage, action: '试穿并记录' })),
    productTouchpoints: ['试穿'], evidenceLinks: [], openQuestions: [], unverifiedEffects: ['效果未知'] }));
  selectConcept(project, { conceptId: 'a', baseVersion: project.version });
  if (pending) {
    const request = beginRevision(project, { conceptId: 'a', baseVersion: project.version, text: '修改标题' });
    proposeRevision(project, { requestId: request.id, phase: 'pending', summary: '明确离线待审稿',
      changes: [{ field: 'title', after: '待审标题', reason: '用户指定，效果未知', evidenceRefs: [] }], impact: ['标题变化'], unknowns: ['效果未知'] });
  }
  return project;
}
test('all shared HTTP writers preserve authority on replacement failure, including one-save reference continuation and new projects', async t => {
  const f = fixture(t), app = f.start(), port = await listen(app);
  const cases = [
    [readyProject(), '/select', project => ({ conceptId: 'b', baseVersion: project.version })],
    [readyProject(), '/revisions', project => ({ conceptId: 'a', baseVersion: project.version, text: '修改标题' })],
    ...['accept', 'reject', 'feedback'].map(kind => [readyProject(true), kind, project => ({ baseVersion: project.version, ...(kind === 'feedback' ? { text: '继续修改待审标题' } : {}) })]),
    ...['confirm', 'cancel', 'clarify', 'missing'].map(kind => {
      const project = questionProject();
      project.referenceResolutions = [{ id: 'resolution', projectId: project.id, baseVersion: project.version,
        status: 'pending', input: '明确合成作品', originalInput: '明确合成作品', sourceField: 'references', sourceText: '明确合成作品',
        candidates: [{ id: 'synthetic-candidate', name: '明确合成作品', type: 'urn:entity:movie' }] }];
      project.brief.references = ['明确合成作品']; referenceQuestion(project);
      return [project, '/messages', () => kind === 'missing' ? { text: '不会默认确认' } : { referenceResolution: {
        resolutionId: 'resolution', baseVersion: project.version, action: kind, ...(kind === 'confirm' ? { selectedId: 'synthetic-candidate' } : {}),
        ...(kind === 'clarify' ? { text: '补充创作者，仍待确认' } : {}) } }];
    })
  ];
  for (const [project] of cases) app.saveProject(project);
  const injected = failReplacements(t, f.dataDir);
  for (const [project, suffix, payload] of cases) {
    const route = `/api/projects/${project.id}`, path = join(f.dataDir, `${project.id}.json`), before = fs.readFileSync(path, 'utf8');
    const endpoint = ['accept', 'reject', 'feedback'].includes(suffix) ? `/revisions/${project.revisions[0].id}/${suffix}` : suffix;
    const result = await call(port, 'POST', route + endpoint, payload(project));
    assert.equal(fs.readFileSync(path, 'utf8'), before, endpoint);
    assert.deepEqual(app.projects.get(project.id), JSON.parse(before).project, endpoint);
    assert.equal(result.code, 'PROJECT_SAVE_FAILED', endpoint);
    assert.equal(project.usage.modelCalls, 0, endpoint);
  }
  const count = app.projects.size;
  assert.equal((await call(port, 'POST', '/api/projects', { mode: 'offline', brief })).code, 'PROJECT_SAVE_FAILED');
  assert.equal(app.projects.size, count, 'failed new projects are not published or queued');
  assert.equal(injected.failures, cases.length + 1);
  assert.equal(f.modelCallbacks, 0);
});

test('a request paused while reading its body rechecks busy and cannot overwrite an accepted queued update', async t => {
  const f = fixture(t);
  let release, enter, queried = false;
  const gate = new Promise(done => { release = done; }), entered = new Promise(done => { enter = done; });
  f.options.runtimeOptions = { decide(context, project) {
    if (project.revisionRequest) return offlineDecision(context, project);
    if (!queried) { queried = true; return [{ type: 'toolCall', id: 'queue-blocker', name: 'qloo_describe', arguments: { entity: '明确合成参考', type: 'artist' } }]; }
    return decision(context, project);
  }, qlooExecutor: { transport: { kind: 'direct', name: 'offline-queue-gate', remote: false }, async execute() {
    enter(); await gate; return { correlationId: 'explicit-no-http', result: { status: 'ok', results: [] } };
  } } };
  const app = f.start(), seed = readyProject(); app.saveProject(seed);
  const port = await listen(app), route = `/api/projects/${seed.id}`;
  await call(port, 'POST', '/api/projects', { mode: 'offline', brief });
  await entered;
  let delayed;
  const response = new Promise((done, reject) => {
    delayed = request({ hostname: '127.0.0.1', port, path: `${route}/select`, method: 'POST' }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => done({ status: res.statusCode, ...JSON.parse(raw) }));
    });
    delayed.on('error', reject); delayed.write('{"conceptId":');
  });
  try {
    await new Promise(done => setTimeout(done, 20));
    const input = { conceptId: 'a', baseVersion: seed.version, text: '明确离线修改；等待前一项目完成' };
    assert.equal((await call(port, 'POST', `${route}/revisions`, input)).status, 202);
    assert.equal((await call(port, 'POST', `${route}/revisions`, input)).status, 409);
    delayed.end(JSON.stringify({ conceptId: 'b', baseVersion: seed.version }).slice('{"conceptId":'.length));
    assert.equal((await response).status, 409);
    assert.equal(app.projects.get(seed.id).selectedConceptId, 'a');
    assert.equal(app.projects.get(seed.id).revisionRequest.text, input.text);
  } finally { release(); }
  const final = await settled(port, seed.id);
  assert.equal(final.selectedConceptId, 'a'); assert.equal(final.usage.modelCalls, 1);
  assert.equal(final.revisionRequest.status, 'needs_input');
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.dataDir, `${seed.id}.json`), 'utf8')).project, final);
});

test('a failed final replacement leaves the last saved bytes authoritative and does not poison later queued projects or shutdown', async t => {
  const f = fixture(t), app = f.start(), first = questionProject(), second = questionProject();
  app.saveProject(first); app.saveProject(second);
  const port = await listen(app), path = join(f.dataDir, `${first.id}.json`);
  const injected = failReplacements(t, f.dataDir, (source, target) => resolve(String(target)) === resolve(path)
    && JSON.parse(fs.readFileSync(source, 'utf8')).project.status.phase !== 'busy');
  const accepted = await call(port, 'POST', `/api/projects/${first.id}/messages`, answer(first));
  const priorBytes = fs.readFileSync(path, 'utf8');
  assert.equal(accepted.status, 202);
  assert.equal((await call(port, 'POST', `/api/projects/${second.id}/messages`, answer(second))).status, 202);
  const final = await settled(port, second.id);
  assert.equal(final.clarifications.length, 1); assert.equal(final.usage.modelCalls, 1);
  assert.equal(injected.failures, 1); assert.equal(fs.readFileSync(path, 'utf8'), priorBytes);
  assert.deepEqual(app.projects.get(first.id), JSON.parse(priorBytes).project);
  injected.clear(); await app.dispose();
  const restarted = f.start();
  assert.equal(restarted.projects.get(first.id).status.phase, 'interrupted');
  assert.deepEqual(restarted.projects.get(second.id), final);
});
