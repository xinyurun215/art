import { randomUUID } from 'node:crypto';
import { applyResolutionChoices, resolutionCandidates, resolutionInputContexts } from '@qloo/qloo-harness';

const normalize = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string' && uuid.test(left) && uuid.test(right)
  ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
const active = record => ['pending', 'needs_details'].includes(record.status);
export const pendingReference = project => project.referenceResolutions?.find(active);
const fail = (condition, code, message) => {
  if (!condition) throw Object.assign(new Error(message), { code, statusCode: 409, path: '/referenceResolution',
    feedback: { code, path: '/referenceResolution', reason: message, correctable: true } });
};
const sourceReference = (project, input) => {
  const value = normalize(input);
  const reference = project.brief.references.find(reference => normalize(reference).includes(value));
  const quoted = [...project.brief.request.matchAll(/(?:电影|音乐人|歌手|film|movie|artist)?\s*《([^》]+)》(?:\s*[（(][^）)]*[）)])?/gi)]
    .find(match => normalize(match[1]) === value);
  const escaped = String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const qualified = quoted?.[0].trim() ?? new RegExp(`(?:电影|音乐人|歌手|\\bfilm|\\bmovie|\\bartist)\\s*${escaped}(?=$|[\\s，,。；;、）)])`, 'i')
    .exec(project.brief.request)?.[0];
  return reference ? { field: 'references', sourceText: reference,
    text: qualified ? `${reference}；${qualified}` : reference }
    : qualified ? { field: 'request', text: qualified }
      : normalize(project.brief.request).includes(value) ? { field: 'request', text: input } : null;
};

function matchCandidate(original, input, candidates, nameResolved = false) {
  const title = /《([^》]+)》/.exec(original)?.[1] ?? input.split(/[,，;；]\s*(?:directed by|导演|作者|创作者|by)\s*/i)[0]
    .replace(/\([^)]*\)|（[^）]*）/g, '').replace(/^(?:电影|film|movie)\s*[:：]?\s*/i, '').trim();
  const year = original.match(/\b(?:18|19|20)\d{2}\b/g)?.filter((value, index, values) => values.indexOf(value) === index);
  const type = /电影|\b(?:film|movie)\b/i.test(original) ? 'movie'
    : /音乐人|歌手|\bartist\b/i.test(original) ? 'artist' : null;
  const creator = /(?:导演|作者|创作者|directed by|\bby)\s*[:：]?\s*([^,，;；()（）]+)/i.exec(original)?.[1]?.trim();
  const matching = candidates.filter(candidate => (nameResolved || normalize(candidate.name) === normalize(title))
    && (!type || normalize(candidate.type).split(':').at(-1) === type)
    && (!year || year.length === 1 && String(candidate.release_year ?? candidate.properties?.release_year) === year[0])
    && (!creator || normalize(JSON.stringify({ creator: candidate.creator, director: candidate.director, author: candidate.author,
      properties: candidate.properties, description: candidate.description })).includes(normalize(creator))));
  return { matching, selected: matching.length === 1 ? matching[0] : null, basis: { name: title, ...(type ? { type } : {}),
    ...(year?.length === 1 ? { release_year: year[0] } : {}), ...(creator ? { creator } : {}),
    source: 'Actual returned fields match the original reference. This is system resolution, not user confirmation.' } };
}

export function referenceQuestion(project) {
  const pending = pendingReference(project);
  if (!pending) return;
  project.questions = [{ id: pending.id, field: 'references', text: pending.status === 'pending'
    ? `More than one entity may match “${pending.originalInput}”. Choose the actual reference; none has been confirmed by the user.`
    : `“${pending.originalInput}” is unresolved. Add the title, type, year or creator.` }];
  project.status = { phase: 'needs_input', detail: project.questions[0].text };
}

// Only input cultural references are bound here; later returned recommendations
// are evidence, and do not each create a confirmation task.
export function observeReferenceResolution(project, operation, input, result) {
  const awaiting = project.referenceResolutions?.find(record => active(record) && record.awaitingLookup
    && record.projectId === project.id && record.baseVersion === project.version
    && operation === 'describe' && (input.entity === record.originalInput || record.originalInput.includes(input.entity)));
  if (result.status === 'ok' && awaiting) {
    const values = (result.results ?? []).map(entity => {
      const id = entity.id ?? entity.entity_id;
      const selected = result.resolution?.outcomes?.find(outcome => outcome.status === 'resolved' && sameId(outcome.selected?.id, id))?.selected;
      const interpreted = result.interpretation?.entity;
      const type = entity.type ?? selected?.type ?? (sameId(interpreted?.entityId, id) ? interpreted?.type : undefined);
      return { ...selected, ...entity, id, ...(type ? { type } : {}) };
    });
    const match = matchCandidate(awaiting.originalInput, input.entity, values);
    if (match.selected) Object.assign(awaiting, { status: 'system_resolved', selectedId: match.selected.id,
      selected: structuredClone(match.selected), candidates: structuredClone(values), basis: match.basis, awaitingLookup: false });
    referenceQuestion(project);
  }
  // A successful first description also supplies a binding for tools already
  // planned in the same model response. Trust the official name resolution;
  // check user qualifiers, not a second exact-name gate or a guessed first hit.
  if (result.status === 'ok' && operation === 'describe' && !awaiting && !pendingReference(project)
    && typeof input.entity === 'string' && !uuid.test(input.entity)) {
    const source = sourceReference(project, input.entity);
    const outcomes = (result.resolution?.outcomes ?? []).filter(outcome => outcome.input === input.entity);
    const outcome = outcomes.length === 1 ? outcomes[0] : undefined;
    const selected = outcome?.status === 'resolved' ? outcome.selected : undefined;
    if (source && selected?.type && uuid.test(selected.id)
      && (result.results ?? []).some(entity => sameId(entity.id ?? entity.entity_id, selected.id))) {
      const match = matchCandidate(source.text, input.entity, [selected], true);
      // A model-supplied type filter alone does not establish the user's intent.
      if (match.selected && (!input.type || match.basis.type)) {
        (project.referenceResolutions ??= []).push({ id: randomUUID(), projectId: project.id, baseVersion: project.version,
          input: input.entity, originalInput: source.text, sourceText: source.sourceText ?? source.text, sourceField: source.field,
          operation, toolInput: structuredClone(input), field: 'entity', candidates: [structuredClone(selected)],
          status: 'system_resolved', selectedId: selected.id, selected: structuredClone(selected),
          basis: { ...match.basis, source: 'The official description resolved the name and returned the same entity, matching the original qualifiers. This is system resolution, not user confirmation.' },
          createdAt: new Date().toISOString(), confirmed: false, ...(project.mode === 'offline' ? { synthetic: true } : {}) });
      }
    }
  }
  if (result.status !== 'needs_input') return;
  const tool = `qloo_${operation}`;
  const official = resolutionCandidates(result, tool, input);
  const choices = [];
  for (const issue of result.resolution?.issues ?? []) {
    const source = typeof issue.input === 'string' && sourceReference(project, issue.input);
    if (!source) continue;
    const context = resolutionInputContexts(tool, input).find(context => context.inputKind === 'entity'
      && (!issue.field || issue.field === context.field)
      && (input[context.field] === issue.input || input[context.field]?.includes?.(issue.input)));
    if (!context) continue;
    const candidates = (official.find(candidate => candidate.input === issue.input && candidate.field === context.field)?.candidates ?? [])
      .filter((candidate, index, values) => values.findIndex(other => sameId(other.id, candidate.id)) === index);
    const prior = project.referenceResolutions?.find(record => record.projectId === project.id
      && record.input === issue.input && record.field === context.field && record.baseVersion === project.version && active(record));
    if (prior && !prior.awaitingLookup) continue;
    const match = matchCandidate(source.text, issue.input, candidates);
    const record = { id: randomUUID(), projectId: project.id, baseVersion: project.version, input: issue.input,
      originalInput: source.text, sourceText: source.sourceText ?? source.text, sourceField: source.field,
      operation, toolInput: structuredClone(input), field: context.field,
      candidates: structuredClone(match.matching), returnedCandidates: structuredClone(candidates),
      status: match.selected ? 'system_resolved' : match.matching.length ? 'pending' : 'needs_details',
      createdAt: new Date().toISOString(), confirmed: false, ...(project.mode === 'offline' ? { synthetic: true } : {}) };
    if (match.selected) Object.assign(record, { selectedId: match.selected.id, selected: structuredClone(match.selected), basis: match.basis });
    if (awaiting) awaiting.status = 'superseded';
    (project.referenceResolutions ??= []).push(record);
    if (match.selected) choices.push({ input: issue.input, field: context.field, selectedId: match.selected.id });
  }
  referenceQuestion(project);
  return choices.length ? applyResolutionChoices(tool, input, choices) : undefined;
}

export function bindReferenceInputs(project, operation, input) {
  const records = (project.referenceResolutions ?? []).filter(record => record.projectId === project.id
    && ['system_resolved', 'user_confirmed'].includes(record.status));
  const fields = resolutionInputContexts(`qloo_${operation}`, input).filter(context => context.inputKind === 'entity');
  for (const field of fields) for (const value of Array.isArray(input[field.field]) ? input[field.field] : [input[field.field]]) {
    for (const record of records) fail(!(record.returnedCandidates ?? record.candidates).some(candidate => sameId(candidate.id, value) && !sameId(candidate.id, record.selectedId)),
      'REFERENCE_CHOICE_MISMATCH', 'This input uses an unselected ambiguous candidate. Use the currently resolved entity.');
  }
  const choices = records.flatMap(record => [record.input, record.originalInput].map(value => ({
    input: value, selectedId: record.selectedId, inputKind: 'entity' })));
  return applyResolutionChoices(`qloo_${operation}`, input, choices) ?? input;
}

export function requireResolvedReferences(project) {
  fail(!pendingReference(project), 'REFERENCE_CONFIRMATION_REQUIRED', 'The input cultural reference is unresolved. Choose a candidate on the page or add detail first.');
}

export function respondToReference(project, input) {
  const record = pendingReference(project);
  fail(record && record.projectId === project.id && input?.resolutionId === record.id
    && input.baseVersion === project.version && record.baseVersion === project.version,
  'STALE_REFERENCE_RESOLUTION', 'This entity choice is stale or belongs to another project. Refresh before retrying.');
  fail(Object.keys(input).every(key => ['resolutionId', 'baseVersion', 'action', 'selectedId', 'text'].includes(key)),
    'REFERENCE_SELECTION_INVALID', 'Invalid entity selection arguments.');
  if (input.action === 'confirm') {
    const selected = record.status === 'pending' && record.candidates.find(candidate => sameId(candidate.id, input.selectedId));
    fail(selected, 'REFERENCE_SELECTION_INVALID', 'The selection is not among the current candidates. No entity was confirmed.');
    Object.assign(record, { status: 'user_confirmed', confirmed: true, selectedId: selected.id, selected: structuredClone(selected),
      confirmedAt: new Date().toISOString(), basis: { source: 'The user selected a current candidate on this project page, and the server validated the choice.' } });
    project.questions = [];
    referenceQuestion(project);
    return `The user selected cultural reference “${record.originalInput}”: ${selected.name} (${selected.id}). Continue the original research using this confirmed ID.`;
  }
  if (input.action === 'cancel') {
    Object.assign(record, { status: 'needs_details', candidates: [], cancelledAt: new Date().toISOString() });
    referenceQuestion(project);
    return;
  }
  fail(input.action === 'clarify' && typeof input.text === 'string' && input.text.trim(),
    'REFERENCE_SELECTION_INVALID', 'Explicitly choose a current candidate or add new reference details. No entity was confirmed.');
  const text = input.text.trim();
  const referenceText = /《[^》]+》/.test(text) ? text : `${record.originalInput}；${text}`;
  if (record.sourceField === 'references') {
    const index = project.brief.references.indexOf(record.sourceText ?? record.originalInput);
    fail(index >= 0, 'STALE_REFERENCE_RESOLUTION', 'The original reference has changed. Refresh before retrying.');
    project.brief.references[index] = referenceText;
  } else project.brief.references.push(referenceText);
  record.status = 'superseded';
  record.supplement = text;
  const returnedCandidates = record.returnedCandidates ?? record.candidates;
  const match = matchCandidate(referenceText, record.input, returnedCandidates);
  const resolved = { ...structuredClone(record), id: randomUUID(), originalInput: referenceText, sourceText: referenceText,
    sourceField: 'references', status: match.selected ? 'system_resolved' : match.matching.length ? 'pending' : 'needs_details',
    candidates: structuredClone(match.matching), returnedCandidates: structuredClone(returnedCandidates),
    awaitingLookup: !match.selected, confirmed: false, createdAt: new Date().toISOString() };
  if (match.selected) Object.assign(resolved, { selectedId: match.selected.id, selected: structuredClone(match.selected), basis: match.basis });
  (project.referenceResolutions ??= []).push(resolved);
  referenceQuestion(project);
  return `The user added cultural reference details: ${referenceText}. ${match.selected ? `The actual candidates uniquely match ${match.selected.id}. Continue with system resolution; this is not a user confirmation.` : 'Recheck the identity; no candidate has been confirmed.'}`;
}

export function referenceResolutionView(project) {
  const records = project.referenceResolutions ?? [];
  return { records: records.slice(-12).map(({ id, input, originalInput, status, selectedId, selected, basis, confirmed, synthetic }) => ({
    id, input, originalInput, status, selectedId, ...(selected ? { selected: { id: selected.id, name: selected.name, type: selected.type } } : {}),
    basis, confirmed, ...(synthetic ? { synthetic } : {}) })), ...(records.length > 12 ? { omittedCount: records.length - 12 } : {}),
    unresolvedCount: records.filter(active).length };
}
