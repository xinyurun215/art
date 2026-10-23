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
runInNewContext(source.replace("  $('load-demo').addEventListener", '  globalThis.renderRevision = renderRevision; return;\n  $(\'load-demo\').addEventListener'), context);
const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const project = process.env.ART_REVISION_FIXTURE
  ? JSON.parse(readFileSync(process.env.ART_REVISION_FIXTURE, 'utf8')).project
  : { id: 'example', version: 3, selectedConceptId: 'a', concepts: [{ id: 'a', title: '单人自检' }], revisions: [{
    id: 'revision-a', status: 'accepted', targetConceptId: 'a', baseVersion: 2, confirmedVersion: 3,
    summary: '取消交接，保留试握', changes: [{ field: 'title', before: '双人交接', after: '单人自检', reason: '按客户反馈调整' }],
    impact: ['双人交接改为单人自检', '保留试握；人力需求下降为方案推断'],
    unknowns: ['现场容量未测算', '成本与安全未知 <不是认证> & "须核实"']
  }] };
const revision = project.revisions.find(item => item.status === 'accepted');
const boundaries = html => html.match(/<div class="pending-boundaries">([\s\S]*?)<\/div>/)?.[1] || '';

test('history exposes complete impact and unknowns as separate readable lists before the field comparisons', () => {
  const before = JSON.stringify(project);
  context.renderRevision(project);
  const html = elements.get('revision-records').innerHTML;
  const normal = boundaries(html);
  assert.ok(normal, 'impact and unknowns must have a normal reading area outside raw JSON');
  const sections = [...normal.matchAll(/<section><h5>(.*?)<\/h5><ul>([\s\S]*?)<\/ul><\/section>/g)];
  assert.deepEqual(sections.map(section => section[1]), ['受影响的环节', '仍然未知']);
  for (const [index, values] of [revision.impact, revision.unknowns].entries()) {
    assert.deepEqual([...sections[index][2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => match[1]), values.map(escape));
  }
  assert.ok(html.indexOf('class="pending-boundaries"') < html.indexOf('class="field-diffs"'));
  assert.match(html, /接受修改不代表.*已实测.*未知已解决/);
  assert.equal(JSON.stringify(project), before, 'rendering must not mutate saved data');
});

test('complete raw revision is retained in its own closed disclosure inside the history entry', () => {
  context.renderRevision(project);
  const html = elements.get('revision-records').innerHTML;
  const raw = html.match(/<details\b([^>]*)><summary>查看完整修订记录（原始 JSON）<\/summary><pre class="raw-record">([\s\S]*?)<\/pre><\/details>/);
  assert.ok(raw, 'opening the history comparison must not automatically expose raw JSON');
  assert.doesNotMatch(raw[1], /\bopen(?:\s|=|$)/);
  assert.match(raw[1], /data-key="history-raw-/);
  assert.equal(raw[2], escape(JSON.stringify(revision, null, 2)));
  assert.ok(html.includes('查看当时的修改与依据'));
  assert.equal((html.match(/<article class="field-diff">/g) || []).length, revision.changes.length);
});

test('empty or absent historical fields remain explicitly unrecorded, never resolved', () => {
  for (const fields of [{ impact: [], unknowns: [] }, { impact: undefined, unknowns: undefined }]) {
    context.renderRevision({ ...project, revisions: [{ ...revision, ...fields }] });
    const normal = boundaries(elements.get('revision-records').innerHTML);
    assert.match(normal, /受影响的环节<\/h5><ul><li>未说明<\/li>/);
    assert.match(normal, /仍然未知<\/h5><ul><li>未记录不代表已验证<\/li>/);
  }
});

test('pending, rejected and superseded records retain the same source lists and escaping', () => {
  for (const status of ['pending', 'rejected', 'superseded']) {
    const candidate = { ...project, revisions: [{ ...revision, status }] };
    context.renderRevision(candidate);
    const normal = boundaries(elements.get('revision-records').innerHTML);
    for (const value of [...revision.impact, ...revision.unknowns]) assert.ok(normal.includes(`<li>${escape(value)}</li>`));
    if (status === 'pending') assert.equal(boundaries(elements.get('pending-review').innerHTML), normal);
  }
});
