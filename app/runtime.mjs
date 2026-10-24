// The official harness owns model continuation and tool dispatch.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPiHarnessRuntime, resolveQlooPaths, createQlooTools,
  createDelegatingQlooWorkflowExecutor, createDirectQlooWorkflowExecutorFromEnvironment,
  withPiAgentDirectory, withPiPrivacyDefaults } from '@qloo/qloo-harness';
import { ModelRuntime, SessionManager, parseSessionEntries, buildSessionContext } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Errors } from 'typebox/value';
import { applyProposal, proposeRevision, pendingRevisionDraft, finishRevisionRequest, REVISION_FIELDS, action, configStatus, LIMITS } from './state.mjs';
import { withHttpBudget, withoutNetwork, liveRunStopped, stopLiveRun, safeRuntimeFailure,
  remainingBudget, toolFeedback, recordLocalFailure, modelOutputLimit } from './transport.mjs';
import { evidenceView, readProjectEvidence, qlooResultView, compactToolMessages, unresolvedResearch, assembleContext, requestBudget, clarificationView } from './context.mjs';
import { pendingReference, referenceQuestion, observeReferenceResolution, bindReferenceInputs, referenceResolutionView } from './references.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/culture-signals.json', import.meta.url)));
export const TOOL_NAMES = Object.freeze(['qloo_describe', 'qloo_recommend', 'propose_design_response', 'read_project_evidence']);
export const REVISION_TOOL_NAMES = Object.freeze(['propose_concept_revision', 'read_project_evidence']);
const toolText = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
const contextCapacityReason = budget => `The offline estimate of the full request exceeds the local context budget by ${budget.overByTokens} tokens. The largest part is ${
  { system: 'the system instructions', work: 'the current working state', history: 'the latest tool turns', tools: 'the tool definitions', wrappers: 'the request wrapper fields' }[budget.largestComponent]}. Output capacity and the safety margin were kept. The run stopped locally and the current state was kept.`;
const projectEvidenceReference = reference => {
  const { observation, ...fields } = reference;
  const derived = `Returned ${reference.observedField} = ${JSON.stringify(reference.observedValue)}. ${reference.basis === 'affinity'
    ? 'This is only this request\'s cultural affinity association, not a description, a design score, or an effect prediction.' : reference.basis === 'description'
      ? 'This is an entity description, not a cultural affinity score or evidence of audience effect.' : 'This only proves that the field was actually returned.'}`;
  return observation === derived ? fields : reference;
};
const snapshotProject = project => {
  const clarification = clarificationView(project);
  if (clarification.independentLimitExceeded) throw recordLocalFailure(project, 'model', 'MODEL_CONTEXT_CLARIFICATION_LIMIT',
    'The project has more than 12 independent clarifications. Active conditions cannot be safely omitted; the run paused locally and the full project record was kept.');
  const pending = project.revisionRequest?.kind === 'pending_feedback'
    ? project.revisions?.find(revision => revision.id === project.revisionRequest.sourceRevisionId) : null;
  const priorFeedback = pending && project.revisionFeedback?.findLast(feedback =>
    feedback.requestId !== project.revisionRequest.id
    && feedback.sourceRevisionId === pending.id
    && feedback.baseVersion === project.revisionRequest.baseVersion);
  const target = project.concepts.find(concept => concept.id === project.revisionRequest?.targetConceptId);
  const referenced = new Set([...(target?.evidenceLinks ?? []), ...(pending?.changes ?? []).flatMap(change => change.evidenceRefs ?? [])]
    .map(reference => reference.evidenceId));
  const relevant = project.evidence.filter(card => card.relevant !== false);
  const linked = relevant.filter(card => referenced.has(card.id));
  const evidence = (target && linked.length ? linked : relevant).map(card => evidenceView(card, project.mode === 'offline'));
  return structuredClone({ id: project.id, version: project.version,
  brief: project.brief, evidence, concepts: project.concepts,
  clarifications: clarification.records,
  clarificationHistory: { total: clarification.total, omitted: clarification.omitted },
  referenceResolution: referenceResolutionView(project),
  questions: project.questions, status: project.status, selectedConceptId: project.selectedConceptId,
  lockedFields: project.lockedFields ?? [], revisionRequest: project.revisionRequest,
  ...(priorFeedback ? { priorFeedback: { text: priorFeedback.text, status: priorFeedback.status } } : {}),
  ...(project.runtime.feedback ? { previousFeedback: Object.fromEntries(['code', 'path', 'reason', 'correctable', 'nextAction']
    .filter(key => Object.hasOwn(project.runtime.feedback, key)).map(key => [key, project.runtime.feedback[key]])) } : {}),
  ...(pending ? { currentPendingRevision: { ...pending, draftDelta: undefined,
    changes: pending.changes.map(({ before, after, ...metadata }) => ({ ...metadata,
      evidenceRefs: metadata.evidenceRefs.map(projectEvidenceReference) })) },
    currentPendingDraft: pendingRevisionDraft(project, pending) } : {}),
  remainingBudget: remainingBudget(project) });
};
const strings = Type.Array(Type.String());
const briefFields = ['request', 'brand', 'goal', 'references', 'venue', 'budget', 'mustKeep', 'avoid'];
const evidenceReferenceFields = {
  evidenceId: Type.String({ description: 'Evidence card ID (tool.artEvidence.id or project.evidence[].id) whose returnedEntities/tool outer results actually contains entityId. inputReferences/signals are query inputs, not returned entities.' }),
  entityId: Type.String({ description: 'Exact id/entity_id from that same card\'s returned entities; a seed ID is valid only if this card actually returned it.' }),
  observedField: Type.String({ description: 'Path relative to the single returned entity root, e.g. properties.description, properties.short_description or affinity. No returnedEntities/results container prefix, [] wildcard or leading array index.' }),
  observedValue: Type.Unknown({ description: 'Copy the complete actual field value with its original JSON type; never a summary, substring or paraphrase.' }),
};
const proposalSchema = Type.Object({ baseVersion: Type.Integer(),
  phase: Type.Union(['needs_input', 'ready', 'insufficient_evidence'].map(v => Type.Literal(v))),
  summary: Type.String(), questions: Type.Optional(Type.Array(Type.Object({
    field: Type.Union(briefFields.map(value => Type.Literal(value))), text: Type.String() }, { additionalProperties: false }))),
  concepts: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), coreClaim: Type.String(),
    mechanism: Type.Object({ organization: Type.String(), description: Type.String() }),
    journey: Type.Array(Type.Object({ stage: Type.String(), action: Type.String() })),
    productTouchpoints: strings,
    evidenceLinks: Type.Array(Type.Object({ ...evidenceReferenceFields, observation: Type.String(), inspiration: Type.String() })),
    openQuestions: strings, unverifiedEffects: strings })) }, { additionalProperties: false });
const revisionReferenceSchema = Type.Object({ ...evidenceReferenceFields,
  observation: Type.Optional(Type.String()), inspiration: Type.String(),
  basis: Type.Optional(Type.Union(['description', 'affinity', 'returned_field'].map(value => Type.Literal(value)))) }, { additionalProperties: false });
const revisionSchema = Type.Object({
  phase: Type.Union(['pending', 'needs_input', 'conflict'].map(value => Type.Literal(value))),
  summary: Type.String(), question: Type.Optional(Type.String()),
  changes: Type.Array(Type.Object({ field: Type.Union(REVISION_FIELDS.map(value => Type.Literal(value))),
    after: Type.Unknown({ description: 'Complete replacement value using the selected field\'s existing JSON shape. Every change, including evidenceLinks, requires four sibling keys: field, after, reason, evidenceRefs. Put reason and evidenceRefs beside after, never inside it.' }),
    reason: Type.String({ description: 'Required nonempty reason for this individual change, including an evidenceLinks change. This is a sibling of after, not a property inside its value.' }),
    evidenceRefs: Type.Array(revisionReferenceSchema, { description: 'Required array of exact existing evidence references for this individual change, including an evidenceLinks change. This is a sibling of after; never omit it or move it inside after. Use [] when this change cites no evidence.' }) }, { additionalProperties: false }),
    { description: 'Only actual field changes: compare after with the selected concept in project.concepts, or currentPendingDraft for pending_feedback. Omit unchanged fields, including evidenceLinks and unverifiedEffects; each field may appear only once. Omitted fields are preserved. Within a changed field, retain unaffected entries and conditions.' }),
  impact: Type.Array(Type.String(), { description: 'Required top-level array describing the scope and consequences of these changes. Always include impact, even when the array is empty; do not place it inside a change.' }),
  unknowns: Type.Array(Type.String(), { description: 'Required top-level array of actual unverified conditions. A pending revision needs at least one unknown; needs_input/conflict may use []. Never omit unknowns or present an unverified condition as resolved.' }) }, { additionalProperties: false });
const revisionCorrection = 'Correct the revision using the feedback path and types. changes must contain only real differences from the selected confirmed concept, or from currentPendingDraft during pending_feedback. Remove unchanged change entries. Do not rewrite unrelated content to manufacture a difference. Inside a changed field, keep unaffected entries and conditions. Include real impact and unknowns. Use only exact existing evidence. Do not query Qloo. You may submit pending, or pause with needs_input or conflict, exactly one question, and changes: []. The confirmed version stays unchanged. Write every user-visible string in English.';

// A named, explicitly selected fixture exercises official model/tool dispatch.
// It makes no claim to understand arbitrary feedback or generate a live design.
export function offlineRevisionDecision(context, snapshot) {
  const userIndex = context.messages.findLastIndex(message => message.role === 'user');
  const results = context.messages.slice(userIndex + 1).filter(message => message.role === 'toolResult');
  if (results.length) return [{ type: 'text', text: 'The demo revision was created. Review the checks and the before/after comparison. This is not a model reading your words, and it is not proof of an effect.' }];
  const request = snapshot.revisionRequest;
  const fixtureName = request?.offlineFixture;
  const response = { phase: 'needs_input', summary: 'Demo mode cannot interpret arbitrary feedback. Confirmed content stays unchanged.',
    question: 'To try the review flow, choose a demo revision under the change box. Understanding free text requires live research.',
    changes: [], impact: [], unknowns: ['The live model\'s reading of this input, and the design quality, are not verified.'] };
  if (fixtureName === 'conflict') Object.assign(response, { phase: 'conflict',
    summary: 'Demo conflict: the required try-on conflicts with removing every product contact.',
    question: 'Confirm whether the original required try-on stays. The confirmed proposal is not changed until you do.' });
  if (fixtureName === 'needs_input') Object.assign(response, { summary: 'Demo clarification: capacity would change a paired format.',
    question: 'How many people can take part in one round? If unknown, mark it as still to be confirmed.' });
  if (['pair_45', 'invalid_reference'].includes(fixtureName)) {
    const target = snapshot.concepts.find(concept => concept.id === request.targetConceptId);
    const references = [];
    for (const card of snapshot.evidence) {
      if (card.projectId !== snapshot.id || card.relevant === false) continue;
      for (const entity of card.returnedEntities ?? []) {
        const entry = Object.entries(entity.properties ?? {}).find(([key, value]) => /^(short_|long_)?description$/.test(key) && typeof value === 'string' && value.trim());
        if (entry) references.push({ evidenceId: card.id, entityId: entity.id ?? entity.entity_id,
          observedField: `properties.${entry[0]}`, observedValue: entry[1], basis: 'description',
          inspiration: 'Design inference: the returned description is only a creative reference for pairing an anonymous wearer and recorder. It does not prove size, stock, try-on duration, or any effect.' });
      }
    }
    if (fixtureName === 'invalid_reference') references.splice(0, references.length, { evidenceId: 'offline-intentionally-missing',
      entityId: 'offline-missing', observedField: 'properties.description', observedValue: 'This offline citation is intentionally invalid',
      inspiration: 'Used only to check that the server rejects it. This is not evidence.' });
    const contact = snapshot.brief.mustKeep.length ? snapshot.brief.mustKeep.join(', ') : 'product try-on';
    const sizeAllocation = 'Confirm each person\'s size separately and assign each their own pair. Swap roles, not shoes. If a size or quantity is missing, pause this pair and state the stock conflict. Do not substitute an ill-fitting shoe or the same pair';
    const ownSizeTouchpoint = `Actual ${contact}: ${sizeAllocation}.`;
    let replacedAllocation = false;
    const productTouchpoints = target.productTouchpoints.map(item => {
      if (item.includes('每对一双') && item.includes('轮换')) {
        replacedAllocation = true;
        return item.replace(/每对一双轮换(?:[，,]含半码备用)?/, sizeAllocation);
      }
      return item;
    });
    if (!replacedAllocation && !productTouchpoints.includes(ownSizeTouchpoint)) productTouchpoints.push(ownSizeTouchpoint);
    const stockQuestion = 'Size stock is a precondition. The two fitted sizes and how many pairs can be assigned are not checked. If a size or quantity is missing, pause this pair and state the stock conflict. The user decides whether to restock, reschedule, or cancel. Do not claim supply is solved.';
    const openQuestions = target.openQuestions.map(item => item.includes('每对一双') || /尺码.*(?:库存|分布|双数)/.test(item) ? stockQuestion : item);
    if (!openQuestions.includes(stockQuestion)) openQuestions.push(stockQuestion);
    const timeQuestion = 'Whether 0–5 minutes is enough to measure and assign shoes, whether two blocks of at least 15 minutes plus a 35–40 minute retest fit the planned headcount, must be checked against real stock, staff, and room capacity. Forty-five minutes is a design schedule, not evidence of an effect.';
    if (!openQuestions.includes(timeQuestion)) openQuestions.push(timeQuestion);
    const proposed = {
      mechanism: { organization: 'Anonymous pair, 45-minute timed role swap. Keep the original group size and numbering. Swap roles, not shoes.',
        description: `Keep the two-way retelling: the recorder asks the original four questions and writes them down, then they check each other. 0–5 min: measure each person's own size and assign a separate pair. 5–20 min: A wears their own size while B records. 20–35 min: B wears their own size while A records. Each try-on is at least 15 minutes. 35–40 min: retest personal questions in each person's own size. 40–45 min: check together and leave. If a size or quantity is missing, pause this pair and state the stock conflict. Do not hand one person's shoes to someone of a different size. Forty-five minutes and each block are a design schedule, not evidence of fit or effect.` },
      journey: [{ stage: 'Measure and assign · 0–5 min', action: 'Keep the original anonymous numbers and recording rules. Staff confirm each person\'s size and prepare one fitted pair each. If a size or quantity is missing, pause this pair, state the stock conflict, and wait for the user to restock or reschedule.' },
        { stage: 'A tries on, B records · 5–20 min', action: `A wears their own fitted pair for at least 15 minutes of ${contact} and follows the original product path. B asks the original four questions and records them. A does not fill in the review.` },
        { stage: 'B tries on, A records · 20–35 min', action: `Swap roles, not shoes. B wears a different pair in their own size for at least 15 minutes of ${contact}. A asks the same four questions and records them. Do not hand A's shoes to B when the sizes differ.` },
        { stage: 'Retest own size · 35–40 min', action: 'Retest the personal questions from the notes in each person\'s own size. Do not use the other person\'s shoes or notes as a substitute for fit.' },
        { stage: 'Check together and leave · 40–45 min', action: `The pair corrects the original record card together and keeps the original takeaway and anonymity rules. ${target.journey.at(-1)?.action ?? 'Each person takes their own notes.'}` }],
      productTouchpoints, openQuestions,
    };
    Object.assign(response, { phase: 'pending', summary: 'Demo revision: the 45-minute paired try-on now uses each person\'s own size and a separate pair. Stock is unconfirmed; a missing size pauses the pair. This is only a pending change. It does not mean arbitrary feedback was understood.',
      changes: Object.entries(proposed).filter(([field, after]) => JSON.stringify(after) !== JSON.stringify(target[field])).map(([field, after]) => ({
        field, after, reason: ['mechanism', 'journey'].includes(field)
          ? 'Offline design setting: keep the anonymous two-way retelling, and change only the 45-minute schedule and the separate size assignment. The returned description supports only a creative inference about role pairing. It does not prove fit or effect.'
          : 'Operational design inference: fix the size conflict of one shared pair, and keep unrelated samples, material pads, and the record card. Separate pairs depend on stock and capacity that are not yet checked.',
        evidenceRefs: ['mechanism', 'journey'].includes(field) ? references.slice(0, 1) : [] })),
      impact: ['Changes only the separate sizing, the 45-minute role blocks, the retest, and the related stock and capacity questions. Title, core claim, historical evidence, unrelated product contact, and takeaway stay.'],
      unknowns: ['Actual size stock and one pair per person are not checked. A missing size must pause the pair and state the conflict.',
        'Measuring, two 15-minute try-on blocks, and the retest at the planned headcount, plus whether 45 minutes is workable, are not verified.',
        ...(references.length ? [] : ['Saved evidence has no citable description field. This demo draft adds no description fact.'])] });
  }
  return [{ type: 'toolCall', id: randomUUID(), name: 'propose_concept_revision', arguments: response }];
}

const valueState = value => value === undefined ? 'missing' : value === null ? 'null'
  : (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)
    || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) ? 'empty' : 'present';
const valueType = value => value === undefined ? 'missing' : value === null ? 'null'
  : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
const feedbackFields = feedback => ({ expectedType: feedback.expectedType, actualType: feedback.actualType,
  valueState: feedback.valueState });
function fieldAt(input, path) {
  return path === '/' ? input : path.split('/').slice(1).reduce((value, part) => value?.[part], input);
}
function expectedAt(schema, path) {
  let current = schema;
  for (const part of path.split('/').slice(1)) current = /^\d+$/.test(part) ? current?.items : current?.properties?.[part];
  return current?.type ?? (current?.anyOf?.every(option => option.type === 'string') ? 'string' : 'unknown');
}
function valueDiagnostic(input, path, expectedType) {
  const value = fieldAt(input, path);
  return { expectedType, actualType: valueType(value), valueState: valueState(value) };
}
function schemaIssue(schema, input) {
  const issue = Errors(schema, input)[0];
  if (!issue) return null;
  const extra = issue.keyword === 'additionalProperties' ? issue.params?.additionalProperties?.[0] : undefined;
  const required = issue.keyword === 'required' ? issue.params?.requiredProperties?.[0] : undefined;
  const candidate = extra ? extra === 'projectId' && !issue.instancePath ? '/projectId' : issue.instancePath || '/'
    : `${issue.instancePath || ''}${required ? `/${required}` : ''}` || '/';
  // Check each segment against its parent schema; unknown property names stay private.
  let current = schema;
  const safe = candidate.split('/').slice(1).every(part => {
    if (part === 'projectId' && candidate === '/projectId') return true;
    current = /^\d+$/.test(part) ? current?.items : current?.properties?.[part];
    return Boolean(current);
  });
  const path = safe ? candidate : '/';
  const expectedType = extra ? 'absent' : issue.params?.type ?? expectedAt(schema, path);
  return { path, ...valueDiagnostic(input, path, expectedType) };
}
function businessDiagnostic(project, input, path) {
  let expectedType = expectedAt(proposalSchema, path);
  const match = /^\/concepts\/(\d+)\/evidenceLinks\/(\d+)\/observedValue$/.exec(path);
  if (match) {
    const link = input.concepts?.[Number(match[1])]?.evidenceLinks?.[Number(match[2])];
    const evidence = project.evidence.find(card => card.id === link?.evidenceId && card.projectId === project.id);
    const entity = evidence?.returnedEntities.find(item => (item.id ?? item.entity_id) === link?.entityId);
    const observed = link?.observedField?.split('.').reduce((value, part) =>
      value && typeof value === 'object' && Object.hasOwn(value, part) ? value[part] : undefined, entity);
    if (observed !== undefined) expectedType = valueType(observed);
  }
  return valueDiagnostic(input, path, expectedType);
}

function mockConcepts(snapshot, card) {
  const required = snapshot.brief.mustKeep.length ? snapshot.brief.mustKeep : ['product experience'];
  const contact = required.join(', ');
  const entities = card?.returnedEntities ?? [];
  return [
    { id: `${snapshot.id}:concept-a`, title: 'Shared beat · scheduled entry',
      coreClaim: 'People complete one product experience at the same time. They take part together instead of waiting to watch.',
      mechanism: { organization: 'collective_scheduled', description: 'A small group starts on a fixed slot. A shared beat organizes the movement tasks. Staff guide the rotation and the product notes.' },
      journey: [{ stage: 'Why come', action: 'Book a movement session that companions do together.' },
        { stage: 'What you do inside', action: 'Join a timed group and finish the movement tasks on a shared beat.' },
        { stage: 'How you meet the product', action: `The movement tasks include ${contact}. People write down how it feels on site.` },
        { stage: 'What you take away', action: 'A personal note and the shared beat record from this session.' }],
      productTouchpoints: [`${contact}: staff help with the experience and collect a description of comfort.`],
      evidenceLinks: entities[0] ? [{ evidenceId: card.id, entityId: entities[0].id,
        observedField: 'properties.participation', observedValue: entities[0].properties.participation,
        observation: `Synthetic data shows participation as ${entities[0].properties.participation}. This is not a real audience fact.`,
        inspiration: 'The shared-rhythm signal is translated into a timed, group-synchronized format. This is a design inference.' }] : [],
      openQuestions: ['Slot capacity, sound rights, and staffing are still unconfirmed.'],
      unverifiedEffects: ['Willingness to show up, participation, and conversion are unverified. This is not an effect prediction.'] },
    { id: `${snapshot.id}:concept-b`, title: 'Personal fragment · self-paced',
      coreClaim: 'Each visitor moves a story task at their own pace. The product experience decides the next chapter.',
      mechanism: { organization: 'individual_self_paced', description: 'A person picks a story start and finishes scattered tasks alone. There is no shared opening. Product notes unlock the next chapter.' },
      journey: [{ stage: 'Why come', action: 'Choose a personal story start and explore one everyday fragment.' },
        { stage: 'What you do inside', action: 'Choose the task order and move through the stations at your own pace.' },
        { stage: 'How you meet the product', action: `After ${contact}, write a personal note. That note advances the story.` },
        { stage: 'What you take away', action: 'Your own story card and the product-experience note.' }],
      productTouchpoints: [`${contact}: each station has one product experience a person can finish alone.`],
      evidenceLinks: entities[1] ? [{ evidenceId: card.id, entityId: entities[1].id,
        observedField: 'properties.participation', observedValue: entities[1].properties.participation,
        observation: `Synthetic data shows participation as ${entities[1].properties.participation}. This is not a real audience fact.`,
        inspiration: 'The self-directed story signal is translated into a personal order, advanced by product notes. This is a design inference.' }] : [],
      openQuestions: ['Content rights, accessible tasks, and the space at each station are still unconfirmed.'],
      unverifiedEffects: ['Whether self-paced exploration increases dwell time or brand understanding still needs user research.'] },
  ];
}

// This deterministic offline model reads only portable content.text tool results.
// It is a test fixture model, never represented as real model creativity.
export function offlineDecision(context, snapshot) {
  if (snapshot.revisionRequest?.status === 'running') return offlineRevisionDecision(context, snapshot);
  const userIndex = context.messages.findLastIndex(m => m.role === 'user');
  let userText = '';
  try { userText = JSON.parse(toolText(context.messages[userIndex])).message || ''; } catch { userText = toolText(context.messages[userIndex]); }
  const results = context.messages.slice(userIndex + 1).filter(m => m.role === 'toolResult');
  const parsed = results.map(m => { try { return { name: m.toolName, value: JSON.parse(toolText(m)) }; } catch { return { name: m.toolName, value: { status: 'error' } }; } });
  const proposalResult = parsed.find(r => r.name === 'propose_design_response');
  if (proposalResult) return [{ type: 'text', text: proposalResult.value.accepted
    ? 'The offline demo board was updated. Every cultural return is fictional synthetic data. The design and its effects still need a real check.'
    : 'The proposal failed the project constraints. No change was applied.' }];
  const proposal = { baseVersion: snapshot.version,
    phase: 'needs_input', summary: '', questions: [], concepts: [] };
  const reuse = /已有证据|复用|不要.*查询|不再.*查|reuse|do not query|don't query|stop researching/i.test(userText);
  const queryAgain = /重新查询|重新研究|重跑|再查|更新.*证据|query again|research again/i.test(userText) && !reuse;
  if (reuse) {
    const existing = snapshot.evidence.find(e => e.relevant === true && e.returnedEntities.length === 2);
    proposal.phase = existing ? 'ready' : 'insufficient_evidence';
    proposal.summary = existing ? 'Reused this project\'s saved offline synthetic evidence, as requested. This round did not add a query.'
      : 'Stopped further queries, as requested. Saved evidence is not enough, so concept generation pauses. Research is not invented.';
    proposal.concepts = existing ? mockConcepts(snapshot, existing) : [];
  } else if (snapshot.concepts.length && !queryAgain) {
    proposal.phase = 'insufficient_evidence';
    proposal.summary = 'Offline simulation cannot understand arbitrary feedback or make a real semantic edit. The current discussion draft stays. This round added no query. A live model and the later revision flow still need a separate check.';
    proposal.concepts = snapshot.concepts;
  } else if (!snapshot.brief.venue) {
    proposal.summary = 'The venue changes capacity and how people are organized. Add that before research.';
    proposal.questions = [{ field: 'venue', text: 'Which city is this in, indoors or outdoors, and about how much space is available? Unknowns can be stated as unknown.' }];
  } else if (!snapshot.brief.references.length) {
    proposal.summary = 'There is no cultural research signal yet. Confirm references before treating a brand name as an audience profile.';
    proposal.questions = [{ field: 'references', text: 'Which music, film, or cultural references did the client confirm? These are only signals to research.' }];
  } else {
    const query = parsed.find(r => r.name === 'qloo_recommend');
    if (!query) return [{ type: 'toolCall', id: randomUUID(), name: 'qloo_recommend',
      arguments: { target_type: 'artist', signals: snapshot.brief.references, limit: 2 } }];
    const card = query.value.artEvidence && { ...query.value.artEvidence, returnedEntities: query.value.results ?? [] };
    const useful = card && card.relevant && card.returnedEntities.length === 2;
    proposal.phase = useful ? 'ready' : 'insufficient_evidence';
    proposal.summary = useful ? 'Offline synthetic evidence returned to the official session and was translated into two ways of participating. Live data has not been checked.'
      : 'Not enough evidence: the query failed or the result does not address the design question. The drafts below have no supporting evidence. Research should be added or changed.';
    proposal.concepts = mockConcepts(snapshot, useful ? card : null);
  }
  return [{ type: 'toolCall', id: randomUUID(), name: 'propose_design_response', arguments: proposal }];
}

function syntheticStream(model, content) {
  const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  for (const [contentIndex, part] of content.entries()) {
    if (part.type === 'toolCall') stream.push({ type: 'toolcall_end', contentIndex, toolCall: part, partial: message });
    else {
      stream.push({ type: 'text_start', contentIndex, partial: message });
      stream.push({ type: 'text_delta', contentIndex, delta: part.text, partial: message });
      stream.push({ type: 'text_end', contentIndex, content: part.text, partial: message });
    }
  }
  stream.push({ type: 'done', reason: message.stopReason, message });
  stream.end(message);
  return stream;
}

export function recordEvidence(project, operation, input, execution) {
  const result = execution.result;
  if (!['ok', 'empty'].includes(result.status)) return;
  const entities = Array.isArray(result.results) ? result.results : [];
  const synthetic = project.mode === 'offline';
  const resolved = Array.isArray(result.interpretation?.signals) ? result.interpretation.signals
    : result.interpretation?.entity ? [result.interpretation.entity] : [];
  const inputReferences = !synthetic && resolved.length ? resolved.map(entity => ({
    id: entity.entityId ?? entity.entity_id ?? entity.id ?? null,
    name: entity.name ?? entity.input ?? 'Unknown', type: entity.type ?? 'Unknown', match: entity.match ?? 'Unknown',
    synthetic: false, resolution: structuredClone(entity), note: 'From the actual official workflow interpretation; client references are still not a verified audience profile' }))
    : (input.signals ?? [input.entity]).filter(Boolean).map((name, i) =>
    ({ id: synthetic ? `fixture:input-${i + 1}` : null, name, type: synthetic ? 'synthetic:input-signal' : 'unknown', synthetic,
      note: synthetic ? 'Synthetic placeholder for a client-provided research signal; not a resolved Qloo entity' : 'Actual resolution is retained in rawResult. Missing identifiers and types are unknown' }));
  const card = { id: randomUUID(), projectId: project.id, inputReferences,
    returnedEntities: structuredClone(entities), source: synthetic ? fixture.source : 'Qloo official workflow',
    query: { workflow: operation, input: structuredClone(input), designQuestion: 'Which cultural signals could change how people participate and meet the product?' },
    context: { venue: project.brief.venue || 'Unknown', geographicFilter: input.filter_location ?? 'Not applied; venue text is not an applied geographic filter',
      referenceStatus: synthetic ? 'Synthetic sample; real entities have not been resolved' : 'Check the actual workflow resolution; no proxy brand was automatically confirmed' },
    queriedAt: new Date().toISOString(), requestRef: execution.correlationId, synthetic,
    relevant: synthetic ? project.scenario !== 'irrelevant' : null,
    boundary: synthetic ? 'Synthetic data with fictional entities; not Qloo data, a real audience profile, or evidence of event effects.'
      : 'Cultural associations do not prove individual behavior, causal effects, colors, materials, budget, rights clearance, or partner availability.',
    rawResult: structuredClone(result) };
  project.evidence.push(card);
  return card;
}

function stoppedExecution(project, executor, operation, context) {
  project.runtime.queryStopped = true;
  const correlationId = context?.correlationId ?? randomUUID();
  return { operation, transport: executor.transport, correlationId, durationMs: 0,
    result: { schema_version: '1.0-preview.1', operation, status: 'error', queryStopped: true,
      feedback: project.runtime.localFailure?.kind === 'qloo'
        ? toolFeedback(project, project.runtime.localFailure.code, '/', project.runtime.localFailure.reason)
        : toolFeedback(project, 'QLOO_QUERY_STOPPED', '/', 'Queries have stopped for this run. Do not send another query or a substitute request.'),
      summary: 'Live queries have stopped for this run. Further queries and substitute requests are blocked. Draft from exact fields already saved, with the boundary marked, or pause explicitly. Write that draft in English.',
      error: { code: 'ART_QUERY_STOPPED', layer: 'harness', retryable: false, recovery: 'Keep the current project and state the failure. Do not retry or send a substitute query.' }, results: [] } };
}

// Database stops stay with the project; file validation stops cover the round.
// A failed execute can return its error to the model, but cannot open another query.
export function wrapProjectExecutor(project, officialExecutor, env = process.env) {
  return { ...officialExecutor, async execute(operation, input, context) {
    const blocked = reason => ({ operation, transport: officialExecutor.transport, correlationId: context?.correlationId ?? randomUUID(), durationMs: 0,
      result: { schema_version: '1.0-preview.1', operation, status: 'needs_input', results: [],
        summary: reason, feedback: toolFeedback(project, 'REFERENCE_CONFIRMATION_REQUIRED', '/signals', reason, true) } });
    if (operation === 'recommend' && pendingReference(project))
      return blocked('The input cultural reference is unresolved. Recommendations are paused; choose an actual candidate or add detail first.');
    try { input = bindReferenceInputs(project, operation, input); }
    catch (error) { const execution = blocked(error.message); execution.result.feedback.code = error.code; return execution; }
    if (project.mode === 'live' && (liveRunStopped(project) || remainingBudget(project).queryStopped))
      return stoppedExecution(project, officialExecutor, operation, context);
    if (project.mode === 'live' && remainingBudget(project).qlooHttpAttempts === 0) {
      recordLocalFailure(project, 'qloo', 'QLOO_HTTP_BUDGET_EXHAUSTED', 'The Qloo HTTP budget is exhausted. The query was blocked locally; no new remote request was sent.');
      project.runtime.queryStopped = true;
      project.runtime.failure = safeRuntimeFailure(project, 'qloo');
      stopLiveRun(project, project.runtime.failure, true);
      return stoppedExecution(project, officialExecutor, operation, context);
    }
    let execution;
    try {
      execution = project.mode === 'offline' ? await withoutNetwork(project, () => officialExecutor.execute(operation, input, context))
        : await withHttpBudget(project, 'qloo', env.QLOO_API_URL, () => officialExecutor.execute(operation, input, context));
      if (!execution?.result || typeof execution.result.status !== 'string') throw new Error('The official query returned an invalid format');
      const resolvedInput = observeReferenceResolution(project, operation, input, execution.result);
      if (resolvedInput && !pendingReference(project)) {
        input = resolvedInput;
        execution = project.mode === 'offline' ? await withoutNetwork(project, () => officialExecutor.execute(operation, input, context))
          : await withHttpBudget(project, 'qloo', env.QLOO_API_URL, () => officialExecutor.execute(operation, input, context));
        if (!execution?.result || typeof execution.result.status !== 'string') throw new Error('The official query returned an invalid format');
      }
      if (project.referenceResolutions?.length) execution = { ...execution,
        result: { ...execution.result, referenceResolution: referenceResolutionView(project) } };
    } catch (error) {
      action(project, 'query', 'Cultural research did not finish', project.mode === 'offline' ? 'Synthetic demo data could not be read' : 'The official query failed. Further live queries in this run are stopped', 'error');
      if (project.mode === 'live') {
        project.runtime.failure = safeRuntimeFailure(project, 'qloo');
        stopLiveRun(project, project.runtime.failure, true);
        const stopped = stoppedExecution(project, officialExecutor, operation, context);
        if (project.runtime.localFailure?.kind !== 'qloo') stopped.result.feedback = toolFeedback(project,
          'QLOO_REMOTE_ERROR', '/', 'The official workflow failed. No new supporting evidence was obtained.');
        return stopped;
      }
      throw error;
    }
    if (project.mode === 'live' && project.runtime.localFailure?.kind === 'qloo') {
      project.runtime.queryStopped = true;
      project.runtime.failure = safeRuntimeFailure(project, 'qloo');
      stopLiveRun(project, project.runtime.failure, true);
      return stoppedExecution(project, officialExecutor, operation, context);
    }
    if (project.mode === 'live' && execution.result.status === 'error') {
      project.runtime.queryStopped = true;
      project.runtime.failure = safeRuntimeFailure(project, 'qloo');
      stopLiveRun(project, project.runtime.failure, true);
      execution = { ...execution, result: { ...execution.result, queryStopped: true,
        stopReason: 'The official query returned an error. Further queries and substitute requests are blocked for this run.' } };
    }
    const card = recordEvidence(project, operation, input, execution);
    if (card) {
      const { rawResult, returnedEntities, ...metadata } = card;
      execution = { ...execution, result: { ...execution.result, artEvidence: metadata } };
    }
    const status = execution.result.status;
    const empty = status === 'empty' || (status === 'ok' && Array.isArray(execution.result.results) && execution.result.results.length === 0);
    const feedback = toolFeedback(project,
      empty ? 'QLOO_EMPTY' : status === 'needs_input' ? 'QLOO_NEEDS_INPUT' : status === 'error' ? 'QLOO_REMOTE_ERROR' : 'QLOO_RESULT_AVAILABLE', '/',
      empty ? 'The query finished and returned 0 entities. There is nothing to cite. This is not a local budget exhaustion.'
        : status === 'needs_input' ? 'The official workflow needs a clarified entity or query parameter. No usable result was returned.'
          : status === 'error' ? 'The official workflow returned an error. No new supporting evidence was obtained.'
            : 'The returned fields can be cited exactly. A description can support a clearly bounded design inference. It does not prove audience or effect.',
      status === 'needs_input', empty ? 'Do not repeat the same empty query. Adjust an explicit parameter, draft from evidence already saved, or pause with insufficient_evidence. Write the draft in English.' : undefined);
    execution = { ...execution, result: { ...execution.result, feedback } };
    action(project, 'query', project.mode === 'offline' ? 'Read synthetic demo data' : 'Run the official cultural research query',
      execution.result.status === 'error' ? (project.mode === 'live' ? 'The query failed and supplied no supporting design evidence. Further live queries are stopped' : 'The offline simulated query failed and supplied no supporting design evidence') : card?.relevant === false ? 'The result is irrelevant and cannot support the design' : 'Returned fields were kept so the model can separate facts from design inference',
      execution.result.status === 'error' ? 'error' : 'done');
    return execution;
  } };
}

export async function createProductRuntime(project, { env = process.env, decide = offlineDecision, diagnostic, qlooExecutor,
  memorySession = false, runtimeRoot } = {}) {
  if (diagnostic && typeof diagnostic.fetch !== 'function') throw new Error('The diagnostic requires a separate single-request boundary');
  const diagnosticState = diagnostic ? { modelCallbacks: 0, blockedModelCallbacks: 0, pausedToolNames: [], toolExecutionAttempts: 0 } : undefined;
  const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  const paths = resolveQlooPaths({ cwd: root, env: { QLOO_HOME: runtimeRoot ?? resolve(root, '.art-runtime', project.id) } });
  const modelRuntime = await ModelRuntime.create({ authPath: paths.authFile, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  let liveStream;
  if (project.mode === 'live') {
    const config = configStatus(env);
    if (!config.modes.live.available) throw new Error(`Live mode is disabled or its configuration is incomplete: ${config.modes.live.missing.join(', ')}`);
    // Literal import() specifiers so Vercel file tracing can pack the provider
    // modules. A runtime template string is invisible to the bundler.
    const liveStreams = {
      'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
      'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
      'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
    };
    liveStream = (await liveStreams[env.ART_MODEL_API]?.())?.streamSimple;
    if (typeof liveStream !== 'function') throw new Error('Only explicitly configured OpenAI-compatible completions/responses or Anthropic messages are supported');
  }
  const provider = project.mode === 'offline' ? `offline-${project.id}` : env.ART_MODEL_PROVIDER;
  const modelId = project.mode === 'offline' ? 'synthetic-design-fixture' : env.ART_MODEL_ID;
  // One app budget for both SDK output clamping and local request checks.
  const officialFlash = project.mode === 'live' && modelId === 'deepseek-flash' && env.ART_MODEL_API === 'openai-completions'
    && URL.canParse(env.ART_MODEL_BASE_URL) && new URL(env.ART_MODEL_BASE_URL).origin === 'https://api.deepseek.com';
  modelRuntime.registerProvider(provider, { api: project.mode === 'offline' ? 'art-offline-fixture' : env.ART_MODEL_API,
    baseUrl: project.mode === 'offline' ? 'https://offline.invalid' : env.ART_MODEL_BASE_URL,
    apiKey: project.mode === 'offline' ? 'synthetic-local-only' : env.ART_MODEL_API_KEY,
    streamSimple(model, context, options) {
      if (diagnosticState) {
        if (diagnosticState.modelCallbacks >= 1) {
          diagnosticState.blockedModelCallbacks++;
          throw new Error('The diagnostic forbids a second model call');
        }
        diagnosticState.modelCallbacks++;
      }
      if (!diagnostic && project.mode === 'live' && remainingBudget(project).modelHttpAttempts === 0)
        throw recordLocalFailure(project, 'model', 'MODEL_HTTP_BUDGET_EXHAUSTED', 'The model HTTP budget is exhausted. The request was blocked locally.');
      project.usage.modelCalls++;
      // Preserve the default's twelve local-only callbacks without resetting cumulative usage.
      const callbackLimit = Math.min(Number.MAX_SAFE_INTEGER, (project.mode === 'live'
        ? remainingBudget(project).caseLimits.modelHttpAttempts : LIMITS.modelHttpAttempts) + 2 * LIMITS.modelHttpAttempts);
      if (project.usage.modelCalls > callbackLimit)
        throw recordLocalFailure(project, 'model', 'MODEL_CALLBACK_BUDGET_EXHAUSTED', 'The project model-turn limit is reached. The run paused and the current state was kept');
      if (project.mode === 'offline') {
        const read = context.messages.filter(m => m.role === 'toolResult');
        read.forEach(m => { toolText(m); });
        project.runtime.modelResultReads += read.length;
        return syntheticStream(model, decide(context, snapshotProject(project)));
      }
      let working = context;
      let budget = requestBudget(working, model);
      if (!budget.fits) {
        working = { ...context, messages: compactToolMessages(context.messages, project) };
        budget = requestBudget(working, model);
      }
      const capacity = { model: model.id, ...budget, finalMaxTokens: null };
      project.runtime.generationBudget = capacity;
      if (!capacity.fits) throw recordLocalFailure(project, 'model', 'MODEL_CONTEXT_CAPACITY_INSUFFICIENT',
        contextCapacityReason(capacity));
      const stream = () => liveStream(model, working,
        { ...options, apiKey: env.ART_MODEL_API_KEY, transport: 'sse', maxRetries: 0, fetch: diagnostic?.fetch ?? globalThis.fetch,
          async onPayload(payload, payloadModel) {
            const updated = await options.onPayload?.(payload, payloadModel);
            const finalPayload = updated ?? payload;
            if (project.revisionRequest?.status === 'running' && model.api === 'openai-completions'
              && new URL(model.baseUrl).origin === 'https://api.deepseek.com')
              finalPayload.thinking = { type: 'disabled' };
            Object.assign(capacity, requestBudget(finalPayload, model));
            capacity.finalMaxTokens = modelOutputLimit(finalPayload);
            if (!capacity.fits || capacity.finalMaxTokens !== model.maxTokens)
              throw recordLocalFailure(project, 'model', 'MODEL_CONTEXT_CAPACITY_INSUFFICIENT',
                !capacity.fits ? contextCapacityReason(capacity) : 'The final model output capacity does not match its configuration. The request was stopped locally.');
            return finalPayload;
          } });
      return diagnostic ? stream() : withHttpBudget(project, 'model', env.ART_MODEL_BASE_URL, stream,
        [env.ART_MODEL_API_KEY, env.QLOO_API_KEY]);
    },
    models: [{ id: modelId, name: project.mode === 'offline' ? 'Offline synthetic design model' : modelId,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: officialFlash ? 65536 : 32000, maxTokens: 12000 }] });
  let officialExecutor;
  if (qlooExecutor) officialExecutor = qlooExecutor;
  else if (project.mode === 'offline') {
    officialExecutor = createDelegatingQlooWorkflowExecutor({ transport: { kind: 'direct', name: 'local-synthetic-fixture', remote: false },
      async invoke(operation) {
        if (project.scenario === 'failure') return { schema_version: '1.0-preview.1', operation, status: 'error',
          summary: 'The offline simulated query failed; no live request was sent', results: [], error: { code: 'OFFLINE_FIXTURE_FAILURE', retryable: false } };
        return { schema_version: '1.0-preview.1', operation, status: 'ok', synthetic: true,
          summary: fixture.label, results: structuredClone(fixture[project.scenario]) };
      } });
  } else {
    officialExecutor = createDirectQlooWorkflowExecutorFromEnvironment({
      env: { QLOO_API_KEY: env.QLOO_API_KEY, QLOO_BASE_URL: env.QLOO_API_URL, QLOO_TRUSTED_BASE_URL: env.QLOO_API_URL },
      configPath: paths.configFile, readConfigFile: () => '', executionObserver: {} });
    if (!officialExecutor) throw new Error('The official Qloo executor has no credentials');
  }
  const executor = wrapProjectExecutor(project, officialExecutor, env);
  const tools = createQlooTools({ executor }).filter(t => TOOL_NAMES.includes(t.name));
  tools.push({ name: 'read_project_evidence', label: 'Read a saved evidence field in this project',
    description: 'Read saved evidence in this project, without HTTP or state changes. Supply evidenceId alone (plus optional offset) for at most 12 entity identities and nextOffset; supply entityId and entity-relative dotted field path for one saved entity field, e.g. properties.description or affinity. Without entityId, field may only be query or a query.* path on this evidence card, e.g. query.input.signals.0. Exact fields are limited to 6000 serialized characters. Only status ok and exact true is an exact citable value; missing or too_large previews must not be cited as a complete field. Cannot read another project, arbitrary card/project fields, files or URLs.',
    parameters: Type.Object({ evidenceId: Type.String(), entityId: Type.Optional(Type.String({ description: 'Required for returned-entity fields; omit only for the entity index or allowlisted card query paths.' })),
      field: Type.Optional(Type.String({ description: 'Entity-relative dotted field with entityId; only query or query.* without entityId. Numeric array indices are allowed; file, URL and prototype paths are forbidden.' })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
    async execute(_id, input) {
      const result = readProjectEvidence(project, input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } });
  let submittedRevisionId = null;
  tools.push({ name: 'propose_concept_revision', label: 'Propose a partial pending revision',
    description: 'Propose changes only to the server-bound selected concept and base version. Compare after with the selected concept in project.concepts; for pending_feedback compare with currentPendingDraft. Omit unchanged fields, including evidenceLinks and unverifiedEffects, and never repeat a field. Omitted fields retain their current values. Preserve unaffected entries and conditions within changed fields. Never submit project identity, target identity, base version, before values, full projects or concepts. Confirmed content is immutable until user acceptance. Return pending changes with reasons, exact existing evidence references, impact and unknowns, or needs_input/conflict with exactly one question and no changes. Evidence description/short_description can support explicitly marked design inference; affinity is only cultural association and cannot support description claims or effect scores. Existing historical evidence links must be preserved; do not repair or revalidate unrelated content. Structural example only; replace placeholders with actual allowed changes and exact saved evidence values: {"phase":"pending","summary":"<revision-summary>","changes":[{"field":"evidenceLinks","after":[{"evidenceId":"<card-id>","entityId":"<returned-entity-id>","observedField":"properties.description","observedValue":"<complete-actual-field-value>","observation":"<actual-observation>","inspiration":"<explicit-design-inference>"}],"reason":"<reason-for-this-change>","evidenceRefs":[{"evidenceId":"<card-id>","entityId":"<returned-entity-id>","observedField":"properties.description","observedValue":"<complete-actual-field-value>","inspiration":"<explicit-design-inference>"}]}],"impact":["<scope-and-consequences>"],"unknowns":["<actual-unverified-condition>"]}. Every changes item, especially evidenceLinks, must have all four keys field, after, reason, evidenceRefs; reason and evidenceRefs are siblings of after. The required top-level impact and unknowns arrays must also be present.',
    parameters: revisionSchema,
    async execute(_id, input) {
      let result;
      const issue = schemaIssue(revisionSchema, input);
      try {
        if (issue) throw Object.assign(new Error('The partial revision arguments are structurally invalid. Do not submit the project, target, base version, or before values.'),
          { feedback: { code: 'REVISION_SCHEMA_INVALID', path: issue.path, reason: 'The partial revision arguments are structurally invalid. Correct them using the allowed fields, in English.', correctable: true } });
        result = proposeRevision(project, { ...input, requestId: submittedRevisionId });
        action(project, 'revision', result.status === 'pending' ? 'Created a pending partial revision' : 'Partial revision needs confirmation', input.summary);
        result = { accepted: false, completed: true, revisionId: result.id ?? null, status: result.status,
          feedback: toolFeedback(project, 'REVISION_RESPONSE_SAVED', '/', 'The partial revision response was saved. The confirmed version is unchanged until the user approves it.', false) };
      } catch (error) {
        const rejected = error.feedback ?? { code: 'REVISION_INVALID', path: '/', reason: 'The partial revision failed validation. The confirmed version is unchanged.', correctable: true };
        result = { accepted: false, status: 'error', feedback: toolFeedback(project, rejected.code, rejected.path, rejected.reason,
          rejected.correctable, revisionCorrection, issue) };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } });
  tools.push({ name: 'propose_design_response', label: 'Propose a structured design response',
    description: 'Only updates the bound current project after version, actual evidence field references, and literal constraints pass. Never submit projectId. questions may be omitted or [] unless phase is needs_input, which requires exactly one {field,text} question with nonempty text. field must be request, brand, goal, references, venue, budget, mustKeep, or avoid. Ready requires two distinct mechanisms; insufficient evidence may pause with zero concepts or show two unsupported drafts.',
    parameters: proposalSchema,
    async execute(_id, input) {
      let result;
      const issue = schemaIssue(proposalSchema, input);
      if (issue) {
        result = { accepted: false, status: 'error', feedback: toolFeedback(project, 'PROPOSAL_SCHEMA_INVALID', issue.path,
          'The proposal arguments are structurally invalid. Correct the field types and do not submit a project id. Write the corrected proposal in English.', true, undefined, issue) };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
      try { result = applyProposal(project, { ...input, projectId: project.id }); }
      catch (error) {
        const rejected = error.feedback ?? { code: 'PROPOSAL_INVALID', path: '/', reason: 'The proposal failed validation. The project was not changed.', correctable: true };
        result = { accepted: false, status: 'error', feedback: toolFeedback(project, rejected.code, rejected.path, rejected.reason,
          rejected.correctable, 'Correct the proposal fields at the feedback path and retry. Do not invent a project, evidence, or citation. Write the proposal in English.', businessDiagnostic(project, input, rejected.path)) };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
      action(project, 'proposal', input.phase === 'needs_input' ? 'Asked a key clarification' : 'Created concepts for discussion', input.summary);
      result.feedback = toolFeedback(project, 'PROPOSAL_ACCEPTED', '/', 'The proposal passed structure, version, citation, and literal-constraint checks. That is not a judgment of design quality or product acceptance.', false, 'The proposal is saved. Wait for the user to review it.');
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } });
  const sessionDirectory = resolve(root, '.art-runtime', project.id, 'sessions');
  const savedSession = memorySession ? null : project.runtime.sessionFile;
  const priorSession = savedSession && resolve(savedSession).startsWith(sessionDirectory + sep) && existsSync(savedSession);
  let researchCarry = memorySession ? structuredClone(project.runtime.openResearchQuestions ?? []) : [];
  for (const saved of new Set([...(memorySession ? [] : project.runtime.sessionHistory ?? []), savedSession].filter(Boolean))) {
    if (!resolve(saved).startsWith(sessionDirectory + sep) || !existsSync(saved)) continue;
    // Parsing and building a context are public pure helpers; SessionManager.open
    // can migrate and rewrite old files, so do not open a closed session to read it.
    const savedText = readFileSync(saved, 'utf8');
    const entries = parseSessionEntries(savedText);
    if (entries.length !== savedText.split(/\r?\n/).filter(line => line.trim()).length)
      throw new Error('The saved project session contains unreadable records. Stopped and kept the original files.');
    researchCarry = unresolvedResearch(buildSessionContext(entries.filter(entry => entry.type !== 'session')).messages, researchCarry);
  }
  const sessionManager = memorySession ? SessionManager.inMemory(root) : project.mode === 'offline' && priorSession
    ? SessionManager.open(savedSession, sessionDirectory) : SessionManager.create(root, sessionDirectory);
  if (project.mode === 'live' && priorSession)
    (project.runtime.sessionHistory ??= []).push(savedSession);
  const limits = remainingBudget(project);
  const liveBudgetDescription = `Each project may make at most ${limits.caseLimits.modelHttpAttempts} model HTTP requests and ${limits.caseLimits.qlooHttpAttempts} Qloo HTTP requests${limits.sharedLimits.modelHttpAttempts === null ? '' : `, and this service may make at most ${limits.sharedLimits.modelHttpAttempts} model and ${limits.sharedLimits.qlooHttpAttempts} Qloo HTTP requests in total`}. Retries count.`;
  const runtime = await createPiHarnessRuntime({ cwd: root, paths, profile: 'explore', modelRuntime,
    sessionManager,
    resources: { systemPrompt: `You are the brand pop-up experience design agent. Write every user-visible string in English: summaries, questions, concept titles, claims, mechanisms, journeys, product touchpoints, reasons, impact, unknowns, and assistant replies. Do this even when the client brief or feedback is in another language. Do not write Chinese in tool arguments or assistant text. project.brief.request is the original request and must not be overwritten. project.clarifications is a bounded view of relevant questions and answers; clarificationHistory gives the total and how many were omitted. Supplements to the original request are kept in full. Earlier structured answers may be omitted; omission does not revoke those conditions. Current fields follow the brief and explicit edits. If ambiguity would change the next decision, ask. An ordinary reply adds to the original request and does not replace conditions that were not mentioned. Vague replies such as "either is fine" or "follow your suggestion" do not relax city, budget, must-keep, or avoid constraints. Only revisesRequest:true means the user explicitly changed that condition in the original request; apply that explicit wording and keep every other condition. When briefUpdate.explicit is true, before is the historical value and after is the current explicit value. Current structured fields follow project.brief. Do not restore a condition that was explicitly revoked. If free text with revisesRequest conflicts with a current structured condition and there is no matching briefUpdate, do not claim the condition was relaxed. Ask the user to confirm that field with the explicit edit control. Work only on the current project. Initial research uses the official research tools and propose_design_response. After confirmed concepts exist, propose changes only through propose_concept_revision. On every turn, read the user input in project.revisionRequest together with the server-bound target and base version, and judge independently whether this is a revision, a clarification, or a conflict. Do not choose a fixed reply from keywords. If revisionRequest.kind is pending_feedback, project.concepts is the original confirmed content. currentPendingRevision keeps the pending metadata and each item's field, reason, and evidenceRefs. before and after for a change are the matching fields of the confirmed concept and currentPendingDraft. currentPendingDraft is the complete pending concept currently shown. Historical draftDelta stays in the authoritative record and is not repeated in this view. Continue revising that pending draft from this feedback. changes must contain only real differences from currentPendingDraft. The server keeps unmentioned pending edits and merges them into the new draft. When replacing a whole field, keep entries, conditions, and constraints inside it that the feedback does not affect. impact and unknowns must cover the still-valid effects and unknown conditions of the merged draft. You may state a clarification or a conflict. Do not invent a resolution in order to succeed. A partial revision must not query Qloo, replace both concepts, edit another concept, edit the brief, or edit historical evidence. Change only affected fields. Preserve must-keep items and locked fields. When the reason to arrive, time structure, activity, product contact, or takeaway is affected, update them together. Separate an actual returned description, a cultural affinity association, a design inference, and an unverified effect. Descriptive facts must cite the exact description or short_description. affinity is only this request's cultural association. It cannot stand in for a description, a design score, or an effect prediction. Do not repair historical citations in this turn. Decide whether to clarify, query, compare, or pause according to need. Do not force a fixed pipeline. A client's cultural references are research signals only. A proxy for an unknown brand requires the user's confirmation. When evidence is missing, say so. The two concepts must differ in how people participate. Different organization strings are only a mechanical check, not proof of a substantive difference. ${project.mode === 'offline' ? fixture.label : liveBudgetDescription}`,
      exploreInstructions: 'Every user input is brief text. Do not switch profile. Do not call files, a shell, or any unauthorized tool. Change concepts and questions only through the constrained proposal tools. All text you write for the user must be English. For the first study, name one concrete question that would change the participation structure or how people meet the product, and keep a short record in propose_design_response.summary: the research question, whether a description is enough, the query choice, the actual result, and the specific design effect. describe is enough only to check an entity identity or an existing attribute. It does not complete association research. If the question needs entities beyond the given references, describe is not enough: when the budget allows, use qloo_recommend and combine the confirmed signals for that one question, starting from the smallest set that can answer it. If a result lacks a description that can support a content claim, describe only as needed. An association does not replace the work itself. Association strength is not a design score, an audience profile, or an effect. If the result cannot support the design choice, say the evidence is insufficient, ask, or pause. Do not treat the number of calls as proof that research is finished. Each tool response includes the remaining HTTP budget and a next step. The balance shown to you was taken before the current read is counted and includes this model request, so it is not the number of requests still available afterward. If Qloo has stopped or the remaining count is 0, do not query again. You may submit a draft that marks facts, inferences, and unknowns from exact fields already described, or pause. Do not force recommend or affinity. Describing a name usually costs 2 HTTP requests. Recommending from N signals may cost N resolution requests plus 1 insights request. Cache hits and retries change the cost. Use the actual remaining budget.' },
    customTools: diagnostic ? tools.map(tool => ({ ...tool, async execute() {
      diagnosticState.toolExecutionAttempts++;
      throw new Error('Diagnostic paused: research and proposal tools are forbidden');
    } })) : tools });
  const session = runtime.sessionRuntime.session;
  let submittedMessage;
  session.setAutoRetryEnabled(false);
  if (project.mode === 'live') session.setAutoCompactionEnabled(false);
  if (diagnostic) {
    session.setAutoCompactionEnabled(false);
    // Public pi-agent-core hooks, documented in its installed README. Every call
    // is blocked, including siblings in a parallel batch. The turn stop hook
    // also covers unknown tools or invalid arguments rejected before preflight.
    session.agent.beforeToolCall = async ({ toolCall }) => {
      diagnosticState.pausedToolNames.push(TOOL_NAMES.includes(toolCall.name) ? toolCall.name : 'unknown');
      return { block: true, reason: 'The DeepSeek diagnostic paused before tool execution', terminate: true };
    };
    session.agent.shouldStopAfterTurn = async () => true;
  } else {
    // These are public Agent hooks (installed pi-agent-core README). Schema
    // preflight failures skip before/afterToolCall, so transform a copy of the
    // outgoing context as well; never edit session history or replace dispatch.
    const originalBeforeToolCall = session.agent.beforeToolCall;
    const originalAfterToolCall = session.agent.afterToolCall;
    const originalTransformContext = session.agent.transformContext;
    const originalShouldStop = session.agent.shouldStopAfterTurn;
    const rejectedCalls = new Map();
    session.agent.beforeToolCall = async context => {
      const schema = context.toolCall.name === 'propose_design_response' ? proposalSchema
        : context.toolCall.name === 'propose_concept_revision' ? revisionSchema : null;
      if (schema && schemaIssue(schema, context.toolCall.arguments))
        return { block: true, reason: 'The proposal arguments have an invalid structure. Correct them using the tool feedback.' };
      return originalBeforeToolCall?.(context);
    };
    session.agent.afterToolCall = async (context, signal) => {
      const previous = await originalAfterToolCall?.(context, signal);
      const result = { ...context.result, ...previous };
      const details = result.details;
      if (['qloo_describe', 'qloo_recommend'].includes(context.toolCall.name) && details) {
        const view = qlooResultView(details, project);
        // Raw details stay in the saved tool result; only content.text is model-facing.
        return { ...previous, content: [{ type: 'text', text: JSON.stringify(view) }], isError: context.isError || details.status === 'error' };
      }
      if (details?.feedback) return { ...previous, isError: context.isError || details.status === 'error' };
      if (context.isError) {
        const feedback = toolFeedback(project, 'TOOL_EXECUTION_ERROR', '/', 'The tool failed. No usable result was obtained.');
        const safe = { status: 'error', feedback };
        return { ...previous, content: [{ type: 'text', text: JSON.stringify(safe) }], details: safe, isError: true };
      }
      return previous;
    };
    const schemaRejection = event => {
      const definition = session.getToolDefinition(event.toolName);
      const issue = definition ? schemaIssue(definition.parameters, event.args) : null;
      return toolFeedback(project, issue ? (event.toolName === 'propose_design_response' ? 'PROPOSAL_SCHEMA_INVALID'
        : event.toolName === 'propose_concept_revision' ? 'REVISION_SCHEMA_INVALID' : 'QLOO_ARGUMENTS_INVALID')
        : definition ? 'TOOL_EXECUTION_ERROR' : 'TOOL_NOT_ALLOWED', issue?.path ?? '/',
      issue ? 'The tool arguments failed structural validation. Correct the path and expected type, in English.' : 'The tool is not allowed or failed. No usable result was obtained.',
      Boolean(issue), event.toolName === 'propose_concept_revision' ? revisionCorrection : undefined,
      issue ?? valueDiagnostic(event.args, '/', 'allowed tool arguments'));
    };
    // Subscription observes immediate errors before the next context transform.
    session.subscribe(event => {
      if (event.type === 'tool_execution_start') rejectedCalls.set(event.toolCallId, schemaRejection(event));
      if (event.type === 'tool_execution_end' && event.isError && !event.result?.details?.feedback) {
        const feedback = rejectedCalls.get(event.toolCallId) ?? schemaRejection(event);
        rejectedCalls.set(event.toolCallId, feedback);
        project.runtime.feedback = feedback;
      }
    });
    session.agent.transformContext = async (messages, signal) => {
      const transformed = originalTransformContext ? await originalTransformContext(messages, signal) : messages;
      return transformed.map(message => {
        const feedback = message.role === 'toolResult' && (message.details?.feedback
          ?? (message.isError && rejectedCalls.get(message.toolCallId)));
        if (!feedback) {
          if (['qloo_describe', 'qloo_recommend'].includes(message.toolName) && message.details)
            return { ...message, content: [{ type: 'text', text: JSON.stringify(qlooResultView(message.details, project)) }] };
          return message;
        }
        const safe = { ...(message.details?.feedback ? message.details : { status: 'error' }),
          feedback: toolFeedback(project, feedback.code, feedback.path, feedback.reason, feedback.correctable, feedback.nextAction, feedbackFields(feedback)) };
        const view = ['qloo_describe', 'qloo_recommend'].includes(message.toolName) ? qlooResultView(safe, project) : safe;
        return { ...message, content: [{ type: 'text', text: JSON.stringify(view) }], details: safe };
      });
    };
    session.agent.shouldStopAfterTurn = async (context, signal) => {
      if (await originalShouldStop?.(context, signal)) return true;
      if (pendingReference(project)) { referenceQuestion(project); return true; }
      if (context.toolResults.some(result => result.details?.accepted === true || result.details?.completed === true)) return true;
      if (project.mode === 'live' && (liveRunStopped(project)
        || (project.runtime.failure && project.runtime.failure.kind !== 'qloo')
        || (project.runtime.localFailure && project.runtime.localFailure.kind !== 'qloo')
        || ['error', 'aborted'].includes(context.message.stopReason))) return true;
      if (project.mode === 'live' && remainingBudget(project).modelHttpAttempts === 0) {
        const previous = project.runtime.feedback;
        project.runtime.feedback = previous && previous.code !== 'QLOO_RESULT_AVAILABLE'
          ? toolFeedback(project, previous.code, previous.path, previous.reason, previous.correctable, undefined, feedbackFields(previous))
          : toolFeedback(project, 'MODEL_HTTP_BUDGET_EXHAUSTED', '/', 'The model HTTP budget is exhausted. No validated proposal was saved. The current state is kept.');
        return true;
      }
      return false;
    };
  }
  const sanitizedContext = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const safe = sanitizedContext ? await sanitizedContext(messages, signal) : messages;
    researchCarry = unresolvedResearch(safe, researchCarry);
    if (memorySession) project.runtime.openResearchQuestions = structuredClone(researchCarry);
    try { return assembleContext(safe, snapshotProject(project), submittedMessage, researchCarry); }
    catch (error) {
      if (error.code === 'MODEL_CONTEXT_PROTOCOL_INCOMPLETE')
        throw recordLocalFailure(project, 'model', error.code, error.message);
      throw error;
    }
  };
  session.setActiveToolsByName(TOOL_NAMES);
  await session.setModel(modelRuntime.getModel(provider, modelId));
  project.runtime.sessionId = session.sessionId;
  project.runtime.sessionFile = sessionManager.getSessionFile();
  project.runtime.toolNames = session.getActiveToolNames();
  const redactArguments = value => {
    if (typeof value === 'string') {
      for (const key of ['ART_MODEL_API_KEY', 'QLOO_API_KEY']) if (env[key]) value = value.split(env[key]).join('[REDACTED]');
      return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    }
    if (Array.isArray(value)) return value.map(redactArguments);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, /key|token|secret|authorization|password/i.test(key) ? '[REDACTED]' : redactArguments(item)]));
    return value;
  };
  session.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'length'
      && !event.message.content.some(block => block.type === 'toolCall' || (block.type === 'text' && block.text.trim()))) {
      project.runtime.failure = { kind: 'model', code: 'MODEL_OUTPUT_LENGTH_EMPTY', status: null, stopReason: 'length',
        summary: 'The model reached its output limit without usable text or a tool call. Confirmed content and pending drafts are unchanged.' };
      stopLiveRun(project, project.runtime.failure);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && ['error', 'aborted'].includes(event.message.stopReason)) {
      project.runtime.failure = safeRuntimeFailure(project, 'model', event.message.stopReason);
      stopLiveRun(project, project.runtime.failure);
    }
    if (event.type === 'tool_execution_start') {
      project.usage.toolCalls++;
      const record = action(project, 'tool', event.toolName, 'The official runtime requested a tool', 'running');
      record.toolCallId = event.toolCallId;
      if (['qloo_describe', 'qloo_recommend'].includes(event.toolName)) record.arguments = redactArguments(event.args);
    }
    if (event.type === 'tool_execution_end') {
      const pending = project.actions.find(a => a.type === 'tool' && a.toolCallId === event.toolCallId && a.status === 'running');
      if (pending) {
        const result = event.result?.details;
        const failed = event.isError || result?.status === 'error';
        pending.status = failed ? 'error' : 'done';
        pending.detail = failed ? 'The tool was rejected or failed; it was not treated as successful evidence' : 'The structured result was returned to the model through content.text';
        if (result?.feedback || (failed && project.runtime.feedback)) {
          pending.feedback = result?.feedback ?? project.runtime.feedback;
          project.runtime.feedback = pending.feedback;
        }
        if (['qloo_describe', 'qloo_recommend'].includes(event.toolName)) pending.result = {
          status: result?.status ?? (failed ? 'error' : 'unknown'),
          resultCount: Array.isArray(result?.results) ? result.results.length : 0,
          ...(failed ? { error: { code: pending.feedback?.code ?? 'TOOL_EXECUTION_ERROR', status: null, summary: pending.feedback?.reason ?? pending.detail } } : {}),
        };
      }
    }
  });
  return { session, paths, ...(diagnostic ? { diagnostic: diagnosticState } : {}), async submit(message) {
    const started = Date.now();
    const previousVersion = project.version;
    const revisionRequest = project.revisionRequest?.status === 'running' ? project.revisionRequest : null;
    submittedRevisionId = revisionRequest?.id ?? null;
    const activeTools = revisionRequest ? REVISION_TOOL_NAMES : TOOL_NAMES;
    submittedMessage = message;
    const freshSession = () => {
      (project.runtime.sessionHistory ??= []).push(sessionManager.getSessionFile());
      sessionManager.newSession();
      session.agent.reset();
      session.agent.sessionId = sessionManager.getSessionId();
      project.runtime.sessionId = session.sessionId;
      project.runtime.sessionFile = sessionManager.getSessionFile();
    };
    if (project.mode === 'live' && session.messages.length) freshSession();
    session.setActiveToolsByName(activeTools);
    project.runtime.toolNames = session.getActiveToolNames();
    try {
      await withoutNetwork(project, () => withPiAgentDirectory(paths.agentDir, () => withPiPrivacyDefaults(async () => {
        await session.prompt(JSON.stringify({ project: snapshotProject(project), message }),
          { expandPromptTemplates: false, source: 'rpc' });
        await session.waitForIdle();
      })));
    } catch (error) {
      project.runtime.failure ??= safeRuntimeFailure(project, 'model');
      stopLiveRun(project, project.runtime.failure);
      if (revisionRequest?.status === 'running') finishRevisionRequest(project, revisionRequest, 'error', project.runtime.failure.summary);
      throw error;
    } finally {
      if (memorySession) project.runtime.openResearchQuestions = unresolvedResearch(session.messages, researchCarry);
      project.runtime.totalLatencyMs = (project.runtime.totalLatencyMs ?? 0) + Math.max(0, Date.now() - started);
      const feedback = project.runtime.feedback;
      if (feedback) project.runtime.feedback = toolFeedback(project, feedback.code, feedback.path, feedback.reason,
        feedback.correctable, feedback.nextAction, feedbackFields(feedback));
    }
    session.setActiveToolsByName(activeTools);
    const last = session.getLastAssistantText();
    if (last) project.messages.push({ role: 'assistant', text: last });
    if (revisionRequest && revisionRequest.status === 'running') {
      finishRevisionRequest(project, revisionRequest, 'error', project.runtime.failure?.summary ?? project.runtime.feedback?.reason
        ?? 'This run produced no valid partial revision. Confirmed content and the original pending draft are unchanged.');
      project.status = { phase: 'error', detail: revisionRequest.detail };
    } else if (project.version === previousVersion && project.status.phase === 'busy') {
      const feedback = project.runtime.feedback;
      project.status = { phase: !project.runtime.failure && ['QLOO_EMPTY', 'EVIDENCE_INSUFFICIENT'].includes(feedback?.code) ? 'insufficient_evidence' : 'error',
        detail: project.runtime.failure?.summary ?? feedback?.reason ?? 'This run produced no validated proposal. The current state was kept' };
    }
    return project;
  }, abort: () => session.abort(), dispose: () => runtime.dispose() };
}
