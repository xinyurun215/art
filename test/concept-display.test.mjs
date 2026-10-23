import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const elements = new Map();
const context = { document: { getElementById(id) {
  if (!elements.has(id)) elements.set(id, {});
  return elements.get(id);
} } };
// Exercise the shipped renderers without starting browser event handlers or requests.
runInNewContext(source.replace("  $('load-demo').addEventListener", '  globalThis.renderers = { renderConcepts, fieldValueMarkup }; return;\n  $(\'load-demo\').addEventListener'), context);
const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const project = process.env.ART_CONCEPT_FIXTURE
  ? JSON.parse(readFileSync(process.env.ART_CONCEPT_FIXTURE, 'utf8')).project
  : { version: 3, concepts: [
    { id: 'a', mechanism: { organization: '单人动线：每人约5–7分钟，同时2–3人并行。', description: '在自检台倒置10秒，然后离场。' } },
    { id: 'b', mechanism: { organization: '两个单人舱 + 排序板；串行排队，每人约5分钟。', description: '盲握后排序，再揭晓产品。' } }
  ] };

test('full concepts expose source participation and timing without a guessed duration summary', () => {
  const before = JSON.stringify(project);
  context.renderers.renderConcepts(project);
  const fullConcepts = [...elements.get('concepts').innerHTML.matchAll(/<details class="concept-full"[^>]*>([\s\S]*?)<\/details>/g)].map(match => match[1]);
  assert.equal(fullConcepts.length, project.concepts.length);
  project.concepts.forEach((concept, index) => {
    assert.ok(fullConcepts[index].includes(escape(concept.mechanism.organization)), 'complete source field must be in the normal reading view');
    assert.match(fullConcepts[index], /proposal, not something that has been tried/);
    assert.doesNotMatch(fullConcepts[index], /原文时间信息：|按旅程推算|未明确 · 单轮时长/);
  });
  assert.equal(JSON.stringify(project), before, 'rendering must not rewrite saved content');
});

test('mechanism comparison retains the complete organization source', () => {
  const mechanisms = [...project.concepts.map(concept => concept.mechanism),
    ...(project.revisions || []).flatMap(revision => (revision.changes || []).filter(change => change.field === 'mechanism').flatMap(change => [change.before, change.after]))];
  for (const mechanism of mechanisms) {
    const html = context.renderers.fieldValueMarkup(project, 'mechanism', mechanism, 'test');
    assert.ok(html.includes(escape(mechanism.organization)), 'comparison must not use the abbreviated organization label');
  }
});

test('missing organization stays unknown and local journey times are not promoted to total duration', () => {
  context.renderers.renderConcepts({ version: 1, concepts: [{ id: 'unknown', mechanism: { description: '倒置10秒' }, journey: [{ stage: '0–2分钟', action: '局部环节' }] }] });
  const full = elements.get('concepts').innerHTML.match(/<details class="concept-full"[^>]*>([\s\S]*?)<\/details>/)[1];
  assert.match(full, /Participation and timing<\/h5><p[^>]*><span class="unknown-note">Unknown · not returned<\/span>/);
  assert.doesNotMatch(full, /按旅程推算|原文时间信息：/);
  assert.match(full, /0–2分钟/);
});
