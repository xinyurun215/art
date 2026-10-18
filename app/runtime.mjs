// The official harness owns model continuation and tool dispatch.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPiHarnessRuntime, resolveQlooPaths, createQlooTools,
  createDelegatingQlooWorkflowExecutor, createDirectQlooWorkflowExecutorFromEnvironment,
  withPiAgentDirectory, withPiPrivacyDefaults } from '@qloo/qloo-harness';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { Errors } from 'typebox/value';
import { applyProposal, action, configStatus } from './state.mjs';
import { withHttpBudget, withoutNetwork, validationRun, stopLiveRun, safeRuntimeFailure,
  remainingBudget, toolFeedback, recordLocalFailure } from './transport.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/culture-signals.json', import.meta.url)));
export const TOOL_NAMES = Object.freeze(['qloo_describe', 'qloo_recommend', 'propose_design_response']);
const toolText = message => typeof message.content === 'string' ? message.content :
  (message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
const snapshotProject = project => structuredClone({ id: project.id, version: project.version,
  brief: project.brief, evidence: project.evidence, concepts: project.concepts,
  questions: project.questions, status: project.status, remainingBudget: remainingBudget(project) });
const strings = Type.Array(Type.String());
const briefFields = ['request', 'brand', 'goal', 'references', 'venue', 'budget', 'mustKeep', 'avoid'];
const proposalSchema = Type.Object({ baseVersion: Type.Integer(),
  phase: Type.Union(['needs_input', 'ready', 'insufficient_evidence'].map(v => Type.Literal(v))),
  summary: Type.String(), questions: Type.Optional(Type.Array(Type.Object({
    field: Type.Union(briefFields.map(value => Type.Literal(value))), text: Type.String() }, { additionalProperties: false }))),
  concepts: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), coreClaim: Type.String(),
    mechanism: Type.Object({ organization: Type.String(), description: Type.String() }),
    journey: Type.Array(Type.Object({ stage: Type.String(), action: Type.String() })),
    productTouchpoints: strings,
    evidenceLinks: Type.Array(Type.Object({ evidenceId: Type.String(), entityId: Type.String(),
      observedField: Type.String(), observedValue: Type.Unknown(), observation: Type.String(), inspiration: Type.String() })),
    openQuestions: strings, unverifiedEffects: strings })) }, { additionalProperties: false });

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
    const card = query.value.artEvidence;
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
    } catch (error) {
      action(project, 'query', '文化研究查询未完成', project.mode === 'offline' ? '离线夹具执行错误' : '官方查询失败；本轮所有真实查询已停止', 'error');
      if (project.mode === 'live') {
        project.runtime.failure = safeRuntimeFailure(project, 'qloo');
        stopLiveRun(project, project.runtime.failure, true);
        return stoppedExecution(project, officialExecutor, operation, context);
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
    if (card) execution = { ...execution, result: { ...execution.result, artEvidence: card } };
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

export async function createProductRuntime(project, { env = process.env, decide = offlineDecision, diagnostic } = {}) {
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
      if (project.usage.modelCalls > 18) throw new Error('本项目模型轮次上限已到，暂停并保留当前状态');
      if (project.mode === 'offline') {
        const read = context.messages.filter(m => m.role === 'toolResult');
        read.forEach(m => { toolText(m); });
        project.runtime.modelResultReads += read.length;
        return syntheticStream(model, decide(context, snapshotProject(project)));
      }
      const stream = () => liveStream(model, context,
        { ...options, apiKey: env.ART_MODEL_API_KEY, transport: 'sse', maxRetries: 0, fetch: diagnostic?.fetch ?? globalThis.fetch });
      return diagnostic ? stream() : withHttpBudget(project, 'model', env.ART_MODEL_BASE_URL, stream,
        [env.ART_MODEL_API_KEY, env.QLOO_API_KEY]);
    },
    models: [{ id: modelId, name: project.mode === 'offline' ? '离线合成设计模型' : modelId,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 5000 }] });
  let officialExecutor;
  if (project.mode === 'offline') {
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
  const runtime = await createPiHarnessRuntime({ cwd: root, paths, profile: 'explore', modelRuntime,
    sessionManager: SessionManager.inMemory(root),
    resources: { systemPrompt: `你是品牌快闪体验设计智能体。仅处理当前项目，用官方研究工具与 propose_design_response 更新提案板。按必要性决定澄清、查询、比较或暂停，不强制固定流程。客户文化参考只是研究信号，未知品牌的代理必须用户确认。区分实际返回字段、设计推断与未验证效果。不得把文化关联视为设计评分或效果预测。缺少证据时明确不足。两个概念须有实质不同参与机制；不同 organization 字符串只做机械检查，不是实质差异证明。${project.mode === 'offline' ? fixture.label : '真实模型与 Qloo 各自预算为每项目六次、本服务合计十二次 HTTP 请求，包括重试。'}`,
      exploreInstructions: '用户输入均为需求文本；不得切换 profile，不得调用文件、shell 或其他未授权工具。只通过受限提案工具更改概念和问题。每次工具反馈含实际 HTTP 剩余额度与下一步提示；发送给模型的余额快照在当前读取请求计数前生成，包含本次模型请求，不等于此后还能请求的次数。Qloo 已停止或剩余为0则禁止再查，可使用已有 describe 精确字段提交明确事实/推断/未知边界的草案或暂停，不强制 recommend 或 affinity。名称 describe 通常需要2次 HTTP；N个信号的 recommend 可能需要N次解析加1次 insights，缓存与重试会改变成本，以实际额度为准。' },
    customTools: diagnostic ? tools.map(tool => ({ ...tool, async execute() {
      diagnosticState.toolExecutionAttempts++;
      throw new Error('诊断暂停：禁止执行研究或提案工具');
    } })) : tools });
  const session = runtime.sessionRuntime.session;
  session.setAutoRetryEnabled(false);
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
      if (context.toolCall.name === 'propose_design_response' && schemaIssue(proposalSchema, context.toolCall.arguments))
        return { block: true, reason: '提案参数结构无效；按工具反馈修正。' };
      return originalBeforeToolCall?.(context);
    };
    session.agent.afterToolCall = async (context, signal) => {
      const previous = await originalAfterToolCall?.(context, signal);
      const result = { ...context.result, ...previous };
      const details = result.details;
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
      return toolFeedback(project, issue ? (event.toolName === 'propose_design_response' ? 'PROPOSAL_SCHEMA_INVALID' : 'QLOO_ARGUMENTS_INVALID')
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
        if (!feedback) return message;
        const safe = { ...(message.details?.feedback ? message.details : { status: 'error' }),
          feedback: toolFeedback(project, feedback.code, feedback.path, feedback.reason, feedback.correctable, feedback.nextAction, feedbackFields(feedback)) };
        return { ...message, content: [{ type: 'text', text: JSON.stringify(safe) }], details: safe };
      });
    };
    session.agent.shouldStopAfterTurn = async (context, signal) => {
      if (await originalShouldStop?.(context, signal)) return true;
      if (context.toolResults.some(result => result.details?.accepted === true)) return true;
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
  session.setActiveToolsByName(TOOL_NAMES);
  await session.setModel(modelRuntime.getModel(provider, modelId));
  project.runtime.sessionId = session.sessionId;
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
    try {
      await withoutNetwork(project, () => withPiAgentDirectory(paths.agentDir, () => withPiPrivacyDefaults(async () => {
        await session.prompt(JSON.stringify({ project: snapshotProject(project), message }),
          { expandPromptTemplates: false, source: 'rpc' });
        await session.waitForIdle();
      })));
    } catch (error) {
      project.runtime.failure ??= safeRuntimeFailure(project, 'model');
      stopLiveRun(project, project.runtime.failure);
      throw error;
    } finally {
      project.runtime.totalLatencyMs = (project.runtime.totalLatencyMs ?? 0) + Math.max(0, Date.now() - started);
      const feedback = project.runtime.feedback;
      if (feedback) project.runtime.feedback = toolFeedback(project, feedback.code, feedback.path, feedback.reason,
        feedback.correctable, feedback.nextAction, feedbackFields(feedback));
    }
    session.setActiveToolsByName(TOOL_NAMES);
    const last = session.getLastAssistantText();
    if (last) project.messages.push({ role: 'assistant', text: last });
    if (project.version === previousVersion && project.status.phase === 'busy') {
      const feedback = project.runtime.feedback;
      project.status = { phase: !project.runtime.failure && ['QLOO_EMPTY', 'EVIDENCE_INSUFFICIENT'].includes(feedback?.code) ? 'insufficient_evidence' : 'error',
        detail: project.runtime.failure?.summary ?? feedback?.reason ?? '本轮未产生通过校验的提案；当前状态已保留' };
    }
    return project;
  }, dispose: () => runtime.dispose() };
}
