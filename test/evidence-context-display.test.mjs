import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function screen() {
  const elements = new Map(); let requests = 0;
  const context = { document: { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  } }, fetch() { requests++; assert.fail('evidence display cannot send a request'); } };
  runInNewContext(source.replace("  $('load-demo').addEventListener", "  globalThis.ui = { renderEvidence, proposalMarkdown }; return;\n  $('load-demo').addEventListener"), context);
  return { ...context.ui, elements, get requests() { return requests; } };
}
function project(card = {}) {
  return { id: 'display-project', version: 1, mode: 'live', brief: { request: 'English brief', venue: 'Brief venue must not imply a filter' },
    evidence: [{ id: 'card', source: 'Qloo official workflow', synthetic: false, inputReferences: [], returnedEntities: [],
      query: { workflow: 'recommend', input: { signals: ['confirmed-id'], target_type: 'artist', limit: 2 }, designQuestion: 'How should people participate?' },
      queriedAt: '2026-10-24T02:00:00.000Z', requestRef: 'safe-reference-123',
      boundary: 'Cultural association is not proof of effects.', ...card }] };
}
function outputs(value) {
  const page = screen(), before = JSON.stringify(value);
  page.renderEvidence(value);
  const html = page.elements.get('evidence').innerHTML, markdown = page.proposalMarkdown(value);
  assert.equal(JSON.stringify(value), before, 'display and export cannot rewrite the saved record');
  assert.equal(page.requests, 0);
  return { html, markdown };
}
function row(output, label, expected) {
  const safe = expected.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  assert(output.html.includes(`<dt>${label}</dt><dd>${safe}</dd>`), `${label} must be visible in the card details: ${expected}`);
  assert(output.markdown.includes(`- ${label}: ${expected}`), `${label} must match in the actual export: ${expected}`);
}

test('actual nonempty geographic filters and safe saved query context match in evidence details and export', () => {
  const value = project({ context: { venue: 'Unverified Shanghai room', geographicFilter: 'Shanghai, CN',
    referenceStatus: 'Client research signal; entity identity not verified' } });
  value.evidence[0].query.input.filter_location = 'Shanghai, CN';
  value.evidence[0].query.input.include_tags = ['urn:tag:synthetic'];
  const output = outputs(value);
  row(output, 'Workflow / operation', 'recommend'); row(output, 'Safe request reference', 'safe-reference-123');
  row(output, 'Query time', '2026-10-24T02:00:00.000Z'); row(output, 'Venue', 'Unverified Shanghai room');
  row(output, 'Geographic filter', 'Applied: Shanghai, CN');
  row(output, 'Reference / resolution status', 'Client research signal; entity identity not verified');
  for (const text of ['confirmed-id', 'target_type', 'artist', 'limit', 'filter_location', 'include_tags', 'urn:tag:synthetic']) {
    assert(output.html.includes(text)); assert(output.markdown.includes(text));
  }
});

test('explicit current and legacy not-applied records show Not applied without inferring from venue', () => {
  for (const geographicFilter of ['Not applied; venue text is not an applied geographic filter', '未应用；场地文字不等于适用地理筛选']) {
    const output = outputs(project({ context: { venue: 'Shanghai venue', geographicFilter, referenceStatus: 'Synthetic sample; not resolved' } }));
    row(output, 'Geographic filter', 'Not applied');
    row(output, 'Venue', 'Shanghai venue');
    assert.doesNotMatch(output.html + output.markdown, /Applied: Shanghai/);
  }
});

test('missing or unclear query context stays Unknown; arbitrary raw data and credentials are excluded', () => {
  for (const context of [undefined, { venue: {}, geographicFilter: {}, referenceStatus: null }]) {
    const value = project({ context, requestRef: 'https://provider.invalid/?api_key=PRIVATE_REQUEST_KEY',
      rawResult: { token: 'PRIVATE_RAW_RESULT' } });
    value.evidence[0].query.input = { entity: '外部实体原名', type: 'movie', authorization: 'PRIVATE_AUTHORIZATION',
      api_key: 'PRIVATE_INPUT_KEY', rawResult: { secret: 'PRIVATE_NESTED_RAW' } };
    const output = outputs(value);
    for (const label of ['Venue', 'Geographic filter', 'Reference / resolution status', 'Safe request reference']) row(output, label, 'Unknown');
    for (const secret of ['PRIVATE_REQUEST_KEY', 'PRIVATE_RAW_RESULT', 'PRIVATE_AUTHORIZATION', 'PRIVATE_INPUT_KEY', 'PRIVATE_NESTED_RAW'])
      assert.equal((output.html + output.markdown).includes(secret), false);
    assert(output.html.includes('外部实体原名')); assert(output.markdown.includes('外部实体原名'));
  }
  const missing = outputs(project({ query: {}, queriedAt: null, requestRef: null }));
  for (const label of ['Workflow / operation', 'Query time', 'Query input']) row(missing, label, 'Unknown');
});
