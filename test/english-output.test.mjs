import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { createAppServer } from '../app/server.mjs';
import { createProject, selectConcept, setFieldLock, beginRevision, proposeRevision, decideRevision } from '../app/state.mjs';
import { referenceQuestion, requireResolvedReferences } from '../app/references.mjs';
import { budgetedFetch, safeRuntimeFailure, serverUsage, validationRun, withHttpBudget } from '../app/transport.mjs';

const english = value => assert.doesNotMatch(JSON.stringify(value), /\p{Script=Han}/u);
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function screen() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', dataset: {}, firstElementChild: {},
      classList: { add() {} }, setAttribute() {}, querySelector() { return get(`${id}-option`); } });
    return elements.get(id);
  };
  const context = { URL, history: { replaceState() {} }, localStorage: { setItem() {} }, window: { location: { href: 'http://127.0.0.1/' } },
    document: { getElementById: get, body: { classList: { add() {} }, setAttribute() {} }, querySelectorAll: () => [] } };
  runInNewContext(source.replace("  $('load-demo').addEventListener", "  globalThis.ui = { state, renderProject, proposalMarkdown, fillBrief, demo }; return;\n  $('load-demo').addEventListener"), context);
  context.ui.state.config = { modes: { live: { enabled: false, available: false } } };
  return { ...context.ui, get, elements };
}

async function demoProject(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'art-english-'));
  const app = createAppServer({ env: {}, dataDir, runtimeOptions: { memorySession: true, runtimeRoot: join(dataDir, 'runtime') } });
  let disposed = false;
  t.after(async () => { if (!disposed) await app.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (method, url, body) => {
    const result = {};
    await app.handler({ method, url, body, headers: { 'content-type': 'application/json' } }, {
      writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); }
    });
    return result;
  };
  const created = await call('POST', '/api/projects', { creationKey: randomBytes(32).toString('hex'), brief: screen().demo });
  const id = created.body.project.id;
  await call('POST', `/api/projects/${id}/start`, {});
  await app.dispose();
  disposed = true;
  return { project: app.projects.get(id), created: created.body.project, call };
}

test('a newly generated English demo keeps research questions, unresolved signals, actions and Synthetic boundaries English', async t => {
  const { project, created } = await demoProject(t);
  english(created.status);
  assert.equal(project.status.phase, 'ready'); assert.equal(project.concepts.length, 2);
  assert.equal(project.evidence.length, 1);
  english(project);
  const card = project.evidence[0];
  assert.equal(card.synthetic, true);
  assert.match(card.boundary, /Synthetic.*not Qloo data/i);
  assert.match(card.boundary, /audience|effect/i);
  assert.match(card.inputReferences[0].note, /not.*resolved|not.*verified/i);
  assert.match(card.query.designQuestion, /participat|product/i);
});

test('lock conflicts, repeated review and unresolved entity feedback stay English without translating user references', async t => {
  const { project } = await demoProject(t);
  selectConcept(project, { conceptId: project.concepts[0].id, baseVersion: project.version });
  setFieldLock(project, { field: 'title', locked: true, baseVersion: project.version });
  english(project.actions.at(-1));
  const request = beginRevision(project, { conceptId: project.selectedConceptId, baseVersion: project.version, text: 'Change the title' });
  assert.throws(() => proposeRevision(project, { requestId: request.id, phase: 'pending', summary: 'Pending title',
    changes: [{ field: 'title', after: 'New title', reason: 'Requested', evidenceRefs: [] }], impact: ['Title only'], unknowns: ['Effect unverified'] }), error => {
    assert.equal(error.code, 'FIELD_LOCKED'); english(error.message); english(error.feedback); return true;
  });
  project.revisions.push({ id: 'already-reviewed', projectId: project.id, status: 'accepted' });
  assert.throws(() => decideRevision(project, 'already-reviewed', 'accept', { baseVersion: project.version }), error => {
    assert.equal(error.code, 'REVISION_ALREADY_DECIDED'); english(error.message); return true;
  });
  const unresolved = createProject({ brief: { request: 'Keep 私人原文 exactly', references: ['私人作品'] } });
  unresolved.referenceResolutions = [{ id: 'pending', originalInput: '私人作品', projectId: unresolved.id, baseVersion: unresolved.version, status: 'pending' }];
  referenceQuestion(unresolved);
  assert(unresolved.questions[0].text.includes('私人作品'));
  english(unresolved.questions[0].text.replaceAll('私人作品', 'USER_REFERENCE'));
  assert.equal(unresolved.brief.request, 'Keep 私人原文 exactly');
  assert.throws(() => requireResolvedReferences(unresolved), error => {
    assert.equal(error.code, 'REFERENCE_CONFIRMATION_REQUIRED'); english(error.message); return true;
  });
});

test('provider failures and recovery-facing server errors use fixed English summaries with stable codes', async t => {
  Object.assign(serverUsage, { modelHttpAttempts: 0, qlooHttpAttempts: 0 });
  Object.assign(validationRun, { liveStopped: false, queryStopped: false }); delete validationRun.failure;
  const project = createProject({ mode: 'live', brief: { request: 'Synthetic provider failure' } });
  const fetch = budgetedFetch(async () => new Response('{}', { status: 503 }));
  await withHttpBudget(project, 'model', 'https://model.invalid', () => fetch('https://model.invalid/query'));
  const failure = safeRuntimeFailure(project, 'model');
  assert.equal(failure.code, 'HTTP_ERROR'); assert.equal(failure.status, 503); english(failure);
  const dataDir = await mkdtemp(join(tmpdir(), 'art-english-error-'));
  const app = createAppServer({ env: {}, dataDir });
  t.after(async () => { await app.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  const response = {};
  await app.handler({ method: 'POST', url: '/api/projects', body: { brief: { request: 'English input' } }, headers: {} }, {
    writeHead(status) { response.status = status; }, end(text) { response.body = JSON.parse(text); }
  });
  assert.equal(response.status, 400); assert.equal(response.body.code, 'CREATION_KEY_REQUIRED'); english(response.body);
});

test('page fallbacks and actual exported demo include English headings and preserve evidence boundaries and user text', async t => {
  const { project } = await demoProject(t), page = screen();
  page.renderProject(project);
  english(page.proposalMarkdown(project));
  assert.doesNotMatch(page.proposalMarkdown(project), /[；（）]/, 'English export formatting must use English separators and parentheses');
  for (const id of ['board-heading', 'board-subtitle', 'project-status', 'evidence', 'concepts', 'project-context', 'actions'])
    english(page.get(id).innerHTML + page.get(id).textContent);
  assert.match(page.proposalMarkdown(project), /synthetic fixture, not live evidence/);
  assert.match(page.proposalMarkdown(project), /not Qloo data/i);
  const empty = createProject({ brief: { request: 'A fresh English brief' } });
  empty.status = { phase: 'created', detail: '' };
  page.renderProject(empty); page.fillBrief(page.demo);
  for (const id of ['board-heading', 'board-subtitle', 'project-status', 'evidence', 'concepts', 'request', 'goal'])
    english(page.get(id).innerHTML + page.get(id).textContent + page.get(id).value);
  const before = JSON.stringify(project);
  const ownText = structuredClone(project); ownText.brief.request = '私人原文'; ownText.evidence[0].returnedEntities[0].name = '外部实体原名';
  const exported = page.proposalMarkdown(ownText);
  assert.match(exported, /私人原文/); assert.match(exported, /外部实体原名/);
  assert.equal(JSON.stringify(project), before);
});

test('export does not turn unfilled optional constraint fields into a claim of no client constraints', () => {
  const page = screen();
  const project = createProject({ brief: { request: 'Morrow in London. Keep hands-on lamp adjustment; avoid signup and personal data.' } });
  const before = JSON.stringify(project);
  const exported = page.proposalMarkdown(project);
  assert.match(exported, /Optional fields below.*separately recorded/);
  assert.match(exported, /Keep hands-on lamp adjustment; avoid signup and personal data/);
  assert.doesNotMatch(exported, /- (?:Must keep|Do not \/ avoid): None/);
  assert.match(exported, /- Must keep: No items recorded here; review the original request and clarifications/);
  assert.equal(JSON.stringify(project), before);
  project.brief.mustKeep = ['hands-on adjustment']; project.brief.avoid = ['signup'];
  const populated = JSON.stringify(project);
  assert.match(page.proposalMarkdown(project), /- Must keep: hands-on adjustment\n- Do not \/ avoid: signup/);
  assert.equal(JSON.stringify(project), populated);
  project.brief.mustKeep = []; project.brief.avoid = [];
  project.clarifications = [{ question: 'Keep the earlier constraints?', answer: 'Remove the earlier keep and avoid items.' }];
  const cleared = page.proposalMarkdown(project);
  assert.match(cleared, /Remove the earlier keep and avoid items/);
  assert.match(cleared, /- Must keep: No items recorded here; review the original request and clarifications/);
  assert.doesNotMatch(cleared, /Not entered separately/);
});
