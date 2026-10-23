import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(process.env.ART_DISPLAY_SOURCE || new URL('../public/app.js', import.meta.url), 'utf8');
const saved = process.env.ART_STATUS_FIXTURE
  ? JSON.parse(readFileSync(process.env.ART_STATUS_FIXTURE, 'utf8')).project
  : { id: 'example', mode: 'live', version: 3, selectedConceptId: 'a', brief: {},
    status: { phase: 'ready', detail: '局部修改已批准为正式版本' },
    concepts: [{ id: 'a', title: '单人自检' }],
    revisions: [{ id: 'revision-a', targetConceptId: 'a', baseVersion: 2, confirmedVersion: 3, status: 'accepted' }],
    revisionRequest: { status: 'completed' }, usage: { modelHttpAttempts: 8, qlooHttpAttempts: 4 },
    runtime: { feedback: { code: 'REVISION_RESPONSE_SAVED', reason: '正式版本未改变，须由用户审查批准。',
      nextAction: '继续提出 pending 待审修改', remainingBudget: { modelHttpAttempts: 2, qlooHttpAttempts: 0, queryStopped: true } } } };
const config = (enabled, available = enabled) => ({ modes: { live: { enabled, available, missing: available ? [] : ['example'] } } });
function ui() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', dataset: {},
      firstElementChild: {}, classList: { add() {} }, setAttribute() {}, querySelector() { return get(`${id}-option`); } });
    return elements.get(id);
  };
  const decisions = ['accept', 'reject'].map(decision => ({ dataset: { revisionDecision: decision } }));
  const context = { URL, history: { replaceState() {} }, localStorage: { setItem() {} }, window: { location: { href: 'http://127.0.0.1/' } },
    document: { getElementById: get, body: { classList: { add() {} }, setAttribute() {} },
      querySelectorAll(selector) { return selector === '[data-revision-decision]' ? decisions : []; } } };
  runInNewContext(source.replace("  $('load-demo').addEventListener", '  globalThis.ui = { state, renderProject, updateMode, loadConfig }; return;\n  $(\'load-demo\').addEventListener'), context);
  return { ...context.ui, context, get, decisions };
}
const overview = screen => screen.get('project-status').innerHTML.split('<details class="project-diagnostics"')[0];

test('accepted/live-off shows confirmed content and a viewing next step; internal feedback and usage stay hidden', () => {
  const screen = ui();
  const before = JSON.stringify(saved);
  screen.state.config = config(false);
  screen.renderProject(saved);
  assert.match(overview(screen), /修改已接受.*已确认 v3/);
  assert.match(overview(screen), /查看已确认方案/);
  assert.doesNotMatch(overview(screen), /等待你审查|继续修改已选方向/);
  assert.doesNotMatch(screen.get('project-status').innerHTML, /REVISION_RESPONSE_SAVED|pending 待审修改|请求预留|模型 8|Qloo 4|raw-record/);
  for (const id of ['send-message', 'message', 'submit-revision', 'revision-text']) assert.equal(screen.get(id).disabled, true, id);
  assert.match(screen.get('revision-note').textContent, /当前无法生成新修改/);
  assert.doesNotMatch(screen.get('concepts').innerHTML, /已选择 · 继续修改此概念/);
  assert.equal(JSON.stringify(saved), before, 'display must not mutate the saved project');
});

test('pending can still be reviewed locally with live off; feedback generation follows service availability', () => {
  const revision = saved.revisions.findLast(item => item.status === 'accepted');
  const pending = { ...saved, version: revision.baseVersion, status: { phase: 'revision_pending', detail: '正式版本未改变，须由用户审查批准。' },
    revisions: [{ ...revision, status: 'pending' }] };
  for (const enabled of [false, true]) {
    const screen = ui();
    screen.state.config = config(enabled);
    screen.renderProject(pending);
    assert.match(overview(screen), /等待你审查/);
    assert.match(overview(screen), /审阅待审修改/);
    assert.doesNotMatch(overview(screen), /修改已接受/);
    assert.deepEqual(screen.decisions.map(button => button.disabled), [false, false]);
    assert.equal(screen.get('submit-pending-feedback').disabled, !enabled);
    assert.equal(screen.get('pending-feedback-text').disabled, !enabled);
    assert.match(screen.get('pending-feedback-note').textContent, enabled ? /反馈会交给模型/ : /可接受或拒绝.*无法生成/);
  }
});

test('service status is distinct from saved live provenance and from the new-project mode selector', () => {
  for (const [settings, expected, disabled] of [[config(false), '真实服务已关闭', true],
    [config(true, false), '真实服务未就绪', true], [config(true), '真实服务已启用', false]]) {
    const screen = ui();
    screen.state.config = settings;
    screen.get('mode').value = 'offline';
    screen.renderProject(saved);
    assert.equal(screen.get('test-label').textContent, expected);
    assert.match(screen.get('mode-explanation').textContent, /已保存的真实生成项目/);
    assert.doesNotMatch(screen.get('mode-explanation').textContent, /使用模型与 Qloo 服务/);
    assert.equal(screen.get('submit-revision').disabled, disabled);
    assert.match(overview(screen), disabled ? /查看已确认方案/ : /继续修改已选方向/);
    const offline = { ...saved, mode: 'offline', provenance: { kind: 'historical_copy' } };
    screen.renderProject(offline);
    assert.match(screen.get('mode-explanation').textContent, /离线模拟.*不调用真实服务/);
    assert.equal(screen.get('submit-revision').disabled, false);
    assert.match(screen.get('project-status').innerHTML, /本轮未重新查询/);
  }
});

test('configuration arriving before or after the project yields the same guidance, including read failure', async () => {
  for (const settings of [config(false), config(true), null]) {
    const results = [];
    for (const projectFirst of [false, true]) {
      const screen = ui();
      // The VM stub has no external network access; these are deterministic responses.
      screen.context.fetch = async () => { if (!settings) throw new Error('fixture config failure'); return { ok: true, json: async () => settings }; };
      screen.context.document.createElement = () => ({ addEventListener() {} });
      screen.get('connection-error').replaceChildren = () => {};
      screen.get('connection-error').append = () => {};
      if (projectFirst) screen.renderProject(saved);
      await screen.loadConfig();
      if (!projectFirst) screen.renderProject(saved);
      results.push([overview(screen), screen.get('test-label').textContent, screen.get('submit-revision').disabled]);
      if (!settings) assert.match(screen.get('test-label').textContent, /状态待确认/);
    }
    assert.deepEqual(results[0], results[1]);
  }
});

test('a later active or failed request is not masked by an old accepted revision', () => {
  const screen = ui();
  screen.state.config = config(true);
  for (const [phase, status, expected] of [['busy', 'running', '智能体正在处理'], ['revision_needs_input', 'needs_input', '修改前还需要确认'], ['error', 'error', '本轮未完成']]) {
    screen.renderProject({ ...saved, status: { phase, detail: '当前处理信息' }, revisionRequest: { status, detail: '当前处理信息' } });
    assert.ok(overview(screen).includes(expected));
    assert.doesNotMatch(overview(screen), /修改已接受/);
  }
});

test('live-off clarification and failure notices do not instruct users to submit disabled forms', () => {
  const screen = ui();
  screen.state.config = config(false);
  for (const status of ['needs_input', 'conflict', 'interrupted', 'error']) {
    for (const kind of [undefined, 'pending_feedback']) {
      screen.renderProject({ ...saved, status: { phase: 'error' }, revisionRequest: { status, kind, question: '原问题保留' } });
      assert.match(screen.get('revision-feedback').innerHTML, /原问题保留/);
      assert.match(screen.get('revision-feedback').innerHTML, /当前无法重试/);
      assert.doesNotMatch(screen.get('revision-feedback').innerHTML, /补充答案，再继续|调整后重试|可重新提出修改/);
    }
  }
});
