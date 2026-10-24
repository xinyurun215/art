import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function screen() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', dataset: {}, firstElementChild: {},
      classList: { add() {} }, setAttribute() {}, querySelector() { return get(`${id}-option`); } });
    return elements.get(id);
  };
  const context = { URL, history: { replaceState() {} }, localStorage: { setItem() {} }, window: { location: { href: 'http://127.0.0.1/' } },
    document: { getElementById: get, querySelectorAll: () => [], body: { classList: { add() {} }, setAttribute() {} } } };
  runInNewContext(source.replace("  $('load-demo').addEventListener", "  globalThis.ui = { state, renderProject, referenceMarkup, proposalMarkdown }; return;\n  $('load-demo').addEventListener"), context);
  context.ui.state.config = { production: false, modes: { live: { enabled: true, available: true } } };
  return { ...context.ui, get };
}
function project() {
  const link = { evidenceId: 'saved-card', entityId: 'external-entity', observedField: 'properties.description',
    observedValue: 'Actual saved description', observation: 'The saved description mentions a shared rhythm.',
    inspiration: 'Use that reference as a creative prompt for a shared task; its effect is unknown.' };
  return { id: 'project', version: 3, mode: 'live', selectedConceptId: 'a', status: { phase: 'ready' },
    brief: { request: '私人原文 stays intact', mustKeep: ['Try-on must remain'] }, lockedFields: ['productTouchpoints'],
    evidence: [{ id: 'saved-card', projectId: 'project', source: 'Qloo official workflow', synthetic: false,
      query: { workflow: 'describe' }, boundary: 'An association does not prove an effect.',
      returnedEntities: [{ entity_id: 'external-entity', name: '外部实体原名', properties: { description: 'Actual saved description' } }] }],
    concepts: ['a', 'b'].map(id => ({ id, title: `Concept ${id}`, coreClaim: `${id}: intended product understanding`,
      mechanism: { organization: id === 'a' ? 'collective_scheduled' : 'individual_self_paced', description: `${id}: proposed participation decision` },
      journey: [{ stage: 'Arrive', action: `${id}: arrival action` }, { stage: 'Participate', action: `${id}: visitor task` },
        { stage: 'Leave', action: `${id}: take away a note` }], productTouchpoints: [`${id}: hands-on try-on`, `${id}: compare product notes`],
      evidenceLinks: [structuredClone(link)], openQuestions: ['Capacity is unverified'], unverifiedEffects: ['Understanding and participation are unverified'] })),
    revisions: [], runtime: {}, messages: [], actions: [], questions: [] };
}
function ordered(text, headings) {
  let previous = -1;
  for (const heading of headings) { const index = text.indexOf(heading); assert(index > previous, `Expected reading order: ${heading}`); previous = index; }
}

test('concept cards and export lead from cultural evidence to judgment, visitor actions and intended product experience', () => {
  const page = screen(), value = project(), before = JSON.stringify(value);
  page.renderProject(value);
  const cards = page.get('concepts').innerHTML.split(/<article class="concept-card[^>]*>/).slice(1);
  assert.equal(cards.length, 2);
  const markdown = page.proposalMarkdown(value);
  for (const [index, card] of cards.entries()) {
    const main = card.split('<details class="concept-full"')[0], concept = value.concepts[index];
    ordered(main, ['Cultural evidence', 'Design decision · proposal judgment', 'What visitors do', 'Product experience']);
    assert(main.includes('href="#evidence-saved-card"')); assert(main.includes(concept.evidenceLinks[0].observation));
    assert(main.includes(concept.evidenceLinks[0].inspiration)); assert(main.includes(concept.mechanism.description));
    for (const step of concept.journey) assert(main.includes(step.action), 'visitor actions must be readable outside details');
    for (const contact of concept.productTouchpoints) assert(main.includes(contact));
    assert(main.indexOf(concept.coreClaim) > main.indexOf('Product experience'));
    const section = markdown.split(`## Concept ${String.fromCharCode(65 + index)}`)[1].split('## Concept ')[0];
    ordered(section, ['**Cultural evidence**', '**Design decision · proposal judgment**', '**What visitors do**', '**Product experience**']);
    assert(section.includes('[Evidence 1](#evidence-saved-card)'));
  }
  assert(markdown.includes('私人原文')); assert(markdown.includes('外部实体原名'));
  assert.equal(JSON.stringify(value), before);
  const descriptive = project();
  descriptive.concepts[0].mechanism.organization = 'Sequenced self-serve try-on circuit with an anonymous shared verdict board';
  descriptive.concepts[1].mechanism.organization = 'Private one-to-one try-on bench with a 15-minute maximum session and one safe walking stop';
  page.renderProject(descriptive);
  const labels = [...page.get('concepts').innerHTML.matchAll(/<span class="mechanism-label">([^<]*)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(labels, descriptive.concepts.map(concept => concept.mechanism.organization));
});

test('unlocatable or mismatched references remain unverified statements; Synthetic and numeric boundaries remain visible', () => {
  const page = screen();
  for (const change of [link => { link.evidenceId = 'missing'; }, link => { link.entityId = 'missing'; },
    link => { link.observedField = 'properties.missing'; }, link => { link.observedValue = 'Invented value'; }]) {
    const value = project(), link = value.concepts[0].evidenceLinks[0]; change(link);
    const fragment = page.referenceMarkup(value, link, 'test');
    assert.match(fragment, /Unverified proposal statement/); assert.doesNotMatch(fragment, /Data fact/);
    const exported = page.proposalMarkdown(value).split('## Concept A')[1].split('## Concept B')[0];
    assert.match(exported, /Unverified proposal statement/); assert.doesNotMatch(exported, /Data fact/);
  }
  const synthetic = project(); synthetic.mode = 'offline'; synthetic.evidence[0].synthetic = true;
  synthetic.evidence[0].boundary = 'Synthetic data: fictional entities, not live Qloo evidence.';
  page.renderProject(synthetic);
  const main = page.get('concepts').innerHTML.split('<details class="concept-full"')[0];
  assert.match(main, /Synthetic/); assert.match(main, /fictional entities, not live Qloo evidence/);
  const numeric = project(); numeric.evidence[0].returnedEntities[0].affinity = 0.4;
  Object.assign(numeric.concepts[0].evidenceLinks[0], { observedField: 'affinity', observedValue: 0.4, basis: 'affinity' });
  assert.match(page.referenceMarkup(numeric, numeric.concepts[0].evidenceLinks[0], 'numeric'), /numeric association.*does not prove/);
  assert.match(page.proposalMarkdown(numeric), /numeric association.*does not prove/);
});

test('exact string, object, array, falsey and null values remain facts while misleading observations stay proposal interpretations', () => {
  const page = screen();
  for (const observedValue of ['Exact  spacing\nand <external> text', { description: '<script>not executable</script>', values: [0, false, null] },
    ['First', 'Second', null], null, false, 0]) {
    const value = project(), link = value.concepts[0].evidenceLinks[0];
    value.evidence[0].returnedEntities[0].properties.actual = observedValue;
    Object.assign(link, { observedField: 'properties.actual', observedValue,
      observation: 'MISLEADING: Qloo proves this design will succeed.' });
    const before = JSON.stringify(value);
    for (const compact of [false, true]) {
      const html = page.referenceMarkup(value, link, 'exact', compact);
      const fact = html.match(/<div class="exact-evidence">([\s\S]*?)<\/div>/)?.[1] || '';
      assert(fact, 'the actual field value must be available separately from its proposal summary');
      assert(fact.includes('properties.actual')); assert(fact.includes('external-entity'));
      const exact = JSON.stringify(observedValue).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      assert(fact.includes(exact)); assert.doesNotMatch(fact, /MISLEADING/);
      assert.match(html, /Proposal summary \/ interpretation<\/span>MISLEADING/);
      assert.doesNotMatch(html, /<script>/);
    }
    const markdown = page.proposalMarkdown(value);
    assert(markdown.includes(`\n\`\`\`json\n${JSON.stringify(observedValue)}\n\`\`\``));
    assert.match(markdown, /Proposal summary \/ interpretation: MISLEADING/);
    assert.equal(JSON.stringify(value), before);
  }
});

test('pending and accepted exports include complete citation values and each change separate evidenceRefs', () => {
  const page = screen();
  for (const status of ['pending', 'accepted']) {
    const value = project(); value.evidence[0].returnedEntities[0].properties.extra = { exact: ['Value', null] };
    value.evidence[0].returnedEntities[0].properties.empty = null;
    const afterLink = { ...value.concepts[0].evidenceLinks[0], observedField: 'properties.extra', observedValue: { exact: ['Value', null] } };
    const independent = { ...afterLink, observedField: 'properties.empty', observedValue: null, inspiration: 'Separate change citation judgment' };
    value.revisions = [{ id: 'reviewed', projectId: value.id, status, targetConceptId: 'a', baseVersion: 3, confirmedVersion: 3,
      changes: [{ field: 'evidenceLinks', before: value.concepts[0].evidenceLinks, after: [afterLink], reason: 'Actual recorded reason', evidenceRefs: [independent] }],
      impact: [], unknowns: ['Effect remains unknown'] }];
    const markdown = page.proposalMarkdown(value);
    assert(markdown.includes('properties.extra')); assert(markdown.includes('{"exact":["Value",null]}'));
    assert.match(markdown, /Change evidence references/); assert(markdown.includes('properties.empty'));
    assert(markdown.includes('Separate change citation judgment'));
    assert(markdown.includes('\n```json\nnull\n```'));
    assert(markdown.includes('[Evidence 1](#evidence-saved-card)'));
    assert(markdown.includes('Actual recorded reason'));
  }
});

test('accepted changes show recorded after values and current requirements without masking later active or failed work', () => {
  const page = screen(), value = project();
  value.revisions = [{ id: 'accepted', projectId: value.id, targetConceptId: 'a', status: 'accepted', baseVersion: 2, confirmedVersion: 3,
    changes: [{ field: 'mechanism', before: { organization: 'pairs', description: 'Old paired task' },
      after: value.concepts[0].mechanism, reason: 'Client requested a different participation pattern', evidenceRefs: [] }],
    impact: ['Participation changed'], unknowns: ['Effect remains unverified'] }];
  page.renderProject(value);
  const feedback = page.get('revision-feedback').innerHTML;
  for (const text of ['What changed', value.concepts[0].mechanism.description, 'Still required', 'Try-on must remain', 'Current locks', 'Product contact'])
    assert(feedback.includes(text), text);
  assert.match(page.get('revision-records').innerHTML, /What changed/);
  assert.match(page.get('revision-records').innerHTML, /Old paired task/);
  assert.match(page.get('revision-records').innerHTML, /Client requested a different participation pattern/);
  const exported = page.proposalMarkdown(value);
  for (const text of ['What changed', 'Still required', 'Try-on must remain', 'Current locks']) assert(exported.includes(text));
  for (const phase of ['busy', 'error', 'needs_input']) {
    page.renderProject({ ...value, status: { phase, detail: 'The latest operation is unresolved' } });
    assert.doesNotMatch(page.get('revision-feedback').innerHTML, /Change accepted/);
    assert.doesNotMatch(page.get('project-status').innerHTML, /Change accepted/);
  }
  const pending = { ...value, status: { phase: 'revision_pending' }, revisions: [{ ...value.revisions[0], status: 'pending', baseVersion: 3 }] };
  page.renderProject(pending);
  const review = page.get('pending-review').innerHTML;
  for (const text of ['Old paired task', value.concepts[0].mechanism.description, 'Client requested a different participation pattern']) assert(review.includes(text));
  const pendingExport = page.proposalMarkdown(pending);
  for (const text of ['Old paired task', value.concepts[0].mechanism.description, 'Client requested a different participation pattern']) assert(pendingExport.includes(text));
});
