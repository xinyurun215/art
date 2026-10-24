import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createProject } from '../app/state.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const legacyBrief = {
  request: '合成验收任务：为虚构运动鞋品牌「未定式」的新日常鞋款设计快闪。希望来访者通过身体参与和试穿理解产品，比较两种实质不同的参与方式。音乐、电影偏好只是待研究信号，不是真实受众画像。',
  brand: '未定式 · 虚构运动鞋品牌（演示输入）', goal: '让来访者通过体验理解新鞋款，保留试穿',
  references: ['独立音乐', '电影叙事'], venue: '上海，室内约 150 平方米，具体场地未确认',
  budget: '8–12 万元；客户输入，未经报价验证', mustKeep: '试穿', avoid: '强制注册、未经确认的版权与效果承诺'
};
const ambiguousRequest = '合成验收任务：为虚构运动鞋品牌「未定式」设计快闪。希望保留试穿，用音乐和电影作为研究线索。城市与场地还没想好，请先确认会影响方案的条件。';
const storedReferences = ['独立音乐、电影叙事', '客户提供的研究信号', '实体尚未核实'];
const boundary = '合成数据；虚构实体，非 Qloo 数据、非真实受众画像或活动效果证据。';

function page() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', dataset: {}, firstElementChild: {},
      classList: { add() {} }, setAttribute() {}, querySelector() { return get(`${id}-option`); } });
    return elements.get(id);
  };
  const context = { URL, history: { replaceState() {} }, localStorage: { setItem() {} }, window: { location: { href: 'https://art.invalid/' } },
    document: { getElementById: get, body: { classList: { add() {} }, setAttribute() {} }, querySelectorAll: () => [] } };
  runInNewContext(source.replace("  $('load-demo').addEventListener", "  globalThis.ui = { state, renderProject, proposalMarkdown, demo }; return;\n  $('load-demo').addEventListener"), context);
  context.ui.state.config = { production: true, modes: { live: { enabled: true, available: true } } };
  return { ...context.ui, get };
}

test('exact historical official demo briefs have an English display and export without rewriting the saved record', () => {
  for (const brief of [legacyBrief, { ...legacyBrief, request: ambiguousRequest, venue: '', budget: '' }, { ...legacyBrief, references: storedReferences }]) {
    const screen = page(), project = createProject({ brief });
    project.version = 2; project.status = { phase: 'ready', detail: '两个概念已可比较' };
    project.concepts = [{ id: 'demo-a', title: 'Scheduled group try-on',
      journey: [{ stage: 'Try on', action: 'The movement tasks include 试穿. People write down how it feels on site.' }],
      productTouchpoints: ['试穿: staff help with the experience and collect a description of comfort.'] },
    { id: 'demo-b', title: 'Self-paced exploration',
      journey: [{ stage: 'Product note', action: 'After 试穿, write a personal note. That note advances the story.' }],
      productTouchpoints: ['试穿: each station has one product experience a person can finish alone.'] }];
    const before = JSON.stringify(project);
    screen.renderProject(project);
    assert.equal(screen.get('board-heading').textContent, screen.demo.brand);
    assert.equal(screen.get('board-subtitle').textContent, screen.demo.goal);
    for (const id of ['project-context', 'project-status', 'version-stamp', 'mode-explanation', 'concepts'])
      assert.doesNotMatch(screen.get(id).innerHTML + screen.get(id).textContent, /\p{Script=Han}/u);
    assert.match(screen.get('project-context').innerHTML, /English translation.*official demo/i);
    const exported = screen.proposalMarkdown(project);
    assert.doesNotMatch(exported, /\p{Script=Han}/u);
    assert.match(exported, /English translation.*official demo/i);
    assert.match(exported, /After try-on, write a personal note/);
    assert.match(exported, /try-on: staff help/);
    if (brief.references === storedReferences) {
      assert.match(exported, /Client-provided research signals/);
      assert.match(exported, /Entities have not been verified/);
    }
    assert.match(exported, /synthetic fixtures.*Not a live model or Qloo result/i);
    assert.equal(JSON.stringify(project), before);
    assert.equal(screen.state.project, project);
  }
});

test('private input and live records are preserved even when they resemble the old official sample', () => {
  for (const input of [
    { mode: 'live', brief: legacyBrief },
    { brief: { ...legacyBrief, request: '私人要求，不能替换：试穿。' } },
    { brief: { ...legacyBrief, mustKeep: ['试穿', '私人条件'] } },
    { brief: { ...legacyBrief, references: [...storedReferences, '私人参考'] } }
  ]) {
    const screen = page(), project = createProject(input), before = JSON.stringify(project);
    screen.renderProject(project);
    assert.equal(screen.get('board-heading').textContent, legacyBrief.brand);
    assert.match(screen.proposalMarkdown(project), new RegExp(project.brief.request.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(JSON.stringify(project), before);
  }
});

test('the old application-authored synthetic boundary is displayed in English while source evidence stays literal', () => {
  const screen = page(), project = createProject({ brief: { request: 'Private input stays private' } });
  const card = { id: 'fixture-card', projectId: project.id, synthetic: true, source: 'local:fixtures/culture-signals.json',
    boundary, query: { designQuestion: 'Original question', input: { signals: ['原始输入'] } },
    inputReferences: [{ id: 'fixture:input-1', name: '原始输入', synthetic: true }],
    returnedEntities: [{ id: 'fixture:communal-rhythm', name: '原始返回值', properties: { participation: 'shared rhythm' } }] };
  project.evidence = [card];
  const before = JSON.stringify(project);
  screen.renderProject(project);
  assert.doesNotMatch(screen.get('evidence').innerHTML, new RegExp(boundary));
  assert.match(screen.get('evidence').innerHTML, /Synthetic data.*not Qloo data/);
  const exported = screen.proposalMarkdown(project);
  assert.doesNotMatch(exported, new RegExp(boundary));
  assert.match(exported, /原始输入/); assert.match(exported, /原始返回值/);
  assert.match(exported, /local:fixtures\/culture-signals.json/);
  assert.equal(JSON.stringify(project), before);
  card.query.designQuestion = '哪些文化信号能够影响参与组织与产品接触方式？';
  card.context = { referenceStatus: '合成样本，未解析真实实体' };
  const withOldFixedText = screen.proposalMarkdown(project);
  assert.match(withOldFixedText, /Which cultural signals could change participation and product contact/);
  assert.match(withOldFixedText, /English translation of recorded demo text/);
  assert.match(withOldFixedText, /Synthetic sample; real entities have not been resolved/);
  assert.match(withOldFixedText, /原始输入/);
  for (const changed of [{ ...card, synthetic: false }, { ...card, source: 'Qloo official workflow' }]) {
    project.evidence = [changed];
    assert.match(screen.proposalMarkdown(project), new RegExp(boundary), 'a real or unrelated source is never translated');
  }
});

test('the English document opts out of browser translation of fixed UI copy', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<html\b[^>]*lang="en"[^>]*translate="no"/);
  assert.match(html, /<meta name="google" content="notranslate">/);
});

test('read-only selected and unselected concepts do not advertise editing actions', () => {
  const screen = page();
  const recorded = JSON.parse(readFileSync(new URL('../fixtures/completed-case.json', import.meta.url), 'utf8'));
  screen.renderProject(recorded);
  assert.match(screen.get('concepts').innerHTML, /Selected concept · read only/);
  assert.match(screen.get('concepts').innerHTML, /Concept A · read only|Concept B · read only/);
  assert.doesNotMatch(screen.get('concepts').innerHTML, /open the revision|Choose concept/);
  const editable = createProject({ mode: 'live', brief: { request: 'Actual private project' } });
  editable.concepts = recorded.concepts; editable.selectedConceptId = editable.concepts[0].id;
  screen.renderProject(editable);
  assert.match(screen.get('concepts').innerHTML, /Selected · open the revision/);
  assert.match(screen.get('concepts').innerHTML, /Choose concept B/);
});
