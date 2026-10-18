import { randomUUID } from 'node:crypto';

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
  project.concepts = structuredClone(proposal.concepts);
  project.questions = (proposal.questions ?? []).map(q => ({ id: randomUUID(), field: q.field, text: q.text }));
  project.status = { phase: proposal.phase, detail: proposal.summary };
  project.version++;
  return { accepted: true, projectId: project.id, version: project.version, phase: project.status.phase,
    conceptIds: project.concepts.map(c => c.id), synthetic: project.mode === 'offline' };
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
