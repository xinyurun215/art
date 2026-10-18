import { createHash, randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({ modelHttpAttempts: 6, qlooHttpAttempts: 6 });
export const SERVER_LIMITS = Object.freeze({ modelHttpAttempts: 12, qlooHttpAttempts: 12 });
export const list = (value) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,，;；]/) : []).map(String).map(s => s.trim()).filter(Boolean);
const text = value => typeof value === 'string' ? value.trim() : '';

export function createProject({ brief = {}, mode = 'offline', scenario = 'sufficient' } = {}) {
  if (!['offline', 'live'].includes(mode)) throw new Error('不支持的运行模式');
  if (!['sufficient', 'failure', 'irrelevant'].includes(scenario)) throw new Error('不支持的离线场景');
  if (!text(brief.request)) throw new Error('请先描述项目需求');
  return {
    id: randomUUID(), version: 1, mode, scenario,
    brief: { request: text(brief.request), brand: text(brief.brand), goal: text(brief.goal),
      references: list(brief.references), venue: text(brief.venue), budget: text(brief.budget),
      mustKeep: list(brief.mustKeep), avoid: list(brief.avoid) },
    messages: [{ role: 'user', text: text(brief.request) }], actions: [], questions: [], evidence: [], concepts: [],
    selectedConceptId: null, revisions: [], versionHistory: [], revisionRequest: null,
    status: { phase: 'busy', detail: '正在建立官方智能体会话' },
    usage: { modelCalls: 0, modelHttpAttempts: 0, qlooHttpAttempts: 0, toolCalls: 0 },
    runtime: { sessionId: null, toolNames: [], modelResultReads: 0 },
  };
}

export function action(project, type, label, detail, status = 'done') {
  const record = { id: randomUUID(), type, label, detail, status, time: new Date().toISOString() };
  project.actions.push(record);
  return record;
}

function ensure(condition, message, path = '/', code = 'PROPOSAL_INVALID') {
  if (!condition) throw Object.assign(new Error(message), { feedback: { code, path, reason: message, correctable: true } });
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }

// This checks structure and literal constraints, not originality or design quality.
export function validateProposal(project, proposal) {
  ensure(proposal.projectId === project.id, '项目不匹配：禁止跨项目写入', '/projectId', 'PROJECT_MISMATCH');
  ensure(proposal.baseVersion === project.version, '基础版本已过期，请基于当前项目重新提出方案', '/baseVersion', 'STALE_PROJECT_VERSION');
  ensure(['needs_input', 'ready', 'insufficient_evidence'].includes(proposal.phase), '无效的提案状态', '/phase');
  ensure(nonempty(proposal.summary), '提案缺少说明', '/summary');
  const questions = proposal.questions === undefined && proposal.phase !== 'needs_input' ? [] : proposal.questions;
  ensure(Array.isArray(questions), '问题必须为数组', '/questions');
  for (const [index, q] of questions.entries()) {
    ensure(q !== null && typeof q === 'object' && !Array.isArray(q) && Object.keys(q).every(key => ['field', 'text'].includes(key)),
      '问题必须为仅含 field 与 text 的对象', `/questions/${index}`);
    ensure(typeof q.field === 'string' && Object.hasOwn(project.brief, q.field), '问题字段必须属于当前需求', `/questions/${index}/field`);
    ensure(nonempty(q.text), '问题文字不能为空', `/questions/${index}/text`);
  }
  ensure(Array.isArray(proposal.concepts), '概念必须为数组', '/concepts');
  if (proposal.phase === 'needs_input') {
    ensure(questions.length === 1 && proposal.concepts.length === 0, '每次待澄清状态须明确且仅包含一个问题', '/questions');
    return;
  }
  ensure(proposal.concepts.length === 2 || (proposal.phase === 'insufficient_evidence' && proposal.concepts.length === 0), '须提出两个概念，或在证据不足时明确暂停', '/concepts');
  if (!proposal.concepts.length) return;
  ensure(new Set(proposal.concepts.map(c => c.id)).size === 2, '概念标识符重复', '/concepts');
  const organizations = new Set();
  for (const [index, concept] of proposal.concepts.entries()) {
    const path = `/concepts/${index}`;
    for (const key of ['id', 'title', 'coreClaim']) ensure(nonempty(concept[key]), `概念缺少 ${key}`, `${path}/${key}`);
    ensure(nonempty(concept.mechanism?.organization), '参与组织方式无效', `${path}/mechanism/organization`);
    ensure(nonempty(concept.mechanism.description), '概念缺少参与机制说明', `${path}/mechanism/description`);
    organizations.add(concept.mechanism.organization);
    ensure(Array.isArray(concept.journey) && concept.journey.length >= 3 && concept.journey.every(s => nonempty(s.stage) && nonempty(s.action)), '概念需包含可读的体验旅程', `${path}/journey`);
    for (const key of ['productTouchpoints', 'openQuestions', 'unverifiedEffects'])
      ensure(Array.isArray(concept[key]) && concept[key].every(nonempty), `概念 ${key} 格式无效`, `${path}/${key}`);
    ensure(concept.productTouchpoints.length > 0, '概念必须包含产品接触', `${path}/productTouchpoints`);
    ensure(concept.unverifiedEffects.length > 0, '必须标注未验证效果', `${path}/unverifiedEffects`);
    const contact = concept.productTouchpoints.join(' ');
    const active = [concept.coreClaim, concept.mechanism.description, ...concept.journey.map(s => s.action), contact].join(' ');
    for (const required of project.brief.mustKeep) ensure(active.includes(required), '概念必须保留需求中的必须保留项', path, 'REQUIRED_ITEM_MISSING');
    for (const forbidden of project.brief.avoid) ensure(!active.includes(forbidden), '概念包含需求中的禁止项', path, 'FORBIDDEN_ITEM_PRESENT');
    ensure(Array.isArray(concept.evidenceLinks), '证据引用格式无效', `${path}/evidenceLinks`);
    for (const [linkIndex, link] of concept.evidenceLinks.entries()) {
      const linkPath = `${path}/evidenceLinks/${linkIndex}`;
      const evidence = project.evidence.find(e => e.id === link.evidenceId);
      ensure(evidence && evidence.projectId === project.id, '未知证据或跨项目证据引用', `${linkPath}/evidenceId`, 'EVIDENCE_REFERENCE_INVALID');
      ensure(evidence.relevant !== false, '无关结果不能支撑设计依据', `${linkPath}/evidenceId`, 'EVIDENCE_IRRELEVANT');
      ensure(nonempty(link.observation) && nonempty(link.inspiration), '须分开说明返回事实与设计转译', linkPath);
      const entity = evidence.returnedEntities.find(e => (e.id ?? e.entity_id) === link.entityId);
      ensure(entity && nonempty(link.observedField), '证据引用缺少实际返回实体与字段', `${linkPath}/entityId`, 'EVIDENCE_ENTITY_INVALID');
      const parts = link.observedField.split('.');
      let actual = entity;
      for (const part of parts) {
        ensure(actual && typeof actual === 'object' && Object.hasOwn(actual, part), '引用的实际返回字段不存在', `${linkPath}/observedField`, 'EVIDENCE_FIELD_MISSING');
        actual = actual[part];
      }
      ensure(JSON.stringify(actual) === JSON.stringify(link.observedValue), '引用字段的值与实际返回不符', `${linkPath}/observedValue`, 'EVIDENCE_VALUE_MISMATCH');
    }
    if (proposal.phase === 'ready') ensure(concept.evidenceLinks.length > 0, '证据不足时不得标记完成研究；补充精确引用或改为 insufficient_evidence 草案/暂停', `${path}/evidenceLinks`, 'EVIDENCE_INSUFFICIENT');
  }
  ensure(organizations.size === 2, '两个概念必须具有不同的参与组织机制', '/concepts', 'MECHANISMS_NOT_DISTINCT');
}

export function applyProposal(project, proposal) {
  validateProposal(project, proposal);
  if (project.concepts.length) {
    ensure(project.revisionRequest?.status !== 'running', '局部修改期间禁止使用完整提案工具', '/concepts', 'LOCAL_REVISION_REQUIRED');
    ensure(JSON.stringify(proposal.concepts) === JSON.stringify(project.concepts),
      '已有正式概念只能通过局部待审修改更新', '/concepts', 'LOCAL_REVISION_REQUIRED');
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
  revisionEnsure(baseVersion === project.version, '基础版本已过期；请基于当前正式版本重新操作', '/baseVersion', 'STALE_PROJECT_VERSION');
  revisionEnsure(project.concepts.some(concept => concept.id === conceptId), '目标概念不存在', '/conceptId', 'TARGET_NOT_FOUND');
  revisionEnsure(project.selectedConceptId === conceptId, '目标与当前选中概念不一致', '/conceptId', 'TARGET_MISMATCH');
}
function rememberVersion(project, revisionId = null) {
  project.versionHistory ??= [];
  if (!project.versionHistory.some(record => record.version === project.version)) project.versionHistory.push({
    version: project.version, concepts: structuredClone(project.concepts), selectedConceptId: project.selectedConceptId,
    revisionId, confirmedAt: new Date().toISOString() });
}
export function selectConcept(project, input) {
  revisionEnsure(exactKeys(input, ['conceptId', 'baseVersion']), '选择操作不能指定其他项目或覆盖状态');
  revisionEnsure(input.baseVersion === project.version, '基础版本已过期；请刷新正式版本', '/baseVersion', 'STALE_PROJECT_VERSION');
  revisionEnsure(project.concepts.some(concept => concept.id === input.conceptId), '目标概念不存在', '/conceptId', 'TARGET_NOT_FOUND');
  revisionEnsure(project.selectedConceptId === input.conceptId || !project.revisions?.some(record => record.status === 'pending'),
    '请先接受或拒绝当前待审修改，再切换概念', '/conceptId', 'PENDING_SELECTION_LOCKED');
  project.selectedConceptId = input.conceptId;
  project.revisions ??= [];
  rememberVersion(project);
  return project;
}
export function beginRevision(project, input) {
  revisionEnsure(exactKeys(input, ['conceptId', 'baseVersion', 'text', 'offlineFixture']), '局部修改请求只能指定本项目目标、版本、文本与明确离线夹具');
  revisionEnsure(project.revisionRequest?.status !== 'running', '当前修改请求仍在处理，不能替换', '/', 'REVISION_IN_PROGRESS');
  revisionEnsure(!project.revisions?.some(record => record.status === 'pending'),
    '请先接受或拒绝当前待审修改，再提交新请求', '/', 'PENDING_REVISION_EXISTS');
  binding(project, input);
  revisionEnsure(nonempty(input.text), '请输入要调整的内容', '/text');
  revisionEnsure(!input.offlineFixture || project.mode === 'offline' && ['pair_45', 'needs_input', 'conflict', 'invalid_reference'].includes(input.offlineFixture),
    '仅离线测试可选择明确的修改夹具', '/offlineFixture');
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
  revisionEnsure(target, '待审修改的目标概念不存在', '/revisionId', 'TARGET_NOT_FOUND');
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
  '反馈对应的待审稿已改变或失效；请刷新后基于当前待审稿重试', '/revisionId', 'STALE_PENDING_REVISION');
  binding(project, { conceptId: source.targetConceptId, baseVersion: request.baseVersion });
  revisionEnsure(source.baseVersion === project.version, '待审修改的基础版本已过期', '/baseVersion', 'STALE_PROJECT_VERSION');
  const target = project.concepts.find(concept => concept.id === source.targetConceptId);
  revisionEnsure(source.changes.every(change => REVISION_FIELDS.includes(change.field) && same(target[change.field], change.before)),
    '正式内容已改变；原待审稿不能作为反馈基础', '/changes', 'STALE_PROJECT_VERSION');
  return source;
}
export function beginPendingFeedback(project, revisionId, input) {
  revisionEnsure(exactKeys(input, ['baseVersion', 'text']), '待审反馈只能指定正式版本与反馈文本');
  revisionEnsure(project.revisionRequest?.status !== 'running', '当前修改请求仍在处理，不能替换', '/', 'REVISION_IN_PROGRESS');
  revisionEnsure(nonempty(input.text), '请输入对待审稿的反馈', '/text');
  const source = project.revisions?.find(record => record.id === revisionId && record.projectId === project.id);
  revisionEnsure(source?.status === 'pending', '反馈对应的待审稿已改变或失效', '/revisionId', 'STALE_PENDING_REVISION');
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
    '证据引用含未允许字段', path);
  const card = project.evidence.find(record => record.id === link.evidenceId && record.projectId === project.id);
  revisionEnsure(card && card.relevant !== false, '证据不存在、跨项目或已标为无关', `${path}/evidenceId`, 'EVIDENCE_REFERENCE_INVALID');
  const entity = card.returnedEntities?.find(record => (record.id ?? record.entity_id) === link.entityId);
  revisionEnsure(entity && nonempty(link.observedField), '证据未返回该实体或字段', `${path}/entityId`, 'EVIDENCE_ENTITY_INVALID');
  const parts = link.observedField.split('.');
  let actual = entity;
  for (const part of parts) {
    revisionEnsure(!['__proto__', 'prototype', 'constructor'].includes(part) && actual && typeof actual === 'object'
      && Object.hasOwn(actual, part), '证据实际返回中不存在该字段', `${path}/observedField`, 'EVIDENCE_FIELD_MISSING');
    actual = actual[part];
  }
  revisionEnsure(same(actual, link.observedValue), '引用值与证据实际返回不一致', `${path}/observedValue`, 'EVIDENCE_VALUE_MISMATCH');
  const basis = /^(short_|long_)?description$/.test(parts.at(-1)) ? 'description' : parts.at(-1) === 'affinity' ? 'affinity' : 'returned_field';
  revisionEnsure(!link.basis || link.basis === basis, '描述与文化亲和关联的证据类型不可互换', `${path}/basis`, 'EVIDENCE_BASIS_MISMATCH');
  revisionEnsure(nonempty(link.inspiration), '请说明设计推断并保留未验证边界', `${path}/inspiration`);
  return { evidenceId: link.evidenceId, entityId: link.entityId, observedField: link.observedField,
    observedValue: structuredClone(actual), basis,
    observation: `实际返回 ${link.observedField} = ${JSON.stringify(actual)}；${basis === 'affinity'
      ? '仅为本次请求的文化亲和关联，不是描述、设计评分或效果预测。'
      : basis === 'description' ? '这是实体描述，不是文化亲和关联分数或受众效果证据。' : '仅能证明该字段实际返回。'}`,
    inspiration: link.inspiration };
}
function checkRevisionField(project, field, after, before, path) {
  if (['title', 'coreClaim'].includes(field)) revisionEnsure(nonempty(after), '修改后的文字不能为空', path);
  else if (field === 'mechanism') revisionEnsure(exactKeys(after, ['organization', 'description'])
    && nonempty(after.organization) && nonempty(after.description), '参与机制必须包含组织方式与说明', path);
  else if (field === 'journey') revisionEnsure(Array.isArray(after) && after.length >= 3
    && after.every(step => exactKeys(step, ['stage', 'action']) && nonempty(step.stage) && nonempty(step.action)), '体验旅程需包含至少三个有效阶段', path);
  else if (field === 'evidenceLinks') {
    revisionEnsure(Array.isArray(after), '概念证据引用必须为数组', path);
    // Historical links are preserved byte-for-byte; only newly supplied links are checked.
    return after.map((link, index) => before.some(old => same(old, link)) ? structuredClone(link)
      : checkedEvidenceRef(project, link, `${path}/${index}`));
  } else revisionEnsure(stringArray(after) && (!['productTouchpoints', 'unverifiedEffects'].includes(field) || after.length > 0), '修改后的条目格式无效或缺少必要内容', path);
  return structuredClone(after);
}
export function proposeRevision(project, input) {
  revisionEnsure(exactKeys(input, ['requestId', 'phase', 'summary', 'question', 'changes', 'impact', 'unknowns']), '局部修改工具不能指定项目、目标、版本或覆盖项目', '/');
  const request = project.revisionRequest;
  revisionEnsure(request && request.status === 'running' && input.requestId === request.id, '修改请求不存在或已结束', '/requestId', 'REVISION_REQUEST_MISMATCH');
  binding(project, { conceptId: request.targetConceptId, baseVersion: request.baseVersion });
  const source = request.kind === 'pending_feedback' ? checkedFeedbackSource(project, request) : null;
  revisionEnsure(['pending', 'needs_input', 'conflict'].includes(input.phase) && nonempty(input.summary), '修改状态或说明无效', '/phase');
  revisionEnsure(Array.isArray(input.changes) && stringArray(input.impact) && stringArray(input.unknowns), '修改、影响与未知项须为数组', '/changes');
  if (input.phase !== 'pending') {
    revisionEnsure(input.changes.length === 0 && nonempty(input.question), '待澄清或冲突须提出一个问题，不能同时修改', '/question');
    finishRevisionRequest(project, request, input.phase, input.summary); request.question = input.question;
    const feedback = project.revisionFeedback?.find(record => record.id === request.feedbackId);
    if (feedback) feedback.question = input.question;
    project.status = { phase: input.phase === 'conflict' ? 'revision_conflict' : 'revision_needs_input', detail: input.summary };
    return { status: input.phase, question: input.question };
  }
  revisionEnsure(input.changes.length > 0 && input.unknowns.length > 0, '待审修改需包含实际差异与未知项', '/changes');
  const target = project.concepts.find(concept => concept.id === request.targetConceptId);
  const draft = source ? pendingRevisionDraft(project, source) : target;
  const changed = new Set();
  const changes = input.changes.map((change, index) => {
    const path = `/changes/${index}`;
    revisionEnsure(exactKeys(change, ['field', 'after', 'reason', 'evidenceRefs']), '修改只允许字段、修改后内容、理由及证据引用；修改前内容由服务端读取', path);
    revisionEnsure(REVISION_FIELDS.includes(change.field) && !changed.has(change.field), '目标字段不允许修改或重复', `${path}/field`, 'REVISION_FIELD_NOT_ALLOWED');
    revisionEnsure(!(project.lockedFields ?? []).includes(change.field), '请求涉及锁定字段，需先由用户明确解锁', `${path}/field`, 'FIELD_LOCKED');
    changed.add(change.field);
    revisionEnsure(nonempty(change.reason) && Array.isArray(change.evidenceRefs), '每项修改须说明理由与实际证据引用', path);
    const before = structuredClone(draft[change.field]);
    const after = checkRevisionField(project, change.field, change.after, before, `${path}/after`);
    revisionEnsure(!same(before, after), source ? '反馈修改必须与当前待审稿有实际差异' : '待审修改必须与正式内容有实际差异', `${path}/after`);
    return { field: change.field, before, after, reason: change.reason,
      evidenceRefs: change.evidenceRefs.map((link, i) => checkedEvidenceRef(project, link, `${path}/evidenceRefs/${i}`)) };
  });
  const candidate = { ...draft, ...Object.fromEntries(changes.map(change => [change.field, change.after])) };
  const consolidated = source ? REVISION_FIELDS.filter(field => !same(target[field], candidate[field])).map(field => {
    const change = changes.find(item => item.field === field) ?? source.changes.find(item => item.field === field);
    revisionEnsure(!(project.lockedFields ?? []).includes(field), '合并后的待审稿包含锁定字段，需由用户先明确解锁', '/changes', 'FIELD_LOCKED');
    return { ...structuredClone(change), field, before: structuredClone(target[field]), after: structuredClone(candidate[field]) };
  }) : changes;
  revisionEnsure(consolidated.length > 0, '修订后的待审稿须与正式内容有实际差异；如需撤回请明确拒绝待审稿', '/changes');
  const active = [candidate.coreClaim, candidate.mechanism.description,
    ...candidate.journey.map(step => step.action), ...candidate.productTouchpoints].join(' ');
  for (const required of project.brief.mustKeep) revisionEnsure(active.includes(required), '局部修改丢失必须保留项', '/changes', 'REQUIRED_ITEM_MISSING');
  for (const forbidden of project.brief.avoid) revisionEnsure(!active.includes(forbidden), '局部修改包含禁止项', '/changes', 'FORBIDDEN_ITEM_PRESENT');
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
  revisionEnsure(exactKeys(input, ['baseVersion']), '审查操作只能提交当前正式版本');
  revisionEnsure(Number.isInteger(input.baseVersion), '审查操作须提供显示中的基础版本', '/baseVersion');
  revisionEnsure(['accept', 'reject'].includes(decision), '未知的审查操作');
  const revision = project.revisions?.find(record => record.id === revisionId && record.projectId === project.id);
  revisionEnsure(revision, '待审修改不存在', '/revisionId', 'REVISION_NOT_FOUND');
  revisionEnsure(revision.status === 'pending', '该修改已处理，不能重复批准或拒绝', '/revisionId', 'REVISION_ALREADY_DECIDED');
  revisionEnsure(!(project.revisionRequest?.status === 'running' && project.revisionRequest.kind === 'pending_feedback'
    && project.revisionRequest.sourceRevisionId === revision.id), '正在根据反馈修订此待审稿，请等待处理结束后再审查', '/revisionId', 'REVISION_IN_PROGRESS');
  if (decision === 'reject') {
    // Rejection never applies changes. Older clients may have left pending
    // records whose target, before values or base version can no longer apply.
    revision.status = 'rejected';
    revision.decidedAt = new Date().toISOString();
    if (!project.revisions.some(record => record.status === 'pending') && project.revisionRequest?.status !== 'running')
      project.status = { phase: 'ready', detail: '已拒绝待审修改；正式版本保持不变' };
    return project;
  }
  revisionEnsure(input.baseVersion === project.version && revision.baseVersion === project.version,
    '待审修改的基础版本已过期；正式版保持不变', '/baseVersion', 'STALE_PROJECT_VERSION');
  binding(project, { conceptId: revision.targetConceptId, baseVersion: revision.baseVersion });
  const target = project.concepts.find(concept => concept.id === revision.targetConceptId);
  for (const change of revision.changes) {
    revisionEnsure(REVISION_FIELDS.includes(change.field) && same(target[change.field], change.before), '正式内容已改变；请重新提出修改', '/changes', 'STALE_PROJECT_VERSION');
    revisionEnsure(!(project.lockedFields ?? []).includes(change.field), '目标字段已锁定；正式版保持不变', '/changes', 'FIELD_LOCKED');
  }
  for (const change of revision.changes) target[change.field] = structuredClone(change.after);
  project.version++;
  revision.confirmedVersion = project.version;
  rememberVersion(project, revision.id);
  revision.status = 'accepted';
  revision.decidedAt = new Date().toISOString();
  project.status = { phase: 'ready', detail: '局部修改已批准为正式版本' };
  return project;
}

export function configStatus(env = process.env) {
  const required = ['ART_MODEL_PROVIDER', 'ART_MODEL_ID', 'ART_MODEL_API', 'ART_MODEL_BASE_URL', 'ART_MODEL_API_KEY', 'QLOO_API_KEY', 'QLOO_API_URL'];
  const missing = required.filter(name => !env[name]?.trim());
  const enabled = env.ART_ENABLE_LIVE === 'true';
  return { modes: { offline: { available: true, synthetic: true },
    live: { available: enabled && missing.length === 0, enabled, missing,
      modelKeyPresent: Boolean(env.ART_MODEL_API_KEY), qlooKeyPresent: Boolean(env.QLOO_API_KEY),
      detail: enabled ? '真实模式仍需使用明确提供商、模型与端点，并在总额度内执行' : '真实模式未获单独启用；本地离线演示可用' } },
    runtime: { name: '@qloo/qloo-harness', version: '0.1.26' }, limits: LIMITS, serverLimits: SERVER_LIMITS };
}
