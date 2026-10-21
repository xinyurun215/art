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
import { withHttpBudget, withoutNetwork, validationRun, stopLiveRun, safeRuntimeFailure,
  remainingBudget, toolFeedback, recordLocalFailure, modelOutputLimit } from './transport.mjs';
import { evidenceView, readProjectEvidence, qlooResultView, compactToolMessages, unresolvedResearch, assembleContext, requestBudget, clarificationView } from './context.mjs';
import { pendingReference, referenceQuestion, observeReferenceResolution, bindReferenceInputs, referenceResolutionView } from './references.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/culture-signals.json', import.meta.url)));
export const TOOL_NAMES = Object.freeze(['qloo_describe', 'qloo_recommend', 'propose_design_response', 'read_project_evidence']);
export const REVISION_TOOL_NAMES = Object.freeze(['propose_concept_revision', 'read_project_evidence']);
const toolText = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
const contextCapacityReason = budget => `完整请求的离线估算超过本地上下文预算 ${budget.overByTokens} 个词元；最大组成是${
  { system: '系统指令', work: '当前工作状态', history: '最近工具回合', tools: '工具定义', wrappers: '请求包装字段' }[budget.largestComponent]}。已保留输出和安全余量，本地停止并保留状态。`;
const projectEvidenceReference = reference => {
  const { observation, ...fields } = reference;
  const derived = `实际返回 ${reference.observedField} = ${JSON.stringify(reference.observedValue)}；${reference.basis === 'affinity'
    ? '仅为本次请求的文化亲和关联，不是描述、设计评分或效果预测。' : reference.basis === 'description'
      ? '这是实体描述，不是文化亲和关联分数或受众效果证据。' : '仅能证明该字段实际返回。'}`;
  return observation === derived ? fields : reference;
};
const snapshotProject = project => {
  const clarification = clarificationView(project);
  if (clarification.independentLimitExceeded) throw recordLocalFailure(project, 'model', 'MODEL_CONTEXT_CLARIFICATION_LIMIT',
    '项目已有超过12项独立澄清；不能安全省略仍有效条件，本地暂停并保留完整项目记录。');
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
    evidenceRefs: Type.Array(revisionReferenceSchema, { description: 'Required array of exact existing evidence references for this individual change, including an evidenceLinks change. This is a sibling of after; never omit it or move it inside after. Use [] when this change cites no evidence.' }) }, { additionalProperties: false })),
  impact: Type.Array(Type.String(), { description: 'Required top-level array describing the scope and consequences of these changes. Always include impact, even when the array is empty; do not place it inside a change.' }),
  unknowns: Type.Array(Type.String(), { description: 'Required top-level array of actual unverified conditions. A pending revision needs at least one unknown; needs_input/conflict may use []. Never omit unknowns or present an unverified condition as resolved.' }) }, { additionalProperties: false });

// A named, explicitly selected fixture exercises official model/tool dispatch.
// It makes no claim to understand arbitrary feedback or generate a live design.
export function offlineRevisionDecision(context, snapshot) {
  const userIndex = context.messages.findLastIndex(message => message.role === 'user');
  const results = context.messages.slice(userIndex + 1).filter(message => message.role === 'toolResult');
  if (results.length) return [{ type: 'text', text: '离线修改夹具已执行；请查看服务端校验结果与待审差异。不是实际模型理解或效果验证。' }];
  const request = snapshot.revisionRequest;
  const fixtureName = request?.offlineFixture;
  const response = { phase: 'needs_input', summary: '离线模式不能解释任意反馈；正式内容保持不变。',
    question: '如需验证局部修改流程，请显式选择离线测试夹具；真实语义处理需另行授权并配置真实模型。',
    changes: [], impact: [], unknowns: ['未验证真实模型对本次输入的理解与设计质量。'] };
  if (fixtureName === 'conflict') Object.assign(response, { phase: 'conflict',
    summary: '离线冲突夹具：试穿必须保留与删除所有产品接触之间存在冲突。',
    question: '请确认是否保留原先必须保留的试穿要求；未确认前不修改正式方案。' });
  if (fixtureName === 'needs_input') Object.assign(response, { summary: '离线澄清夹具：参与容量会影响双人组织。',
    question: '每轮允许同时参与多少人？未知时可以明确标为待确认。' });
  if (['pair_45', 'invalid_reference'].includes(fixtureName)) {
    const target = snapshot.concepts.find(concept => concept.id === request.targetConceptId);
    const references = [];
    for (const card of snapshot.evidence) {
      if (card.projectId !== snapshot.id || card.relevant === false) continue;
      for (const entity of card.returnedEntities ?? []) {
        const entry = Object.entries(entity.properties ?? {}).find(([key, value]) => /^(short_|long_)?description$/.test(key) && typeof value === 'string' && value.trim());
        if (entry) references.push({ evidenceId: card.id, entityId: entity.id ?? entity.entity_id,
          observedField: `properties.${entry[0]}`, observedValue: entry[1], basis: 'description',
          inspiration: '设计推断：实际实体描述仅作为匿名身份与穿者/记录者角色配对的创意参考；不证明尺码适配、库存、试穿时长或任何效果。' });
      }
    }
    if (fixtureName === 'invalid_reference') references.splice(0, references.length, { evidenceId: 'offline-intentionally-missing',
      entityId: 'offline-missing', observedField: 'properties.description', observedValue: '这是故意无效的离线引用',
      inspiration: '仅用于验证服务端拒绝，不是证据。' });
    const contact = snapshot.brief.mustKeep.length ? snapshot.brief.mustKeep.join('、') : '产品试穿';
    const sizeAllocation = '先分别确认两人各自适配尺码，每人独立分配一双；只换角色、不换鞋；库存缺码或数量不足时暂停本对试穿并披露库存冲突，不用不合脚鞋或同一双鞋替代';
    const ownSizeTouchpoint = `真实上脚${contact}：${sizeAllocation}。`;
    let replacedAllocation = false;
    const productTouchpoints = target.productTouchpoints.map(item => {
      if (item.includes('每对一双') && item.includes('轮换')) {
        replacedAllocation = true;
        return item.replace(/每对一双轮换(?:[，,]含半码备用)?/, sizeAllocation);
      }
      return item;
    });
    if (!replacedAllocation && !productTouchpoints.includes(ownSizeTouchpoint)) productTouchpoints.push(ownSizeTouchpoint);
    const stockQuestion = '尺码库存前置条件：尚未核实两人的适配尺码与各自可分配双数；若缺码或数量不足，暂停本对试穿并明确披露库存冲突，请用户决定补齐、另约或取消，不宣称已经解决供货。';
    const openQuestions = target.openQuestions.map(item => item.includes('每对一双') || /尺码.*(?:库存|分布|双数)/.test(item) ? stockQuestion : item);
    if (!openQuestions.includes(stockQuestion)) openQuestions.push(stockQuestion);
    const timeQuestion = '0–5分钟能否完成独立量码与配鞋、两段各至少15分钟试穿及35–40分钟复测能否在原定人数下执行，需以实际库存、人员与现场容量验证；45分钟是设计时间分配，不是效果证据。';
    if (!openQuestions.includes(timeQuestion)) openQuestions.push(timeQuestion);
    const proposed = {
      mechanism: { organization: '双人匿名配对＋45分钟定时角色交换；保留原有批次人数与编号规则，只换角色、不换鞋',
        description: `保留双向复述：穿者由记录者依原有四问追问并记录，再互相复核。0–5分钟分别量码、确认两人各自适配尺码并独立配鞋；5–20分钟A穿自己的尺码、B记录，20–35分钟B穿自己的尺码、A记录，每人各至少15分钟；35–40分钟针对个人问题用自己的尺码复测；40–45分钟共同复核与离场。库存缺码或数量不足时暂停本对试穿并披露库存冲突，不让尺码不一致的人交换同一双鞋。45分钟及各段时长属于设计时间分配，不是适配或效果证据。` },
      journey: [{ stage: '独立量码与配鞋 · 0–5分钟', action: '保留原有匿名编号与记录规则；工作人员分别确认两人各自适配尺码，为每人准备适配的一双。若库存缺码或数量不足，暂停本对试穿、披露库存冲突，等待用户决定补齐或另约。' },
        { stage: 'A试穿、B记录 · 5–20分钟', action: `A穿自己适配尺码的一双完成至少15分钟${contact}，沿原方案产品体验路径完成动作；B依原有四问追问并记录，A不自行填写评价。` },
        { stage: 'B试穿、A记录 · 20–35分钟', action: `只换角色、不换鞋：B穿自己适配尺码的另一双完成至少15分钟${contact}，A依相同四问追问并记录；不得将A的鞋直接交给尺码不同的B。` },
        { stage: '各自尺码定向复测 · 35–40分钟', action: '针对记录中的个人问题，各用自己适配尺码复测；不以另一人的鞋或反馈替代本人适配判断。' },
        { stage: '互相复核与带走 · 40–45分钟', action: `两人按原有记录卡互相订正，保留原方案带走内容与匿名规则。${target.journey.at(-1)?.action ?? '各自带走个人记录。'}` }],
      productTouchpoints, openQuestions,
    };
    Object.assign(response, { phase: 'pending', summary: '离线测试夹具：45分钟双人试穿改为各自适配尺码独立配鞋；库存待确认，缺码则暂停。仅形成待审修改，不代表任意反馈语义理解。',
      changes: Object.entries(proposed).filter(([field, after]) => JSON.stringify(after) !== JSON.stringify(target[field])).map(([field, after]) => ({
        field, after, reason: ['mechanism', 'journey'].includes(field)
          ? '离线设计设定：保留匿名双向复述，只调整45分钟时间组织与每人独立尺码配鞋；实际描述仅支持角色配对的创意推断，不证明适配或效果。'
          : '运营设计推断：修正每对共用一双造成的尺码冲突，保留无关样块、材料垫与记录卡；独立配鞋依赖尚未核实的库存和容量。',
        evidenceRefs: ['mechanism', 'journey'].includes(field) ? references.slice(0, 1) : [] })),
      impact: ['仅调整独立量码配鞋、45分钟角色分段、试穿复测与相应库存/容量问题；保留标题、核心主张、历史证据、无关产品接触及带走内容。'],
      unknowns: ['实际尺码库存与每人可分配的一双尚未核实，缺码或不足须暂停并披露冲突。',
        '原定人数下量码、两段各15分钟试穿与复测的容量、人员及45分钟可执行性未经验证。',
        ...(references.length ? [] : ['现有证据没有可引用的实际描述字段；本夹具不新增描述事实。'])] });
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
  const required = snapshot.brief.mustKeep.length ? snapshot.brief.mustKeep : ['产品体验'];
  const contact = required.join('、');
  const entities = card?.returnedEntities ?? [];
  return [
    { id: `${snapshot.id}:concept-a`, title: '共同节拍 · 定时入场',
      coreClaim: '让到场者在同一时间完成一轮产品体验，共同参与而非等待观看。',
      mechanism: { organization: 'collective_scheduled', description: '小组按固定时段开始，由共同节拍组织动作任务；工作人员引导轮换和产品反馈。' },
      journey: [{ stage: '为什么来', action: '预约一场同伴共同参与的动作体验。' },
        { stage: '进来做什么', action: '按时段组队，通过共同节奏完成现场动作任务。' },
        { stage: '如何接触产品', action: `在动作任务中安排${contact}，现场记录感受。` },
        { stage: '带走什么', action: '带走个人体验笔记和本场共同完成的节奏记录。' }],
      productTouchpoints: [`${contact}：由工作人员协助体验并收集舒适度描述。`],
      evidenceLinks: entities[0] ? [{ evidenceId: card.id, entityId: entities[0].id,
        observedField: 'properties.participation', observedValue: entities[0].properties.participation,
        observation: `合成夹具返回 participation = ${entities[0].properties.participation}；不是真实受众事实。`,
        inspiration: '由共同节奏信号推导为定时、小组同步的参与组织；这是设计推断。' }] : [],
      openQuestions: ['时段容量、声音使用授权与工作人员配置尚待确认。'],
      unverifiedEffects: ['到场意愿、参与度和转化均未验证；不作效果预测。'] },
    { id: `${snapshot.id}:concept-b`, title: '个人片段 · 自主探索',
      coreClaim: '到场者按自己的节奏推进故事任务，用产品体验决定下一段叙事。',
      mechanism: { organization: 'individual_self_paced', description: '个人任选叙事起点，自主完成分散任务；无需等待统一开场，用产品反馈解锁下一段内容。' },
      journey: [{ stage: '为什么来', action: '选择一个个人叙事起点，探索自己的日常片段。' },
        { stage: '进来做什么', action: '自行选择任务顺序，并按个人节奏穿行各站。' },
        { stage: '如何接触产品', action: `完成${contact}后记录个人感受，用反馈推进故事。` },
        { stage: '带走什么', action: '带走自己的故事卡和产品体验记录。' }],
      productTouchpoints: [`${contact}：每一站设置一项可以自主完成的产品体验。`],
      evidenceLinks: entities[1] ? [{ evidenceId: card.id, entityId: entities[1].id,
        observedField: 'properties.participation', observedValue: entities[1].properties.participation,
        observation: `合成夹具返回 participation = ${entities[1].properties.participation}；不是真实受众事实。`,
        inspiration: '由自主叙事信号推导为个人选择顺序、产品反馈推进的机制；这是设计推断。' }] : [],
      openQuestions: ['内容版权、无障碍任务与各站空间条件尚待确认。'],
      unverifiedEffects: ['自主探索是否提升停留或品牌理解尚待用户研究。'] },
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
    ? '已更新离线演示提案板。所有文化返回均为虚构夹具；设计与效果仍需真实验证。'
    : '提案未通过项目约束校验，未应用修改。' }];
  const proposal = { baseVersion: snapshot.version,
    phase: 'needs_input', summary: '', questions: [], concepts: [] };
  const reuse = /已有证据|复用|不要.*查询|不再.*查/.test(userText);
  const queryAgain = /重新查询|重新研究|重跑|再查|更新.*证据/.test(userText) && !reuse;
  if (reuse) {
    const existing = snapshot.evidence.find(e => e.relevant === true && e.returnedEntities.length === 2);
    proposal.phase = existing ? 'ready' : 'insufficient_evidence';
    proposal.summary = existing ? '按要求复用本项目已有离线合成证据；本轮没有追加查询。'
      : '按要求停止追加查询。现有证据不足，暂停概念生成，不补造研究依据。';
    proposal.concepts = existing ? mockConcepts(snapshot, existing) : [];
  } else if (snapshot.concepts.length && !queryAgain) {
    proposal.phase = 'insufficient_evidence';
    proposal.summary = '离线模拟无法理解任意反馈或完成真实语义修改；保留现有讨论草案，本轮未追加查询。需另行验证真实模型与后续修改流程。';
    proposal.concepts = snapshot.concepts;
  } else if (!snapshot.brief.venue) {
    proposal.summary = '场地影响参与容量和组织方式，先补充这一项再研究。';
    proposal.questions = [{ field: 'venue', text: '活动在哪个城市、室内还是室外，大约有多少可用空间？未知项可以明确说明。' }];
  } else if (!snapshot.brief.references.length) {
    proposal.summary = '尚无可用文化研究信号，先确认参考，避免把品牌名称当作受众画像。';
    proposal.questions = [{ field: 'references', text: '有哪些客户确认的音乐、电影或文化参考？这些只作为待研究信号。' }];
  } else {
    const query = parsed.find(r => r.name === 'qloo_recommend');
    if (!query) return [{ type: 'toolCall', id: randomUUID(), name: 'qloo_recommend',
      arguments: { target_type: 'artist', signals: snapshot.brief.references, limit: 2 } }];
    const card = query.value.artEvidence && { ...query.value.artEvidence, returnedEntities: query.value.results ?? [] };
    const useful = card && card.relevant && card.returnedEntities.length === 2;
    proposal.phase = useful ? 'ready' : 'insufficient_evidence';
    proposal.summary = useful ? '离线合成证据已回到官方会话，并转译为两个参与机制；尚未完成真实数据验收。'
      : '证据不足：查询失败或返回与设计问题无关。下列仅为无证据支持的讨论草案；应补充或调整研究。';
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
    name: entity.name ?? entity.input ?? '未知', type: entity.type ?? '未知', match: entity.match ?? '未知',
    synthetic: false, resolution: structuredClone(entity), note: '来自实际官方工作流 interpretation；客户参考仍非已验证受众画像' }))
    : (input.signals ?? [input.entity]).filter(Boolean).map((name, i) =>
    ({ id: synthetic ? `fixture:input-${i + 1}` : null, name, type: synthetic ? 'synthetic:input-signal' : 'unknown', synthetic,
      note: synthetic ? '仅为客户输入的离线占位引用，非已解析 Qloo 实体' : '实际解析信息保留于 rawResult；未取得的标识符与类型明确未知' }));
  const card = { id: randomUUID(), projectId: project.id, inputReferences,
    returnedEntities: structuredClone(entities), source: synthetic ? fixture.source : 'Qloo official workflow',
    query: { workflow: operation, input: structuredClone(input), designQuestion: '哪些文化信号能够影响参与组织与产品接触方式？' },
    context: { venue: project.brief.venue || '未知', geographicFilter: input.filter_location ?? '未应用；场地文字不等于适用地理筛选',
      referenceStatus: synthetic ? '合成样本，未解析真实实体' : '查看实际工作流解析信息；未自动确认代理品牌' },
    queriedAt: new Date().toISOString(), requestRef: execution.correlationId, synthetic,
    relevant: synthetic ? project.scenario !== 'irrelevant' : null,
    boundary: synthetic ? '离线合成夹具；虚构实体，非 Qloo 数据、非真实受众画像或活动效果证据。'
      : '文化关联不证明个体行为、因果效果、配色、材料、预算、版权或合作方可用性。',
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
        : toolFeedback(project, 'QLOO_QUERY_STOPPED', '/', '本轮查询已经停止；禁止后续查询与替代请求。'),
      summary: '本轮真实查询已经停止；后续查询与替代请求均被阻止。可依据已有精确字段提出边界草案或明确暂停。',
      error: { code: 'ART_QUERY_STOPPED', layer: 'harness', retryable: false, recovery: '保留当前项目，说明失败；不要重试或使用替代查询。' }, results: [] } };
}

// The same process latch covers every exposed official query tool. A failed
// execute call can return its error to the model, but cannot open another query.
export function wrapProjectExecutor(project, officialExecutor, env = process.env) {
  return { ...officialExecutor, async execute(operation, input, context) {
    const blocked = reason => ({ operation, transport: officialExecutor.transport, correlationId: context?.correlationId ?? randomUUID(), durationMs: 0,
      result: { schema_version: '1.0-preview.1', operation, status: 'needs_input', results: [],
        summary: reason, feedback: toolFeedback(project, 'REFERENCE_CONFIRMATION_REQUIRED', '/signals', reason, true) } });
    if (operation === 'recommend' && pendingReference(project))
      return blocked('输入文化参考尚未解决；推荐已在执行边界暂停，请先选择实际候选或补充信息。');
    try { input = bindReferenceInputs(project, operation, input); }
    catch (error) { const execution = blocked(error.message); execution.result.feedback.code = error.code; return execution; }
    if (project.mode === 'live' && (project.runtime.queryStopped || validationRun.queryStopped))
      return stoppedExecution(project, officialExecutor, operation, context);
    if (project.mode === 'live' && remainingBudget(project).qlooHttpAttempts === 0) {
      recordLocalFailure(project, 'qloo', 'QLOO_HTTP_BUDGET_EXHAUSTED', 'Qloo HTTP 总额度已用尽；本地已阻止查询，未发生新的远端请求。');
      project.runtime.queryStopped = true;
      project.runtime.failure = safeRuntimeFailure(project, 'qloo');
      stopLiveRun(project, project.runtime.failure, true);
      return stoppedExecution(project, officialExecutor, operation, context);
    }
    let execution;
    try {
      execution = project.mode === 'offline' ? await withoutNetwork(project, () => officialExecutor.execute(operation, input, context))
        : await withHttpBudget(project, 'qloo', env.QLOO_API_URL, () => officialExecutor.execute(operation, input, context));
      if (!execution?.result || typeof execution.result.status !== 'string') throw new Error('官方查询返回格式无效');
      const resolvedInput = observeReferenceResolution(project, operation, input, execution.result);
      if (resolvedInput && !pendingReference(project)) {
        input = resolvedInput;
        execution = project.mode === 'offline' ? await withoutNetwork(project, () => officialExecutor.execute(operation, input, context))
          : await withHttpBudget(project, 'qloo', env.QLOO_API_URL, () => officialExecutor.execute(operation, input, context));
        if (!execution?.result || typeof execution.result.status !== 'string') throw new Error('官方查询返回格式无效');
      }
      if (project.referenceResolutions?.length) execution = { ...execution,
        result: { ...execution.result, referenceResolution: referenceResolutionView(project) } };
    } catch (error) {
      action(project, 'query', '文化研究查询未完成', project.mode === 'offline' ? '离线夹具执行错误' : '官方查询失败；本轮所有真实查询已停止', 'error');
      if (project.mode === 'live') {
        project.runtime.failure = safeRuntimeFailure(project, 'qloo');
        stopLiveRun(project, project.runtime.failure, true);
        const stopped = stoppedExecution(project, officialExecutor, operation, context);
        if (project.runtime.localFailure?.kind !== 'qloo') stopped.result.feedback = toolFeedback(project,
          'QLOO_REMOTE_ERROR', '/', '官方工作流执行失败；没有取得新的支持证据。');
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
        stopReason: '官方查询已返回错误；本轮所有项目不再执行后续查询或替代请求。' } };
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
      empty ? '查询完成但返回0个实体；无可引用结果，不是本地额度耗尽。'
        : status === 'needs_input' ? '官方工作流需要澄清实体或查询参数；未取得可用结果。'
          : status === 'error' ? '官方工作流返回错误；没有取得新的支持证据。'
            : '实际返回字段可被精确引用；描述可支持标明边界的设计推断，不证明受众或效果。',
      status === 'needs_input', empty ? '不要重复相同空查询；可调整明确参数、使用已有证据提交草案，或以 insufficient_evidence 暂停。' : undefined);
    execution = { ...execution, result: { ...execution.result, feedback } };
    action(project, 'query', project.mode === 'offline' ? '读取离线合成夹具' : '执行官方文化研究查询',
      execution.result.status === 'error' ? (project.mode === 'live' ? '查询失败；没有支持设计的证据；真实模式已停止后续查询' : '离线模拟查询失败；没有支持设计的证据') : card?.relevant === false ? '返回内容无关；不能用作设计依据' : '返回字段已保留，等待模型区分事实与设计转译',
      execution.result.status === 'error' ? 'error' : 'done');
    return execution;
  } };
}

export async function createProductRuntime(project, { env = process.env, decide = offlineDecision, diagnostic, qlooExecutor } = {}) {
  if (diagnostic && typeof diagnostic.fetch !== 'function') throw new Error('诊断必须提供独立的一次请求边界');
  const diagnosticState = diagnostic ? { modelCallbacks: 0, blockedModelCallbacks: 0, pausedToolNames: [], toolExecutionAttempts: 0 } : undefined;
  const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
  const paths = resolveQlooPaths({ cwd: root, env: { QLOO_HOME: resolve(root, '.art-runtime', project.id) } });
  const modelRuntime = await ModelRuntime.create({ authPath: paths.authFile, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  let liveStream;
  if (project.mode === 'live') {
    const config = configStatus(env);
    if (!config.modes.live.available) throw new Error(`真实模式未启用或配置不完整：${config.modes.live.missing.join(', ')}`);
    const supported = ['openai-completions', 'openai-responses', 'anthropic-messages'];
    if (!supported.includes(env.ART_MODEL_API)) throw new Error('当前仅支持明确配置的 OpenAI 兼容补全／响应或 Anthropic 消息协议');
    liveStream = (await import(`@earendil-works/pi-ai/api/${env.ART_MODEL_API}`)).streamSimple;
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
          throw new Error('诊断禁止第二次模型调用');
        }
        diagnosticState.modelCallbacks++;
      }
      if (!diagnostic && project.mode === 'live' && remainingBudget(project).modelHttpAttempts === 0)
        throw recordLocalFailure(project, 'model', 'MODEL_HTTP_BUDGET_EXHAUSTED', '模型 HTTP 总额度已用尽；本地已阻止请求。');
      project.usage.modelCalls++;
      // Preserve the default's twelve local-only callbacks without resetting cumulative usage.
      const callbackLimit = Math.min(Number.MAX_SAFE_INTEGER, (project.mode === 'live'
        ? remainingBudget(project).caseLimits.modelHttpAttempts : LIMITS.modelHttpAttempts) + 2 * LIMITS.modelHttpAttempts);
      if (project.usage.modelCalls > callbackLimit)
        throw recordLocalFailure(project, 'model', 'MODEL_CALLBACK_BUDGET_EXHAUSTED', '本项目模型轮次上限已到，暂停并保留当前状态');
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
                !capacity.fits ? contextCapacityReason(capacity) : '模型请求的最终输出容量与配置不符；请求已在本地停止。');
            return finalPayload;
          } });
      return diagnostic ? stream() : withHttpBudget(project, 'model', env.ART_MODEL_BASE_URL, stream,
        [env.ART_MODEL_API_KEY, env.QLOO_API_KEY]);
    },
    models: [{ id: modelId, name: project.mode === 'offline' ? '离线合成设计模型' : modelId,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: officialFlash ? 65536 : 32000, maxTokens: 12000 }] });
  let officialExecutor;
  if (qlooExecutor) officialExecutor = qlooExecutor;
  else if (project.mode === 'offline') {
    officialExecutor = createDelegatingQlooWorkflowExecutor({ transport: { kind: 'direct', name: 'local-synthetic-fixture', remote: false },
      async invoke(operation) {
        if (project.scenario === 'failure') return { schema_version: '1.0-preview.1', operation, status: 'error',
          summary: '离线模拟查询失败；未发生真实请求', results: [], error: { code: 'OFFLINE_FIXTURE_FAILURE', retryable: false } };
        return { schema_version: '1.0-preview.1', operation, status: 'ok', synthetic: true,
          summary: fixture.label, results: structuredClone(fixture[project.scenario]) };
      } });
  } else {
    officialExecutor = createDirectQlooWorkflowExecutorFromEnvironment({
      env: { QLOO_API_KEY: env.QLOO_API_KEY, QLOO_BASE_URL: env.QLOO_API_URL, QLOO_TRUSTED_BASE_URL: env.QLOO_API_URL },
      configPath: paths.configFile, readConfigFile: () => '', executionObserver: {} });
    if (!officialExecutor) throw new Error('Qloo 官方执行器缺少凭据');
  }
  const executor = wrapProjectExecutor(project, officialExecutor, env);
  const tools = createQlooTools({ executor }).filter(t => TOOL_NAMES.includes(t.name));
  tools.push({ name: 'read_project_evidence', label: '读取当前项目已存证据字段',
    description: 'Read saved evidence in this project, without HTTP or state changes. Supply evidenceId alone (plus optional offset) for at most 12 entity identities and nextOffset; supply entityId and entity-relative dotted field path for one saved entity field, e.g. properties.description or affinity. Without entityId, field may only be query or a query.* path on this evidence card, e.g. query.input.signals.0. Exact fields are limited to 6000 serialized characters. Only status ok and exact true is an exact citable value; missing or too_large previews must not be cited as a complete field. Cannot read another project, arbitrary card/project fields, files or URLs.',
    parameters: Type.Object({ evidenceId: Type.String(), entityId: Type.Optional(Type.String({ description: 'Required for returned-entity fields; omit only for the entity index or allowlisted card query paths.' })),
      field: Type.Optional(Type.String({ description: 'Entity-relative dotted field with entityId; only query or query.* without entityId. Numeric array indices are allowed; file, URL and prototype paths are forbidden.' })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
    async execute(_id, input) {
      const result = readProjectEvidence(project, input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } });
  let submittedRevisionId = null;
  tools.push({ name: 'propose_concept_revision', label: '提出局部待审修改',
    description: 'Propose changes only to the server-bound selected concept and base version. For pending_feedback, changes are a delta from currentPendingDraft; omitted fields retain the existing pending values. Preserve unaffected entries and conditions within changed fields. Never submit project identity, target identity, base version, before values, full projects or concepts. Confirmed content is immutable until user acceptance. Return pending changes with reasons, exact existing evidence references, impact and unknowns, or needs_input/conflict with exactly one question and no changes. Evidence description/short_description can support explicitly marked design inference; affinity is only cultural association and cannot support description claims or effect scores. Existing historical evidence links must be preserved; do not repair or revalidate unrelated content. Structural example only; replace placeholders with actual allowed changes and exact saved evidence values: {"phase":"pending","summary":"<revision-summary>","changes":[{"field":"evidenceLinks","after":[{"evidenceId":"<card-id>","entityId":"<returned-entity-id>","observedField":"properties.description","observedValue":"<complete-actual-field-value>","observation":"<actual-observation>","inspiration":"<explicit-design-inference>"}],"reason":"<reason-for-this-change>","evidenceRefs":[{"evidenceId":"<card-id>","entityId":"<returned-entity-id>","observedField":"properties.description","observedValue":"<complete-actual-field-value>","inspiration":"<explicit-design-inference>"}]}],"impact":["<scope-and-consequences>"],"unknowns":["<actual-unverified-condition>"]}. Every changes item, especially evidenceLinks, must have all four keys field, after, reason, evidenceRefs; reason and evidenceRefs are siblings of after. The required top-level impact and unknowns arrays must also be present.',
    parameters: revisionSchema,
    async execute(_id, input) {
      let result;
      const issue = schemaIssue(revisionSchema, input);
      try {
        if (issue) throw Object.assign(new Error('局部修改参数结构无效；不要提交项目、目标、基础版本或修改前内容'),
          { feedback: { code: 'REVISION_SCHEMA_INVALID', path: issue.path, reason: '局部修改参数结构无效；按限定字段修正。', correctable: true } });
        result = proposeRevision(project, { ...input, requestId: submittedRevisionId });
        action(project, 'revision', result.status === 'pending' ? '形成局部待审修改' : '局部修改待确认', input.summary);
        result = { accepted: false, completed: true, revisionId: result.id ?? null, status: result.status,
          feedback: toolFeedback(project, 'REVISION_RESPONSE_SAVED', '/', '已保存局部修改回应；正式版本未改变，须由用户审查批准。', false) };
      } catch (error) {
        const rejected = error.feedback ?? { code: 'REVISION_INVALID', path: '/', reason: '局部修改校验失败；正式版本保持不变。', correctable: true };
        result = { accepted: false, status: 'error', feedback: toolFeedback(project, rejected.code, rejected.path, rejected.reason,
          rejected.correctable, '仅修正本目标允许的字段与实际证据引用，或明确澄清与暂停。', issue) };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } });
  tools.push({ name: 'propose_design_response', label: '提出结构化设计回应',
    description: 'Only updates the bound current project after version, actual evidence field references, and literal constraints pass. Never submit projectId. questions may be omitted or [] unless phase is needs_input, which requires exactly one {field,text} question with nonempty text. field must be request, brand, goal, references, venue, budget, mustKeep, or avoid. Ready requires two distinct mechanisms; insufficient evidence may pause with zero concepts or show two unsupported drafts.',
    parameters: proposalSchema,
    async execute(_id, input) {
      let result;
      const issue = schemaIssue(proposalSchema, input);
      if (issue) {
        result = { accepted: false, status: 'error', feedback: toolFeedback(project, 'PROPOSAL_SCHEMA_INVALID', issue.path,
          '提案参数结构无效；按字段类型修正，且不要提交项目标识。', true, undefined, issue) };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
      try { result = applyProposal(project, { ...input, projectId: project.id }); }
      catch (error) {
        const rejected = error.feedback ?? { code: 'PROPOSAL_INVALID', path: '/', reason: '提案未通过业务校验；项目未被修改。', correctable: true };
        result = { accepted: false, status: 'error', feedback: toolFeedback(project, rejected.code, rejected.path, rejected.reason,
          rejected.correctable, '按反馈路径修正提案字段后重试；不得编造项目、证据或引用。', businessDiagnostic(project, input, rejected.path)) };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
      action(project, 'proposal', input.phase === 'needs_input' ? '提出关键澄清' : '形成可讨论概念', input.summary);
      result.feedback = toolFeedback(project, 'PROPOSAL_ACCEPTED', '/', '提案已通过结构、版本、引用与字面约束校验；不代表设计质量或产品验收。', false, '当前提案已保存；等待用户审阅。');
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    } });
  const sessionDirectory = resolve(root, '.art-runtime', project.id, 'sessions');
  const savedSession = project.runtime.sessionFile;
  const priorSession = savedSession && resolve(savedSession).startsWith(sessionDirectory + sep) && existsSync(savedSession);
  let researchCarry = [];
  for (const saved of new Set([...(project.runtime.sessionHistory ?? []), savedSession].filter(Boolean))) {
    if (!resolve(saved).startsWith(sessionDirectory + sep) || !existsSync(saved)) continue;
    // Parsing and building a context are public pure helpers; SessionManager.open
    // can migrate and rewrite old files, so do not open a closed session to read it.
    const savedText = readFileSync(saved, 'utf8');
    const entries = parseSessionEntries(savedText);
    if (entries.length !== savedText.split(/\r?\n/).filter(line => line.trim()).length)
      throw new Error('当前项目的已存会话包含不可读取记录；停止并保留原文件。');
    researchCarry = unresolvedResearch(buildSessionContext(entries.filter(entry => entry.type !== 'session')).messages, researchCarry);
  }
  const sessionManager = project.mode === 'offline' && priorSession
    ? SessionManager.open(savedSession, sessionDirectory) : SessionManager.create(root, sessionDirectory);
  if (project.mode === 'live' && priorSession)
    (project.runtime.sessionHistory ??= []).push(savedSession);
  const limits = remainingBudget(project);
  const liveBudgetDescription = `真实模型与 Qloo 的每项目 HTTP 请求上限分别为 ${limits.caseLimits.modelHttpAttempts}、${limits.caseLimits.qlooHttpAttempts} 次，本服务合计上限分别为 ${limits.sharedLimits.modelHttpAttempts}、${limits.sharedLimits.qlooHttpAttempts} 次，包括重试。`;
  const runtime = await createPiHarnessRuntime({ cwd: root, paths, profile: 'explore', modelRuntime,
    sessionManager,
    resources: { systemPrompt: `你是品牌快闪体验设计智能体。project.brief.request 是不可覆盖的原始需求原文。project.clarifications 是有限相关问题与回答视图，clarificationHistory 给出总数与省略数；原需求补充完整保留，较早结构化字段问答可能省略，不代表其条件撤销，当前字段以 brief 及明确修改为准；如仍有影响决策的歧义应澄清。普通回答补充原需求，不替换未提及条件，含糊的“都可以”“按你建议”不代表放宽城市、预算、必须项或禁止项。仅 revisesRequest:true 表示用户明确修改原需求中的相应条件，按其明确表述处理，其他条件保持；briefUpdate.explicit:true 的 before 是历史值、after 是当前明确值，当前结构化字段以 project.brief 为准，不能恢复已被明确撤销的旧条件。若仅有 revisesRequest 自由文字且与当前结构化条件冲突，没有对应 briefUpdate，不能声称已经放宽条件，应请用户通过明确修改控件确认对应字段。仅处理当前项目；初始研究使用官方研究工具与 propose_design_response，已有正式概念后只能通过 propose_concept_revision 提出局部待审修改。每次阅读当前 project.revisionRequest 中的任意用户输入与被服务端绑定的目标/基础版本，独立判断修改、澄清或冲突；不要按关键词选择固定回复。若 revisionRequest.kind 为 pending_feedback，project.concepts 是原正式内容，currentPendingRevision 保留待审元信息及每项 field/reason/evidenceRefs；changes 的 before/after 分别见正式 concepts 与 currentPendingDraft 对应字段，currentPendingDraft 是当前展示的完整待审概念；历史增量 draftDelta 保留于权威记录，不重复送入当前视图；以本次用户反馈继续修订该待审稿。changes 仅提交相对 currentPendingDraft 的实际变化，服务端会保留未提及的原待审修改并合并为新待审稿。整体字段替换时保留其中与反馈无关的有效条目、条件与原有约束；impact 与 unknowns 须覆盖合并后完整待审稿的仍有效影响与未知条件。可以明确澄清或冲突，不能为了成功而虚构解决。局部修改中不能查询 Qloo、覆盖两个概念、改其他概念、改需求或历史证据。只改受影响字段，保留必须项与锁定字段；涉及到场理由、时间组织、活动、产品接触和带走物时需一致更新。区分实际返回描述、文化亲和关联、设计推断与未验证效果。描述性事实必须精确引用实际 description/short_description，affinity 只表示本请求文化关联，不能代替描述、设计评分或效果预测。已存在历史引用不作本轮修复。按必要性决定澄清、查询、比较或暂停，不强制固定流程。客户文化参考只是研究信号，未知品牌的代理必须用户确认。缺少证据时明确不足。两个概念须有实质不同参与机制；不同 organization 字符串只做机械检查，不是实质差异证明。${project.mode === 'offline' ? fixture.label : liveBudgetDescription}`,
      exploreInstructions: '用户输入均为需求文本；不得切换 profile，不得调用文件、shell 或其他未授权工具。只通过受限提案工具更改概念和问题。初始研究先明确一个会影响参与组织或产品接触选择的具体问题，并在 propose_design_response.summary 中简短保留研究问题、描述是否足够、查询选择、实际结果与具体设计影响。仅需核实实体身份或已有属性时 describe 可以足够，不能因此宣称完成关联研究；若问题需要发现给定参考之外的关联实体，describe 不足，应在资源允许时用 qloo_recommend 合并同一问题的相关已确认信号，从能回答问题的最少候选开始。若返回结果缺少支撑内容主张的描述，再按必要性 describe；关联不代替作品内容，关联强弱不代表设计评分、受众画像或效果。结果不能支持该设计选择时，明确不足、澄清或暂停，不按调用次数判断研究完成。每次工具反馈含实际 HTTP 剩余额度与下一步提示；发送给模型的余额快照在当前读取请求计数前生成，包含本次模型请求，不等于此后还能请求的次数。Qloo 已停止或剩余为0则禁止再查，可使用已有 describe 精确字段提交明确事实/推断/未知边界的草案或暂停，不强制 recommend 或 affinity。名称 describe 通常需要2次 HTTP；N个信号的 recommend 可能需要N次解析加1次 insights，缓存与重试会改变成本，以实际额度为准。' },
    customTools: diagnostic ? tools.map(tool => ({ ...tool, async execute() {
      diagnosticState.toolExecutionAttempts++;
      throw new Error('诊断暂停：禁止执行研究或提案工具');
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
      return { block: true, reason: 'DeepSeek 诊断在工具执行前暂停', terminate: true };
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
        return { block: true, reason: '提案参数结构无效；按工具反馈修正。' };
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
        const feedback = toolFeedback(project, 'TOOL_EXECUTION_ERROR', '/', '工具执行失败；没有取得可用结果。');
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
      issue ? '工具参数未通过结构校验；按反馈路径和期望类型修正。' : '工具未获许可或执行失败；没有取得可用结果。',
      Boolean(issue), undefined, issue ?? valueDiagnostic(event.args, '/', 'allowed tool arguments'));
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
      if (project.mode === 'live' && (validationRun.liveStopped
        || (project.runtime.failure && project.runtime.failure.kind !== 'qloo')
        || (project.runtime.localFailure && project.runtime.localFailure.kind !== 'qloo')
        || ['error', 'aborted'].includes(context.message.stopReason))) return true;
      if (project.mode === 'live' && remainingBudget(project).modelHttpAttempts === 0) {
        const previous = project.runtime.feedback;
        project.runtime.feedback = previous && previous.code !== 'QLOO_RESULT_AVAILABLE'
          ? toolFeedback(project, previous.code, previous.path, previous.reason, previous.correctable, undefined, feedbackFields(previous))
          : toolFeedback(project, 'MODEL_HTTP_BUDGET_EXHAUSTED', '/', '模型 HTTP 总额度已用尽；尚无通过校验的提案，保留当前状态。');
        return true;
      }
      return false;
    };
  }
  const sanitizedContext = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const safe = sanitizedContext ? await sanitizedContext(messages, signal) : messages;
    researchCarry = unresolvedResearch(safe, researchCarry);
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
        summary: '模型因输出长度限制结束，但没有可用正文或工具调用；正式内容与待审稿保持不变。' };
      stopLiveRun(project, project.runtime.failure);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && ['error', 'aborted'].includes(event.message.stopReason)) {
      project.runtime.failure = safeRuntimeFailure(project, 'model', event.message.stopReason);
      stopLiveRun(project, project.runtime.failure);
    }
    if (event.type === 'tool_execution_start') {
      project.usage.toolCalls++;
      const record = action(project, 'tool', event.toolName, '官方运行时请求执行工具', 'running');
      record.toolCallId = event.toolCallId;
      if (['qloo_describe', 'qloo_recommend'].includes(event.toolName)) record.arguments = redactArguments(event.args);
    }
    if (event.type === 'tool_execution_end') {
      const pending = project.actions.find(a => a.type === 'tool' && a.toolCallId === event.toolCallId && a.status === 'running');
      if (pending) {
        const result = event.result?.details;
        const failed = event.isError || result?.status === 'error';
        pending.status = failed ? 'error' : 'done';
        pending.detail = failed ? '工具拒绝或执行失败；未视作成功证据' : '结构化结果已通过 content.text 返回模型';
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
        ?? '本轮未产生有效局部修改；正式版与原待审稿保持不变。');
      project.status = { phase: 'error', detail: revisionRequest.detail };
    } else if (project.version === previousVersion && project.status.phase === 'busy') {
      const feedback = project.runtime.feedback;
      project.status = { phase: !project.runtime.failure && ['QLOO_EMPTY', 'EVIDENCE_INSUFFICIENT'].includes(feedback?.code) ? 'insufficient_evidence' : 'error',
        detail: project.runtime.failure?.summary ?? feedback?.reason ?? '本轮未产生通过校验的提案；当前状态已保留' };
    }
    return project;
  }, dispose: () => runtime.dispose() };
}
