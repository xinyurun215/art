import test from 'node:test';
import { createAndStart } from './project-http.mjs';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createProject, applyProposal, selectConcept, beginRevision, beginPendingFeedback,
  pendingRevisionDraft, REVISION_FIELDS } from '../app/state.mjs';
import { createProductRuntime, REVISION_TOOL_NAMES } from '../app/runtime.mjs';
import { createAppServer } from '../app/server.mjs';

const brief = { request: '合成修订测试：随行杯试握和开合，非真实项目或研究', venue: '测试室内',
  mustKeep: ['试握', '开合'], avoid: ['强制购买'] };
const concepts = ['a', 'b'].map(id => ({ id, title: `合成方案${id}`, coreClaim: '双人试握和开合',
  mechanism: { organization: id === 'a' ? '双人互测' : '个人观察', description: id === 'a'
    ? '两人轮流试握和开合，由搭档记录反馈' : '个人独立试握和开合后记录感受' },
  journey: [{ stage: '到场', action: '领取记录卡' }, { stage: '参与', action: '试握和开合' }, { stage: '离开', action: '带走记录卡' }],
  productTouchpoints: ['试握', '开合', '保留材质样本'], evidenceLinks: [],
  openQuestions: ['现场容量未知'], unverifiedEffects: ['参与效果未经验证'] }));
const proposal = version => ({ baseVersion: version, phase: 'insufficient_evidence',
  summary: '合成测试起点，没有查询或文化证据，不代表设计验证', concepts: structuredClone(concepts) });
const change = (field, after) => ({ field, after: structuredClone(after), reason: '合成客户反馈对应的设计推断，效果待验证', evidenceRefs: [] });
const revision = changes => ({ phase: 'pending', summary: '合成本地待审稿', changes,
  impact: ['取消角色交接，改为单人自主试握和开合；保留材质样本及记录卡'],
  unknowns: ['单人操作指引与现场容量仍待验证，不保证效果或密封安全'] });
const replacement = {
  coreClaim: '单人自主试握和开合，记录个人感受',
  mechanism: { organization: '单人随到随做', description: '参与者自主试握和开合，再对照操作说明检查并记录，无角色交接' },
  journey: [{ stage: '到场', action: '领取原记录卡' }, { stage: '自主参与', action: '独立试握和开合，按说明自查并记录' },
    { stage: '离开', action: '带走原记录卡' }],
  productTouchpoints: ['自主试握', '自主开合', '保留材质样本'],
  openQuestions: ['现场容量未知', '自主操作指引是否清楚尚待验证'],
};
function seed() {
  const project = createProject({ brief });
  applyProposal(project, { ...proposal(project.version), projectId: project.id });
  selectConcept(project, { conceptId: 'a', baseVersion: project.version });
  return project;
}
const resultsSinceUser = context => context.messages.slice(context.messages.findLastIndex(message => message.role === 'user') + 1)
  .filter(message => message.role === 'toolResult').map(message => JSON.parse(message.content[0].text));

test('revision model receives complete impact contract and actionable missing-impact feedback', async t => {
  let externalAttempts = 0, calls = 0, seenTool, seenTools, feedback;
  t.mock.method(globalThis, 'fetch', () => { externalAttempts++; throw new Error('LOCAL_ONLY'); });
  const project = seed(), official = structuredClone(project.concepts);
  beginRevision(project, { conceptId: 'a', baseVersion: project.version, text: '仅调整合成标题' });
  const dataDir = mkdtempSync(join(tmpdir(), 'art-revision-contract-'));
  const runtime = await createProductRuntime(project, { env: {}, memorySession: true, runtimeRoot: dataDir,
    decide(context) {
      calls++;
      const tool = context.tools.find(tool => tool.name === 'propose_concept_revision');
      seenTool = tool; seenTools = context.tools.map(tool => tool.name);
      if (calls === 1) {
        const input = revision([change('title', '合成待审标题')]); delete input.impact;
        return [{ type: 'toolCall', id: 'missing-impact', name: tool.name, arguments: input }];
      }
      feedback = resultsSinceUser(context).at(-1).feedback;
      return [{ type: 'text', text: '合成模型暂停，不编造影响评估' }];
    } });
  try {
    await runtime.submit(project.revisionRequest.text);
    assert.deepEqual(seenTools.sort(), [...REVISION_TOOL_NAMES].sort());
    assert(seenTool.parameters.required.includes('impact'));
    assert.equal(seenTool.parameters.properties.impact.type, 'array');
    assert.match(seenTool.parameters.properties.impact.description, /Required top-level array/);
    assert.match(seenTool.description, /"impact":\[/);
    assert.equal(feedback.code, 'REVISION_SCHEMA_INVALID'); assert.equal(feedback.path, '/impact');
    assert.equal(feedback.expectedType, 'array'); assert.equal(feedback.actualType, 'missing');
    assert.equal(feedback.correctable, true);
    assert.doesNotMatch(feedback.nextAction, /insufficient_evidence/);
    assert.match(feedback.nextAction, /needs_input or conflict/);
    assert.equal(project.runtime.failure, undefined);
    assert.equal(calls, 2); assert.deepEqual(project.concepts, official); assert.equal(project.revisions.length, 0);
    assert.equal(externalAttempts, 0);
  } finally {
    await runtime.dispose(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('every unchanged revision field is rejected against the official concept or current pending draft', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'art-revision-contract-'));
  const project = seed();
  let pass = 0, check = 0, runtime;
  try {
    runtime = await createProductRuntime(project, { env: {}, memorySession: true, runtimeRoot: dataDir,
      decide(context, snapshot) {
        const results = resultsSinceUser(context);
        if (!results.length) {
          const tool = context.tools.find(tool => tool.name === 'propose_concept_revision');
          assert.match(tool.parameters.properties.changes.description, /currentPendingDraft/);
          assert.match(tool.parameters.properties.changes.description, /Omit unchanged fields/);
          const base = snapshot.currentPendingDraft ?? snapshot.concepts.find(concept => concept.id === 'a');
          return REVISION_FIELDS.map(field => ({ type: 'toolCall', id: `${pass}-${field}`, name: tool.name,
            arguments: revision([change(field, base[field])]) }));
        }
        assert.equal(results.length, REVISION_FIELDS.length);
        for (const { feedback } of results) {
          assert.equal(feedback.code, 'REVISION_INVALID'); assert.equal(feedback.path, '/changes/0/after');
          assert.match(feedback.reason, pass ? /current pending draft/ : /confirmed content/);
          assert.match(feedback.nextAction, /Remove unchanged change entries/);
          assert.doesNotMatch(feedback.nextAction, /insufficient_evidence/); check++;
        }
        return [{ type: 'toolCall', id: `${pass}-valid`, name: 'propose_concept_revision',
          arguments: revision([change('title', pass ? '合成待审标题二' : '合成待审标题一')]) }];
      } });
    const official = structuredClone(project.concepts);
    beginRevision(project, { conceptId: 'a', baseVersion: project.version, text: '合成首次反馈' });
    await runtime.submit(project.revisionRequest.text);
    assert.equal(project.revisions.length, 1); assert.deepEqual(project.concepts, official);
    pass = 1;
    beginPendingFeedback(project, project.revisions[0].id, { baseVersion: project.version, text: '合成待审稿反馈' });
    await runtime.submit(project.revisionRequest.text);
    assert.equal(check, 2 * REVISION_FIELDS.length);
    assert.deepEqual(project.concepts, official); assert.equal(project.revisions[0].status, 'superseded');
    assert.equal(pendingRevisionDraft(project, project.revisions[1]).title, '合成待审标题二');
    assert.equal(project.usage.modelHttpAttempts, 0); assert.equal(project.usage.qlooHttpAttempts, 0);
  } finally {
    await runtime?.dispose(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function local(port, method, path, input) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => done({ status: response.statusCode, ...JSON.parse(text) }));
    });
    req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
}
async function listen(app) {
  await new Promise((done, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', done); });
  return app.server.address().port;
}
async function settled(port, route) {
  for (let i = 0; i < 150; i++) {
    const { project } = await local(port, 'GET', route);
    if (project.status.phase !== 'busy') return project;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('Local revision did not settle');
}

test('HTTP fake model corrects missing impact and unchanged sixth field, then reject, resubmit, accept and restore', async t => {
  let externalAttempts = 0, checked = [];
  t.mock.method(globalThis, 'fetch', () => { externalAttempts++; throw new Error('LOCAL_ONLY'); });
  const dataDir = mkdtempSync(join(tmpdir(), 'art-revision-contract-'));
  const runtimeOptions = { memorySession: true, runtimeRoot: join(dataDir, 'runtime'), decide(context, snapshot) {
    if (!snapshot.revisionRequest) return [{ type: 'toolCall', id: 'synthetic-start', name: 'propose_design_response', arguments: proposal(snapshot.version) }];
    const feedback = resultsSinceUser(context).at(-1)?.feedback;
    const changes = Object.entries(replacement).map(([field, after]) => change(field, after));
    const input = revision(changes);
    if (snapshot.revisionRequest.text === '合成反馈一：取消双人交接') {
      if (!feedback) delete input.impact;
      else if (feedback.code === 'REVISION_SCHEMA_INVALID') {
        assert.equal(feedback.path, '/impact');
        assert.doesNotMatch(feedback.nextAction, /insufficient_evidence/);
        input.changes.push(change('unverifiedEffects', snapshot.concepts[0].unverifiedEffects));
        checked.push('missing-impact');
      } else {
        assert.equal(feedback.code, 'REVISION_INVALID'); assert.equal(feedback.path, '/changes/5/after');
        assert.match(feedback.nextAction, /Remove unchanged change entries/);
        checked.push('unchanged-sixth-field');
      }
    }
    return [{ type: 'toolCall', id: `${snapshot.revisionRequest.id}-${feedback?.code ?? 'initial'}`, name: 'propose_concept_revision', arguments: input }];
  } };
  let app = createAppServer({ env: {}, dataDir, runtimeOptions });
  try {
    let port = await listen(app);
    const created = await createAndStart((...args) => local(port, ...args), { mode: 'offline', brief });
    assert.equal(created.status, 202);
    const route = `/api/projects/${created.project.id}`;
    let project = await settled(port, route);
    assert.equal(project.version, 2); assert.equal(project.concepts.length, 2);
    project = (await local(port, 'POST', `${route}/select`, { conceptId: 'a', baseVersion: 2 })).project;
    const official = structuredClone(project.concepts), originalBrief = structuredClone(project.brief);
    for (const decision of ['reject', 'accept']) {
      const submitted = await local(port, 'POST', `${route}/revisions`, { conceptId: 'a', baseVersion: 2,
        text: decision === 'reject' ? '合成反馈一：取消双人交接' : '合成反馈二：重新提交单人自主方案' });
      assert.equal(submitted.status, 202);
      project = await settled(port, route);
      assert.equal(project.status.phase, 'revision_pending', JSON.stringify({ status: project.status, feedback: project.runtime.feedback,
        failure: project.runtime.failure, checked })); assert.equal(project.version, 2);
      assert.deepEqual(project.concepts, official); assert.deepEqual(project.brief, originalBrief);
      const pending = project.revisions.at(-1);
      assert.deepEqual(pending.changes.map(change => change.field), Object.keys(replacement));
      assert.deepEqual(pending.impact, revision([]).impact); assert.deepEqual(pending.unknowns, revision([]).unknowns);
      assert.deepEqual((await local(port, 'GET', route)).project, project, 'refresh preserves the pending draft and official content');
      await app.dispose(); app = createAppServer({ env: {}, dataDir, runtimeOptions }); port = await listen(app);
      assert.deepEqual((await local(port, 'GET', route)).project, project, 'restart preserves the pending draft');
      const decided = await local(port, 'POST', `${route}/revisions/${pending.id}/${decision}`, { baseVersion: 2 });
      assert.equal(decided.status, 200); project = decided.project;
      assert.equal(project.version, decision === 'reject' ? 2 : 3);
      assert.deepEqual(project.concepts, decision === 'reject' ? official : [{ ...official[0], ...replacement }, official[1]]);
    }
    assert.deepEqual(checked, ['missing-impact', 'unchanged-sixth-field']);
    assert.deepEqual(project.revisions.map(revision => revision.status), ['rejected', 'accepted']);
    assert.deepEqual(project.versionHistory.map(version => version.version), [2, 3]);
    assert.equal(project.selectedConceptId, 'a'); assert.deepEqual(project.brief, originalBrief);
    assert.equal(project.actions.filter(action => action.type === 'query').length, 0); assert.equal(project.evidence.length, 0);
    assert.equal(project.usage.modelHttpAttempts, 0); assert.equal(project.usage.qlooHttpAttempts, 0);
    const rejected = project.actions.filter(action => action.feedback?.code.startsWith('REVISION_') && action.status === 'error');
    assert.deepEqual(rejected.map(action => action.feedback.path), ['/impact', '/changes/5/after']);
    await app.dispose(); app = createAppServer({ env: {}, dataDir, runtimeOptions }); port = await listen(app);
    assert.deepEqual((await local(port, 'GET', route)).project, project, 'refresh after restart retains accepted state and error history');
    await app.dispose(); app = null;
    const fields = ['id', 'version', 'brief', 'concepts', 'evidence', 'selectedConceptId', 'revisions', 'versionHistory', 'actions', 'usage'];
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createAppServer } from './app/server.mjs';
      globalThis.fetch = () => { throw new Error('RESTORE_ONLY_NO_NETWORK'); };
      const app = createAppServer({ env: {}, dataDir: process.argv[1] });
      try { const p = app.projects.get(process.argv[2]); console.log(JSON.stringify(Object.fromEntries(
        JSON.parse(process.argv[3]).map(key => [key, p[key]])))); } finally { await app.dispose(); }
    `, dataDir, project.id, JSON.stringify(fields)], { cwd: resolve(import.meta.dirname, '..'),
      env: { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() }, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), Object.fromEntries(fields.map(key => [key, project[key]])), 'a new process loads the accepted version');
    assert.equal(externalAttempts, 0);
  } finally {
    await app?.dispose(); assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
