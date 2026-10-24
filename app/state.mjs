import { createHash, randomUUID } from 'node:crypto';
import { requireResolvedReferences } from './references.mjs';

export const LIMITS = Object.freeze({ modelHttpAttempts: 6, qlooHttpAttempts: 6 });
export const SERVER_LIMITS = Object.freeze({ modelHttpAttempts: 12, qlooHttpAttempts: 12 });
export const list = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,，;；]/) : []).map(String).map(s => s.trim()).filter(Boolean);
const text = value => typeof value === 'string' ? value.trim() : '';

export function createProject({ brief = {}, mode = 'offline', scenario = 'sufficient' } = {}) {
  if (!['offline', 'live'].includes(mode)) throw new Error('Unsupported run mode');
  if (!['sufficient', 'failure', 'irrelevant'].includes(scenario)) throw new Error('Unsupported offline scenario');
  if (!text(brief.request)) throw new Error('Describe the project brief first');
  return {
    id: randomUUID(), version: 1, mode, scenario,
    brief: { request: brief.request, brand: text(brief.brand), goal: text(brief.goal),
      references: list(brief.references), venue: text(brief.venue), budget: text(brief.budget),
      mustKeep: list(brief.mustKeep), avoid: list(brief.avoid) },
    messages: [{ role: 'user', text: brief.request }], actions: [], questions: [], clarifications: [], evidence: [], concepts: [],
    selectedConceptId: null, revisions: [], versionHistory: [], revisionRequest: null,
    status: { phase: 'busy', detail: 'Starting the official agent session' },
    usage: { modelCalls: 0, modelHttpAttempts: 0, qlooHttpAttempts: 0, toolCalls: 0 },
    runtime: { sessionId: null, toolNames: [], modelResultReads: 0 },
  };
}

export function action(project, type, label, detail, status = 'done') {
  const record = { id: randomUUID(), type, label, detail, status, time: new Date().toISOString() };
  project.actions.push(record);
  return record;
}

export function answerClarification(project, input) {
  const question = project.questions[0], binding = input.clarification;
  revisionEnsure(exactKeys(input, ['text', 'clarification', 'briefUpdate']) && nonempty(input.text)
    && exactKeys(binding, ['questionId', 'baseVersion', 'reviseRequest'])
    && (binding.reviseRequest === undefined || typeof binding.reviseRequest === 'boolean'),
  'The answer must reference the current question and project version', '/clarification', 'CLARIFICATION_INVALID');
  revisionEnsure(project.status.phase === 'needs_input' && project.questions.length === 1
    && binding.questionId === question?.id && binding.baseVersion === project.version,
  'The question or base version is stale. Refresh and answer the current question', '/clarification', 'STALE_PROJECT_VERSION');
  revisionEnsure(!binding.reviseRequest || question.field === 'request', 'Only an original-request question can explicitly amend the original request', '/clarification');
  const field = input.briefUpdate?.field ?? question.field, before = project.brief[field];
  const arrayField = ['references', 'mustKeep', 'avoid'].includes(field);
  let update;
  if (input.briefUpdate !== undefined) {
    const value = input.briefUpdate;
    revisionEnsure(exactKeys(value, ['field', 'value']) && (question.field === 'request'
      ? binding.reviseRequest === true && ['venue', 'budget', 'mustKeep', 'avoid'].includes(field) : field === question.field) && field !== 'request'
      && (arrayField ? Array.isArray(value.value) && value.value.every(nonempty) : typeof value.value === 'string'),
    'An explicit update needs the complete valid value for the current question field; it cannot overwrite the original request', '/briefUpdate', 'CLARIFICATION_INVALID');
    update = { field, before: structuredClone(before), after: arrayField ? list(value.value) : value.value.trim(), explicit: true };
  } else if (field !== 'request' && (arrayField ? before.length === 0 : !before)) {
    update = { field, before: structuredClone(before), after: arrayField ? list(input.text) : input.text.trim(), explicit: false };
  }
  const record = { questionId: question.id, baseVersion: project.version, answeredVersion: project.version + 1,
    field: question.field, question: question.text, answer: input.text,
    ...(binding.reviseRequest ? { revisesRequest: true } : {}), ...(update ? { briefUpdate: update } : {}) };
  if (update) project.brief[field] = structuredClone(update.after);
  (project.clarifications ??= []).push(record);
  project.questions = [];
  project.version++;
  return record;
}

function ensure(condition, message, path = '/', code = 'PROPOSAL_INVALID') {
  if (!condition) throw Object.assign(new Error(message), { feedback: { code, path, reason: message, correctable: true } });
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }

function checkForbiddenItems(concept, avoid, pathFor, check) {
  const fields = [['coreClaim', concept.coreClaim], ['mechanism/description', concept.mechanism.description],
    ...concept.journey.map((step, index) => [`journey/${index}/action`, step.action]),
    ...concept.productTouchpoints.map((value, index) => [`productTouchpoints/${index}`, value])];
  for (const [index, forbidden] of avoid.entries()) for (const [field, value] of fields) {
    // ponytail: only whole-field exclusions are recognized; compound/ambiguous prose stays blocked pending clarification.
    const statement = value.trim().replace(/[。.]$/, '');
    const excluded = ['不', '不安排', '禁止'].some(prefix => statement === prefix + forbidden);
    check(!value.includes(forbidden) || excluded,
      `The concept text contains an excluded item /brief/avoid/${index} (${JSON.stringify(forbidden)})`, pathFor(field), 'FORBIDDEN_ITEM_PRESENT');
  }
}

// This checks structure and literal constraints, not originality or design quality.
export function validateProposal(project, proposal) {
  requireResolvedReferences(project);
  ensure(proposal.projectId === project.id, 'Project mismatch: writes across projects are forbidden', '/projectId', 'PROJECT_MISMATCH');
  ensure(proposal.baseVersion === project.version, 'The base version is stale. Propose against the current project', '/baseVersion', 'STALE_PROJECT_VERSION');
  ensure(['needs_input', 'ready', 'insufficient_evidence'].includes(proposal.phase), 'Invalid proposal phase', '/phase');
  ensure(nonempty(proposal.summary), 'The proposal needs a summary', '/summary');
  const questions = proposal.questions === undefined && proposal.phase !== 'needs_input' ? [] : proposal.questions;
  ensure(Array.isArray(questions), 'Questions must be an array', '/questions');
  for (const [index, q] of questions.entries()) {
    ensure(q !== null && typeof q === 'object' && !Array.isArray(q) && Object.keys(q).every(key => ['field', 'text'].includes(key)),
      'Each question must contain only field and text', `/questions/${index}`);
    ensure(typeof q.field === 'string' && Object.hasOwn(project.brief, q.field), 'The question field must belong to the current brief', `/questions/${index}/field`);
    ensure(nonempty(q.text), 'Question text cannot be empty', `/questions/${index}/text`);
  }
  ensure(Array.isArray(proposal.concepts), 'Concepts must be an array', '/concepts');
  if (proposal.phase === 'needs_input') {
    ensure(questions.length === 1 && proposal.concepts.length === 0, 'A clarification must contain exactly one question', '/questions');
    return;
  }
  ensure(proposal.concepts.length === 2 || (proposal.phase === 'insufficient_evidence' && proposal.concepts.length === 0), 'Propose two concepts, or explicitly pause for insufficient evidence', '/concepts');
  if (!proposal.concepts.length) return;
  ensure(new Set(proposal.concepts.map(c => c.id)).size === 2, 'Concept identifiers must be distinct', '/concepts');
  const organizations = new Set(), mechanisms = new Set();
  for (const [index, concept] of proposal.concepts.entries()) {
    const path = `/concepts/${index}`;
    for (const key of ['id', 'title', 'coreClaim']) ensure(nonempty(concept[key]), `The concept is missing ${key}`, `${path}/${key}`);
    ensure(nonempty(concept.mechanism?.organization), 'Invalid participation organization', `${path}/mechanism/organization`);
    ensure(nonempty(concept.mechanism.description), 'The concept needs a participation mechanism description', `${path}/mechanism/description`);
    organizations.add(concept.mechanism.organization);
    ensure(Array.isArray(concept.journey) && concept.journey.length >= 3 && concept.journey.every(s => nonempty(s.stage) && nonempty(s.action)), 'The concept needs a readable experience journey', `${path}/journey`);
    for (const key of ['productTouchpoints', 'openQuestions', 'unverifiedEffects'])
      ensure(Array.isArray(concept[key]) && concept[key].every(nonempty), `Invalid concept ${key} format`, `${path}/${key}`);
    ensure(concept.productTouchpoints.length > 0, 'The concept must include product contact', `${path}/productTouchpoints`);
    mechanisms.add(JSON.stringify([concept.mechanism.description,
      concept.journey.map(step => [step.stage, step.action]), concept.productTouchpoints]));
    ensure(concept.unverifiedEffects.length > 0, 'Unverified effects must be marked', `${path}/unverifiedEffects`);
    const contact = concept.productTouchpoints.join(' ');
    const active = [concept.coreClaim, concept.mechanism.description, ...concept.journey.map(s => s.action), contact].join(' ');
    for (const required of project.brief.mustKeep) ensure(active.includes(required), 'The concept must preserve the brief\'s must-keep items', path, 'REQUIRED_ITEM_MISSING');
    checkForbiddenItems(concept, project.brief.avoid, field => `${path}/${field}`, ensure);
    ensure(Array.isArray(concept.evidenceLinks), 'Invalid evidence reference format', `${path}/evidenceLinks`);
    for (const [linkIndex, link] of concept.evidenceLinks.entries()) {
      const linkPath = `${path}/evidenceLinks/${linkIndex}`;
      const evidence = project.evidence.find(e => e.id === link.evidenceId);
      ensure(evidence && evidence.projectId === project.id, 'Unknown evidence or a reference across projects', `${linkPath}/evidenceId`, 'EVIDENCE_REFERENCE_INVALID');
      ensure(evidence.relevant !== false, 'Irrelevant results cannot support a design claim', `${linkPath}/evidenceId`, 'EVIDENCE_IRRELEVANT');
      ensure(nonempty(link.observation) && nonempty(link.inspiration), 'Separate returned facts from design inference', linkPath);
      const entity = evidence.returnedEntities.find(e => (e.id ?? e.entity_id) === link.entityId);
      ensure(entity && nonempty(link.observedField), 'The evidence reference needs an actually returned entity and field', `${linkPath}/entityId`, 'EVIDENCE_ENTITY_INVALID');
      const parts = link.observedField.split('.');
      let actual = entity;
      for (const part of parts) {
        ensure(actual && typeof actual === 'object' && Object.hasOwn(actual, part), 'The referenced returned field does not exist', `${linkPath}/observedField`, 'EVIDENCE_FIELD_MISSING');
        actual = actual[part];
      }
      ensure(JSON.stringify(actual) === JSON.stringify(link.observedValue), 'The referenced value does not match the actual returned field', `${linkPath}/observedValue`, 'EVIDENCE_VALUE_MISMATCH');
    }
    if (proposal.phase === 'ready') ensure(concept.evidenceLinks.length > 0, 'Insufficient evidence cannot complete research. Add exact citations or submit an insufficient_evidence draft or pause', `${path}/evidenceLinks`, 'EVIDENCE_INSUFFICIENT');
  }
  ensure(organizations.size === 2 && mechanisms.size === 2, 'The two concepts must have distinct participation mechanisms beyond their labels', '/concepts', 'MECHANISMS_NOT_DISTINCT');
}

export function applyProposal(project, proposal) {
  validateProposal(project, proposal);
  if (project.concepts.length) {
    ensure(project.revisionRequest?.status !== 'running', 'The full proposal tool cannot be used during a partial revision', '/concepts', 'LOCAL_REVISION_REQUIRED');
    ensure(JSON.stringify(proposal.concepts) === JSON.stringify(project.concepts),
      'Confirmed concepts can only be updated through a pending partial revision', '/concepts', 'LOCAL_REVISION_REQUIRED');
    project.questions = (proposal.questions ?? []).map(q => ({ id: randomUUID(), field: q.field, text: q.text }));
    project.status = { phase: proposal.phase, detail: proposal.summary };
    return { accepted: true, unchanged: true, projectId: project.id, version: project.version, phase: project.status.phase,
      conceptIds: project.concepts.map(concept => concept.id), synthetic: project.mode === 'offline' };
  }
  project.concepts = structuredClone(proposal.concepts);
  project.questions = (proposal.questions ?? []).map(q => ({ id: randomUUID(), field: q.field, text: q.text }));
  project.status = { phase: proposal.phase, detail: proposal.summary };
  project.version++;
  return { accepted: true, projectId: project.id, version: project.version, phase: project.status.phase,
    conceptIds: project.concepts.map(c => c.id), synthetic: project.mode === 'offline' };
}

export const REVISION_FIELDS = Object.freeze(['title', 'coreClaim', 'mechanism', 'journey',
  'productTouchpoints', 'evidenceLinks', 'openQuestions', 'unverifiedEffects']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exactKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const stringArray = value => Array.isArray(value) && value.every(nonempty);
function revisionEnsure(condition, message, path = '/', code = 'REVISION_INVALID') {
  if (!condition) throw Object.assign(new Error(message), { statusCode: ['STALE_PROJECT_VERSION', 'PENDING_REVISION_EXISTS',
    'REVISION_IN_PROGRESS', 'PENDING_SELECTION_LOCKED', 'STALE_PENDING_REVISION'].includes(code) ? 409 : 400,
    code, path, feedback: { code, path, reason: message, correctable: true } });
}
function binding(project, { conceptId, baseVersion }) {
  revisionEnsure(baseVersion === project.version, 'The base version is stale. Use the current confirmed version', '/baseVersion', 'STALE_PROJECT_VERSION');
  revisionEnsure(project.concepts.some(concept => concept.id === conceptId), 'The target concept does not exist', '/conceptId', 'TARGET_NOT_FOUND');
  revisionEnsure(project.selectedConceptId === conceptId, 'The target does not match the selected concept', '/conceptId', 'TARGET_MISMATCH');
}
function rememberVersion(project, revisionId = null) {
  project.versionHistory ??= [];
  if (!project.versionHistory.some(record => record.version === project.version)) project.versionHistory.push({
    version: project.version, concepts: structuredClone(project.concepts), selectedConceptId: project.selectedConceptId,
    revisionId, confirmedAt: new Date().toISOString() });
}
export function selectConcept(project, input) {
  revisionEnsure(exactKeys(input, ['conceptId', 'baseVersion']), 'Selection cannot specify another project or overwrite state');
  revisionEnsure(input.baseVersion === project.version, 'The base version is stale. Refresh the confirmed version', '/baseVersion', 'STALE_PROJECT_VERSION');
  revisionEnsure(project.concepts.some(concept => concept.id === input.conceptId), 'The target concept does not exist', '/conceptId', 'TARGET_NOT_FOUND');
  revisionEnsure(project.selectedConceptId === input.conceptId || !project.revisions?.some(record => record.status === 'pending'),
    'Accept or reject the pending revision before switching concepts', '/conceptId', 'PENDING_SELECTION_LOCKED');
  revisionEnsure(project.selectedConceptId === input.conceptId || !project.lockedFields?.length,
    'The selected concept has locked content. Explicitly unlock it before switching', '/conceptId', 'PENDING_SELECTION_LOCKED');
  project.selectedConceptId = input.conceptId;
  project.revisions ??= [];
  rememberVersion(project);
  return project;
}
// Locks bind fields of the selected concept. Unlocking only permits later proposals; it approves nothing.
export function setFieldLock(project, input) {
  revisionEnsure(exactKeys(input, ['baseVersion', 'field', 'locked']) && typeof input.locked === 'boolean',
    'A lock operation may specify only the confirmed version, field and lock state');
  revisionEnsure(input.baseVersion === project.version, 'The base version is stale. Refresh the confirmed version', '/baseVersion', 'STALE_PROJECT_VERSION');
  revisionEnsure(project.selectedConceptId, 'Select a concept before locking confirmed content', '/field');
  revisionEnsure(REVISION_FIELDS.includes(input.field), 'This field cannot be locked', '/field');
  revisionEnsure(project.revisionRequest?.status !== 'running', 'The revision is still running; its locks cannot change', '/', 'REVISION_IN_PROGRESS');
  const locked = new Set(project.lockedFields ?? []);
  if (locked.has(input.field) === input.locked) return project;
  if (input.locked) locked.add(input.field); else locked.delete(input.field);
  project.lockedFields = REVISION_FIELDS.filter(field => locked.has(field));
  const name = { title: 'Concept title', coreClaim: 'Core claim', mechanism: 'Participation mechanism', journey: 'Experience journey', productTouchpoints: 'Product contact',
    evidenceLinks: 'Cultural evidence and design inference', openQuestions: 'Open questions', unverifiedEffects: 'Unverified effects' }[input.field];
  action(project, 'lock', input.locked ? `Lock ${name}` : `Unlock ${name}`,
    input.locked ? 'Neither a proposed nor an accepted revision may change this field.' : 'Unlocking permits a later proposal; it does not approve a change.');
  return project;
}
export function beginRevision(project, input) {
  revisionEnsure(exactKeys(input, ['conceptId', 'baseVersion', 'text', 'offlineFixture']), 'A partial revision may specify only this project\'s target, version, text and explicit offline fixture');
  revisionEnsure(project.revisionRequest?.status !== 'running', 'The current revision is still running and cannot be replaced', '/', 'REVISION_IN_PROGRESS');
  revisionEnsure(!project.revisions?.some(record => record.status === 'pending'),
    'Accept or reject the pending revision before submitting another request', '/', 'PENDING_REVISION_EXISTS');
  binding(project, input);
  revisionEnsure(nonempty(input.text), 'Describe the requested change', '/text');
  revisionEnsure(!input.offlineFixture || project.mode === 'offline' && ['pair_45', 'needs_input', 'conflict', 'invalid_reference'].includes(input.offlineFixture),
    'An explicit revision fixture is available only in offline tests', '/offlineFixture');
  project.revisions ??= [];
  rememberVersion(project);
  const previous = project.revisionRequest;
  project.revisionRequest = { id: randomUUID(), targetConceptId: input.conceptId, baseVersion: input.baseVersion,
    text: input.text.trim(), status: 'running', createdAt: new Date().toISOString(),
    ...(input.offlineFixture ? { offlineFixture: input.offlineFixture, synthetic: true } : {}),
    ...(previous && ['needs_input', 'conflict'].includes(previous.status) && previous.targetConceptId === input.conceptId
      && previous.baseVersion === input.baseVersion ? { priorRequest: structuredClone(previous) } : {}) };
  return project.revisionRequest;
}
export function pendingRevisionDraft(project, revision) {
  const target = project.concepts.find(concept => concept.id === revision.targetConceptId);
  revisionEnsure(target, 'The pending revision\'s target concept does not exist', '/revisionId', 'TARGET_NOT_FOUND');
  return { ...structuredClone(target), ...Object.fromEntries(revision.changes.map(change => [change.field, structuredClone(change.after)])) };
}
export function revisionFingerprint(revision) {
  const { id, projectId, targetConceptId, baseVersion, request, summary, changes, impact, unknowns, createdAt,
    parentRevisionId, revisionNumber } = revision;
  return createHash('sha256').update(JSON.stringify({ id, projectId, targetConceptId, baseVersion, request, summary,
    changes, impact, unknowns, createdAt, parentRevisionId, revisionNumber })).digest('hex');
}
const numberOfRevision = (project, revision) => revision.revisionNumber ?? project.revisions.indexOf(revision) + 1;
function checkedFeedbackSource(project, request) {
  const source = project.revisions?.find(record => record.id === request.sourceRevisionId && record.projectId === project.id);
  revisionEnsure(source?.status === 'pending' && numberOfRevision(project, source) === request.sourceRevisionNumber
    && revisionFingerprint(source) === request.sourceFingerprint,
  'The pending draft has changed or expired. Refresh and retry against the current draft', '/revisionId', 'STALE_PENDING_REVISION');
  binding(project, { conceptId: source.targetConceptId, baseVersion: request.baseVersion });
  revisionEnsure(source.baseVersion === project.version, 'The pending revision\'s base version is stale', '/baseVersion', 'STALE_PROJECT_VERSION');
  const target = project.concepts.find(concept => concept.id === source.targetConceptId);
  revisionEnsure(source.changes.every(change => REVISION_FIELDS.includes(change.field) && same(target[change.field], change.before)),
    'Confirmed content has changed. The old pending draft cannot be the feedback basis', '/changes', 'STALE_PROJECT_VERSION');
  return source;
}
export function beginPendingFeedback(project, revisionId, input) {
  revisionEnsure(exactKeys(input, ['baseVersion', 'text']), 'Pending feedback may specify only the confirmed version and feedback text');
  revisionEnsure(project.revisionRequest?.status !== 'running', 'The current revision is still running and cannot be replaced', '/', 'REVISION_IN_PROGRESS');
  revisionEnsure(nonempty(input.text), 'Enter feedback on the pending draft', '/text');
  const source = project.revisions?.find(record => record.id === revisionId && record.projectId === project.id);
  revisionEnsure(source?.status === 'pending', 'The pending draft for this feedback has changed or expired', '/revisionId', 'STALE_PENDING_REVISION');
  const previous = project.revisionRequest;
  const request = { id: randomUUID(), kind: 'pending_feedback', targetConceptId: source.targetConceptId,
    baseVersion: input.baseVersion, text: input.text.trim(), status: 'running', createdAt: new Date().toISOString(),
    sourceRevisionId: source.id, sourceRevisionNumber: numberOfRevision(project, source), sourceFingerprint: revisionFingerprint(source),
    ...(previous?.kind === 'pending_feedback' && ['needs_input', 'conflict'].includes(previous.status)
      && previous.sourceRevisionId === source.id ? { priorRequest: structuredClone(previous) } : {}) };
  checkedFeedbackSource(project, request);
  const feedback = { id: randomUUID(), requestId: request.id, sourceRevisionId: source.id,
    sourceRevisionNumber: request.sourceRevisionNumber, sourceFingerprint: request.sourceFingerprint,
    baseVersion: input.baseVersion, text: request.text, status: 'running', createdAt: request.createdAt };
  request.feedbackId = feedback.id;
  project.revisionFeedback ??= [];
  project.revisionFeedback.push(feedback);
  project.revisionRequest = request;
  return request;
}
export function finishRevisionRequest(project, request, status, detail, revisionId) {
  request.status = status;
  if (detail) request.detail = detail;
  if (revisionId) request.revisionId = revisionId;
  const feedback = project.revisionFeedback?.find(record => record.id === request.feedbackId && record.requestId === request.id);
  if (feedback) Object.assign(feedback, { status, ...(detail ? { detail } : {}), ...(revisionId ? { revisionId } : {}),
    finishedAt: new Date().toISOString() });
}
function checkedEvidenceRef(project, link, path) {
  revisionEnsure(exactKeys(link, ['evidenceId', 'entityId', 'observedField', 'observedValue', 'observation', 'inspiration', 'basis']),
    'The evidence reference contains a forbidden field', path);
  const card = project.evidence.find(record => record.id === link.evidenceId && record.projectId === project.id);
  revisionEnsure(card && card.relevant !== false, 'The evidence is missing, belongs to another project or is marked irrelevant', `${path}/evidenceId`, 'EVIDENCE_REFERENCE_INVALID');
  const entity = card.returnedEntities?.find(record => (record.id ?? record.entity_id) === link.entityId);
  revisionEnsure(entity && nonempty(link.observedField), 'The evidence did not return this entity or field', `${path}/entityId`, 'EVIDENCE_ENTITY_INVALID');
  const parts = link.observedField.split('.');
  let actual = entity;
  for (const part of parts) {
    revisionEnsure(!['__proto__', 'prototype', 'constructor'].includes(part) && actual && typeof actual === 'object'
      && Object.hasOwn(actual, part), 'This field does not exist in the actual evidence return', `${path}/observedField`, 'EVIDENCE_FIELD_MISSING');
    actual = actual[part];
  }
  revisionEnsure(same(actual, link.observedValue), 'The cited value does not match the actual evidence return', `${path}/observedValue`, 'EVIDENCE_VALUE_MISMATCH');
  const basis = /^(short_|long_)?description$/.test(parts.at(-1)) ? 'description' : parts.at(-1) === 'affinity' ? 'affinity' : 'returned_field';
  revisionEnsure(!link.basis || link.basis === basis, 'Description and cultural affinity evidence are not interchangeable', `${path}/basis`, 'EVIDENCE_BASIS_MISMATCH');
  revisionEnsure(nonempty(link.inspiration), 'Explain the design inference and preserve the unverified boundary', `${path}/inspiration`);
  return { evidenceId: link.evidenceId, entityId: link.entityId, observedField: link.observedField,
    observedValue: structuredClone(actual), basis,
  observation: `Returned ${link.observedField} = ${JSON.stringify(actual)}. ${basis === 'affinity'
    ? 'This is only this request\'s cultural affinity association, not a description, a design score, or an effect prediction.'
    : basis === 'description' ? 'This is an entity description, not a cultural affinity score or evidence of audience effect.' : 'This only proves that the field was actually returned.'}`,
    inspiration: link.inspiration };
}
function checkRevisionField(project, field, after, before, path) {
  const ensureShape = (condition, message) => revisionEnsure(condition, message, path, 'REVISION_SCHEMA_INVALID');
  if (['title', 'coreClaim'].includes(field)) ensureShape(nonempty(after), 'Revised text cannot be empty');
  else if (field === 'mechanism') ensureShape(exactKeys(after, ['organization', 'description'])
    && nonempty(after.organization) && nonempty(after.description), 'The participation mechanism needs an organization and description');
  else if (field === 'journey') ensureShape(Array.isArray(after) && after.length >= 3
    && after.every(step => exactKeys(step, ['stage', 'action']) && nonempty(step.stage) && nonempty(step.action)), 'The experience journey needs at least three valid stages');
  else if (field === 'evidenceLinks') {
    ensureShape(Array.isArray(after), 'Concept evidence references must be an array');
    // Historical links are preserved byte-for-byte; only newly supplied links are checked.
    return after.map((link, index) => before.some(old => same(old, link)) ? structuredClone(link)
      : checkedEvidenceRef(project, link, `${path}/${index}`));
  } else ensureShape(stringArray(after) && (!['productTouchpoints', 'unverifiedEffects'].includes(field) || after.length > 0), 'Revised entries have an invalid format or lack required content');
  return structuredClone(after);
}
export function proposeRevision(project, input) {
  revisionEnsure(exactKeys(input, ['requestId', 'phase', 'summary', 'question', 'changes', 'impact', 'unknowns']), 'The partial revision tool cannot specify a project, target or version, or overwrite the project', '/');
  const request = project.revisionRequest;
  revisionEnsure(request && request.status === 'running' && input.requestId === request.id, 'The revision request is missing or has ended', '/requestId', 'REVISION_REQUEST_MISMATCH');
  binding(project, { conceptId: request.targetConceptId, baseVersion: request.baseVersion });
  const source = request.kind === 'pending_feedback' ? checkedFeedbackSource(project, request) : null;
  revisionEnsure(['pending', 'needs_input', 'conflict'].includes(input.phase) && nonempty(input.summary), 'Invalid revision phase or summary', '/phase');
  revisionEnsure(Array.isArray(input.changes) && stringArray(input.impact) && stringArray(input.unknowns), 'Changes, impact and unknowns must be arrays', '/changes');
  if (input.phase !== 'pending') {
    revisionEnsure(input.changes.length === 0 && nonempty(input.question), 'A clarification or conflict must ask one question without changes', '/question');
    finishRevisionRequest(project, request, input.phase, input.summary); request.question = input.question;
    const feedback = project.revisionFeedback?.find(record => record.id === request.feedbackId);
    if (feedback) feedback.question = input.question;
    project.status = { phase: input.phase === 'conflict' ? 'revision_conflict' : 'revision_needs_input', detail: input.summary };
    return { status: input.phase, question: input.question };
  }
  revisionEnsure(input.changes.length > 0 && input.unknowns.length > 0, 'A pending revision needs actual differences and unknowns', '/changes');
  const target = project.concepts.find(concept => concept.id === request.targetConceptId);
  const draft = source ? pendingRevisionDraft(project, source) : target;
  const changed = new Set();
  const changes = input.changes.map((change, index) => {
    const path = `/changes/${index}`;
    revisionEnsure(exactKeys(change, ['field', 'after', 'reason', 'evidenceRefs']), 'Each change may contain only field, after, reason and evidenceRefs; the server reads the prior content', path);
    revisionEnsure(REVISION_FIELDS.includes(change.field) && !changed.has(change.field), 'The target field is forbidden or repeated', `${path}/field`, 'REVISION_FIELD_NOT_ALLOWED');
    revisionEnsure(!(project.lockedFields ?? []).includes(change.field), 'The request touches a locked field. The user must explicitly unlock it first', `${path}/field`, 'FIELD_LOCKED');
    changed.add(change.field);
    revisionEnsure(nonempty(change.reason) && Array.isArray(change.evidenceRefs), 'Each change needs a reason and actual evidence references', path);
    const before = structuredClone(draft[change.field]);
    const after = checkRevisionField(project, change.field, change.after, before, `${path}/after`);
    revisionEnsure(!same(before, after), source ? 'A feedback revision must differ from the current pending draft' : 'A pending revision must differ from confirmed content', `${path}/after`);
    return { field: change.field, before, after, reason: change.reason,
      evidenceRefs: change.evidenceRefs.map((link, i) => checkedEvidenceRef(project, link, `${path}/evidenceRefs/${i}`)) };
  });
  const candidate = { ...draft, ...Object.fromEntries(changes.map(change => [change.field, change.after])) };
  const consolidated = source ? REVISION_FIELDS.filter(field => !same(target[field], candidate[field])).map(field => {
    const change = changes.find(item => item.field === field) ?? source.changes.find(item => item.field === field);
    revisionEnsure(!(project.lockedFields ?? []).includes(field), 'The merged pending draft touches a locked field. The user must explicitly unlock it first', '/changes', 'FIELD_LOCKED');
    return { ...structuredClone(change), field, before: structuredClone(target[field]), after: structuredClone(candidate[field]) };
  }) : changes;
  revisionEnsure(consolidated.length > 0, 'The revised pending draft must differ from confirmed content. Explicitly reject the draft to withdraw it', '/changes');
  const active = [candidate.coreClaim, candidate.mechanism.description,
    ...candidate.journey.map(step => step.action), ...candidate.productTouchpoints].join(' ');
  for (const required of project.brief.mustKeep) revisionEnsure(active.includes(required), 'The partial revision loses a must-keep item', '/changes', 'REQUIRED_ITEM_MISSING');
  checkForbiddenItems(candidate, project.brief.avoid, field => {
    const [key, ...parts] = field.split('/'), suffix = parts.length ? `/${parts.join('/')}` : '';
    const index = changes.findIndex(change => change.field === key);
    if (index >= 0) return `/changes/${index}/after${suffix}`;
    const sourceIndex = source?.changes.findIndex(change => change.field === key) ?? -1;
    return sourceIndex >= 0 ? `/revisions/${project.revisions.indexOf(source)}/changes/${sourceIndex}/after${suffix}`
      : `/concepts/${project.concepts.indexOf(target)}/${field}`;
  }, revisionEnsure);
  const revision = { id: randomUUID(), projectId: project.id, targetConceptId: request.targetConceptId,
    baseVersion: request.baseVersion, request: request.text, status: 'pending', summary: input.summary,
    changes: consolidated, impact: structuredClone(input.impact), unknowns: structuredClone(input.unknowns), createdAt: new Date().toISOString(),
    revisionNumber: Math.max(0, ...project.revisions.map(record => numberOfRevision(project, record))) + 1,
    ...(source ? { parentRevisionId: source.id, feedbackId: request.feedbackId, draftDelta: changes } : {}),
    ...(request.offlineFixture ? { offlineFixture: request.offlineFixture, synthetic: true } : {}) };
  project.revisions.push(revision);
  if (source) Object.assign(source, { status: 'superseded', supersededByRevisionId: revision.id, supersededAt: revision.createdAt });
  finishRevisionRequest(project, request, 'completed', input.summary, revision.id);
  project.status = { phase: 'revision_pending', detail: input.summary };
  return revision;
}
export function decideRevision(project, revisionId, decision, input) {
  revisionEnsure(exactKeys(input, ['baseVersion']), 'A review may submit only the current confirmed version');
  revisionEnsure(Number.isInteger(input.baseVersion), 'A review must provide the displayed base version', '/baseVersion');
  revisionEnsure(['accept', 'reject'].includes(decision), 'Unknown review decision');
  const revision = project.revisions?.find(record => record.id === revisionId && record.projectId === project.id);
  revisionEnsure(revision, 'The pending revision does not exist', '/revisionId', 'REVISION_NOT_FOUND');
  revisionEnsure(revision.status === 'pending', 'This revision has already been decided and cannot be accepted or rejected again', '/revisionId', 'REVISION_ALREADY_DECIDED');
  revisionEnsure(!(project.revisionRequest?.status === 'running' && project.revisionRequest.kind === 'pending_feedback'
    && project.revisionRequest.sourceRevisionId === revision.id), 'This draft is being revised from feedback. Wait for completion before reviewing', '/revisionId', 'REVISION_IN_PROGRESS');
  if (decision === 'reject') {
    // Rejection never applies changes. Older clients may have left pending
    // records whose target, before values or base version can no longer apply.
    revision.status = 'rejected';
    revision.decidedAt = new Date().toISOString();
    if (!project.revisions.some(record => record.status === 'pending') && project.revisionRequest?.status !== 'running')
      project.status = { phase: 'ready', detail: 'The pending revision was rejected. The confirmed version is unchanged' };
    return project;
  }
  revisionEnsure(input.baseVersion === project.version && revision.baseVersion === project.version,
    'The pending revision\'s base version is stale. The confirmed version is unchanged', '/baseVersion', 'STALE_PROJECT_VERSION');
  binding(project, { conceptId: revision.targetConceptId, baseVersion: revision.baseVersion });
  const target = project.concepts.find(concept => concept.id === revision.targetConceptId);
  for (const change of revision.changes) {
    revisionEnsure(REVISION_FIELDS.includes(change.field) && same(target[change.field], change.before), 'Confirmed content has changed. Propose a new revision', '/changes', 'STALE_PROJECT_VERSION');
    revisionEnsure(!(project.lockedFields ?? []).includes(change.field), 'The target field is locked. The confirmed version is unchanged', '/changes', 'FIELD_LOCKED');
  }
  for (const change of revision.changes) target[change.field] = structuredClone(change.after);
  project.version++;
  revision.confirmedVersion = project.version;
  rememberVersion(project, revision.id);
  revision.status = 'accepted';
  revision.decidedAt = new Date().toISOString();
  project.status = { phase: 'ready', detail: 'The partial revision was accepted as the confirmed version' };
  return project;
}

export function configStatus(env = process.env) {
  const required = ['ART_MODEL_PROVIDER', 'ART_MODEL_ID', 'ART_MODEL_API', 'ART_MODEL_BASE_URL', 'ART_MODEL_API_KEY', 'QLOO_API_KEY', 'QLOO_API_URL'];
  const missing = required.filter(name => !env[name]?.trim());
  const enabled = env.ART_ENABLE_LIVE === 'true';
  const production = env.VERCEL_ENV !== undefined ? !['preview', 'development'].includes(env.VERCEL_ENV) : env.NODE_ENV === 'production';
  return { production, modes: { offline: { available: !production, synthetic: true },
    live: { available: enabled && missing.length === 0, enabled, missing,
      modelKeyPresent: Boolean(env.ART_MODEL_API_KEY), qlooKeyPresent: Boolean(env.QLOO_API_KEY),
      detail: enabled ? 'Live mode requires an explicit provider, model and endpoint, and stays within the total budget'
        : production ? 'Live generation is disabled. Saved projects remain readable; synthetic generation is unavailable.'
          : 'Live mode has not been separately enabled. The local offline demo is available' } },
    runtime: { name: '@qloo/qloo-harness', version: '0.1.26' }, limits: LIMITS, serverLimits: SERVER_LIMITS };
}
