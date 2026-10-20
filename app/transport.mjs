import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { LIMITS, SERVER_LIMITS } from './state.mjs';

const context = new AsyncLocalStorage();
const originalFetch = globalThis.fetch;
export const serverUsage = { modelHttpAttempts: 0, qlooHttpAttempts: 0 };
export const validationRun = { queryStopped: false, liveStopped: false, attempts: [] };

function projectLimits(project) {
  const validation = project.runtime.validation;
  return validation && Number.isInteger(validation.modelHttpLimit) && validation.modelHttpLimit >= 0
    && validation.modelHttpLimit <= 10 && validation.qlooHttpLimit === 0
    ? { modelHttpAttempts: validation.modelHttpLimit, qlooHttpAttempts: 0 } : LIMITS;
}

export function remainingBudget(project) {
  const limits = projectLimits(project);
  const caseRemaining = {}, sharedRemaining = {};
  for (const key of Object.keys(LIMITS)) {
    caseRemaining[key] = Math.max(0, limits[key] - project.usage[key]);
    sharedRemaining[key] = Math.max(0, SERVER_LIMITS[key] - serverUsage[key]);
  }
  const queryStopped = Boolean(project.runtime.queryStopped || (project.mode === 'live' && validationRun.queryStopped));
  return { modelHttpAttempts: Math.min(caseRemaining.modelHttpAttempts, sharedRemaining.modelHttpAttempts),
    qlooHttpAttempts: queryStopped ? 0 : Math.min(caseRemaining.qlooHttpAttempts, sharedRemaining.qlooHttpAttempts),
    caseRemaining, sharedRemaining, caseLimits: limits, sharedLimits: SERVER_LIMITS, queryStopped };
}

export function toolFeedback(project, code, path, reason, correctable = false, nextAction, diagnostic) {
  const remaining = remainingBudget(project);
  return { code, path, reason, correctable,
    ...(diagnostic && ['expectedType', 'actualType', 'valueState'].every(key => typeof diagnostic[key] === 'string')
      ? { expectedType: diagnostic.expectedType, actualType: diagnostic.actualType, valueState: diagnostic.valueState } : {}),
    remainingBudget: remaining,
    nextAction: remaining.modelHttpAttempts === 0 ? '模型 HTTP 额度已用尽；保留当前状态并暂停，禁止继续模型请求。'
      : remaining.qlooHttpAttempts === 0 ? project.revisionRequest
        ? '禁止继续 Qloo 查询；仅使用已有精确证据提出 pending 待审修改，或以 needs_input/conflict 提出一个问题并暂停；正式版本保持不变。'
        : '禁止继续 Qloo 查询；仅使用已有精确证据提交标明边界的草案，或以 insufficient_evidence 暂停。'
      : nextAction ?? '根据反馈修正参数；引用已有实际字段，证据不足则以 insufficient_evidence 提交草案或暂停。' };
}

export function recordLocalFailure(project, kind, code, reason) {
  const feedback = toolFeedback(project, code, '/', reason);
  project.runtime.feedback = feedback;
  project.runtime.localFailure = { kind, status: null, stopReason: 'error', ...feedback, summary: reason };
  return new Error(reason);
}

export function modelOutputLimit(body) {
  return body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens ?? null;
}

function redactDiagnosticText(value, secrets) {
  let text = String(value);
  for (const secret of secrets.filter(value => typeof value === 'string' && value)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/["']?authorization["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, 'authorization: [REDACTED]')
    .replace(/\b(Bearer|Basic|Token)\s+[^\s"',;]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/["']?\b(?:api[_-]?key|access[_-]?token|token|secret|password)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, 'credential: [REDACTED]')
    .replace(/["']?\b(?:request|body|messages|headers)["']?\s*[:=]\s*(?:[\[{]|"?(?:POST|GET|PUT|PATCH|DELETE)\b)[\s\S]*/gi, '[REDACTED_REQUEST_DETAILS]')
    .replace(/[\[{][\s\S]*$/, '[REDACTED_STRUCTURED_DETAILS]');
}

// Read only a bounded clone; the SDK still receives the original response.
// Cancellation of a tee branch must not be awaited before its sibling is read.
export async function safeProviderError(response, secrets = []) {
  const reader = response.clone().body?.getReader();
  if (!reader) return {};
  let timer;
  const expired = Symbol('timeout');
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(expired), 1000); });
  try {
    const chunks = [];
    let bytes = 0;
    while (bytes < 8192) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk === expired) return {};
      if (chunk.done) {
        const raw = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        const error = raw?.error && typeof raw.error === 'object' && !Array.isArray(raw.error) ? raw.error : raw;
        if (!error || typeof error !== 'object' || Array.isArray(error)) return {};
        const safe = {};
        for (const [field, limit] of Object.entries({ code: 128, type: 128, param: 256, message: 512 })) {
          const value = error[field];
          if (value === null) safe[field] = null;
          else if (field === 'code' && typeof value === 'number' && Number.isFinite(value)) safe[field] = value;
          else if (typeof value === 'string')
            safe[field] = redactDiagnosticText(value, secrets).slice(0, limit);
        }
        return safe;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 8192) return {};
      chunks.push(chunk.value);
    }
    return {};
  } catch { return {}; }
  finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export function summarizeModelRequest(body) {
  const fields = ['model', 'messages', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'tools', 'tool_choice', 'store'];
  return {
    fields: fields.filter(field => Object.hasOwn(body, field)),
    unexpectedFieldCount: Object.keys(body).filter(field => !fields.includes(field)).length,
    model: body.model === 'deepseek-flash' ? body.model : 'unexpected-model',
    stream: body.stream === true,
    maxTokens: Number.isInteger(body.max_tokens) ? body.max_tokens : null,
    streamOptions: { includeUsage: body.stream_options?.include_usage === true,
      otherFieldCount: Object.keys(body.stream_options ?? {}).filter(field => field !== 'include_usage').length },
    messageRoles: Array.isArray(body.messages) ? body.messages.map(message => ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ? message.role : 'unknown') : [],
    tools: Array.isArray(body.tools) ? body.tools.map(tool => {
      const schema = tool.function?.parameters;
      return { type: tool.type === 'function' ? 'function' : 'unexpected',
        name: ['qloo_describe', 'qloo_recommend', 'propose_design_response'].includes(tool.function?.name) ? tool.function.name : 'unexpected-tool',
        strict: tool.function?.strict ?? null,
        parameterType: schema?.type === 'object' ? 'object' : 'unexpected',
        propertyNames: Object.keys(schema?.properties ?? {}), required: schema?.required ?? [],
        parametersSha256: createHash('sha256').update(JSON.stringify(schema ?? null)).digest('hex') };
    }) : [],
  };
}

// A fresh diagnostic process has a separate 1-model / 0-Qloo ledger. This guard
// runs before every underlying fetch, independently of the product's 6/12 caps.
export function createDiagnosticFetch(implementation = originalFetch, secrets = []) {
  const ledger = { modelHttpAttempts: 0, qlooHttpAttempts: 0, blockedHttpAttempts: 0, attempts: [] };
  let reserved = false;
  return { ledger, async fetch(url, options = {}) {
    const destination = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
    const method = String(options.method ?? url?.method ?? 'GET').toUpperCase();
    if (destination.href !== 'https://api.deepseek.com/chat/completions' || method !== 'POST' || reserved) {
      ledger.blockedHttpAttempts++;
      throw new Error('诊断只允许一次明确的 DeepSeek 模型请求，禁止后续模型与所有 Qloo 请求');
    }
    reserved = true;
    const body = JSON.parse(typeof options.body === 'string' ? options.body : await url.clone().text());
    if (body.model !== 'deepseek-flash') {
      ledger.blockedHttpAttempts++;
      throw new Error('诊断禁止未批准的模型调用名');
    }
    const entry = { kind: 'model', method, host: destination.host, path: destination.pathname,
      request: summarizeModelRequest(body), status: null, durationMs: null };
    ledger.modelHttpAttempts++;
    ledger.attempts.push(entry);
    const started = Date.now();
    try {
      const response = await implementation(url, { ...options, redirect: 'error' });
      entry.status = response.status;
      entry.outcome = response.ok ? 'response_ok' : 'http_error';
      if (!response.ok) {
        const safe = await safeProviderError(response, secrets);
        if (Object.keys(safe).length) entry.providerError = safe;
      }
      return response;
    } catch (error) {
      entry.outcome = 'network_error';
      throw error;
    } finally { entry.durationMs = Math.max(0, Date.now() - started); }
  } };
}

export function stopLiveRun(project, failure, stopQueries = false) {
  if (project.mode !== 'live') return;
  if (stopQueries) validationRun.queryStopped = true;
  else validationRun.liveStopped = true;
  validationRun.failure ??= failure;
}

// Only fixed summaries, observed status, and bounded whitelisted provider fields
// leave the server. Raw provider exceptions are never copied.
export function safeRuntimeFailure(project, kind, stopReason = 'error') {
  if (project.runtime.localFailure?.kind === kind) {
    const local = project.runtime.localFailure;
    return { ...local, ...toolFeedback(project, local.code, local.path, local.reason, local.correctable) };
  }
  const attempt = project.runtime.httpAttempts?.findLast(entry => entry.kind === kind);
  const status = Number.isInteger(attempt?.status) && attempt.status >= 400 ? attempt.status : null;
  const code = status === 401 || status === 403 ? 'AUTHENTICATION_ERROR'
    : status === 429 ? 'RATE_LIMIT_ERROR' : status >= 400 ? 'HTTP_ERROR'
    : kind === 'model' ? 'MODEL_PROTOCOL_OR_TRANSPORT_ERROR' : 'TOOLCHAIN_ERROR';
  return { kind, code, status, stopReason: stopReason === 'aborted' ? 'aborted' : 'error',
    ...(attempt?.providerError ? { providerError: attempt.providerError } : {}),
    summary: `${kind === 'model' ? '模型' : '官方工具链'}未完成${status ? `（HTTP ${status}）` : ''}；当前状态已保留，本轮真实验证已停止。` };
}

// Public SDKs retain their own HTTP implementations. This boundary counts each
// actual fetch attempt, including SDK retries, before it can leave the process.
export function budgetedFetch(implementation = originalFetch) {
  return async (url, options = {}) => {
    const current = context.getStore();
    if (!current) throw new Error('HTTP 请求缺少明确的项目额度上下文');
    const { project, kind, origin } = current;
    if (project.mode !== 'live') throw recordLocalFailure(project, kind, 'OFFLINE_HTTP_BLOCKED', '离线模式禁止外部 HTTP 请求');
    const destination = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
    if (destination.origin !== origin) throw recordLocalFailure(project, kind, 'HTTP_ENDPOINT_BLOCKED', '请求端点不在本次明确配置范围内');
    if (kind === 'model' && project.runtime.generationBudget) {
      const body = JSON.parse(typeof options.body === 'string' ? options.body : await url.clone().text());
      const finalMaxTokens = modelOutputLimit(body);
      if (finalMaxTokens !== project.runtime.generationBudget.finalMaxTokens)
        throw recordLocalFailure(project, kind, 'MODEL_CONTEXT_CAPACITY_INSUFFICIENT', '模型实际发送参数与预检容量不符；本地已阻止请求。');
    }
    const key = kind === 'model' ? 'modelHttpAttempts' : 'qlooHttpAttempts';
    if (kind === 'qloo' && (project.runtime.queryStopped || validationRun.queryStopped))
      throw recordLocalFailure(project, kind, 'QLOO_QUERY_STOPPED', '本轮真实查询已经停止');
    if (project.usage[key] >= projectLimits(project)[key] || serverUsage[key] >= SERVER_LIMITS[key])
      throw recordLocalFailure(project, kind, kind === 'model' ? 'MODEL_HTTP_BUDGET_EXHAUSTED' : 'QLOO_HTTP_BUDGET_EXHAUSTED', `${kind} HTTP 总额度已用尽`);
    project.usage[key]++;
    serverUsage[key]++;
    const started = Date.now();
    const entry = { kind, time: new Date(started).toISOString(), status: null, durationMs: null,
      method: String(options.method ?? url?.method ?? 'GET').toUpperCase(), host: destination.host, path: destination.pathname,
      ...(kind === 'model' && project.runtime.generationBudget ? { generationBudget: { ...project.runtime.generationBudget } } : {}) };
    (project.runtime.httpAttempts ??= []).push(entry);
    validationRun.attempts.push(entry);
    // Automatic redirects would hide extra HTTP attempts from this counter.
    try {
      const response = await implementation(url, { ...options, redirect: 'error' });
      entry.status = response.status;
      entry.outcome = response.ok ? 'response_ok' : 'http_error';
      if (!response.ok && kind === 'model') {
        const safe = await safeProviderError(response, current.secrets ?? []);
        if (Object.keys(safe).length) entry.providerError = safe;
      }
      return response;
    } catch (error) {
      entry.outcome = 'network_error';
      throw error;
    } finally { entry.durationMs = Math.max(0, Date.now() - started); }
  };
}

globalThis.fetch = budgetedFetch();
export function withHttpBudget(project, kind, baseUrl, operation, secrets = []) {
  if (project.runtime.localFailure?.kind === kind) delete project.runtime.localFailure;
  return context.run({ project, kind, origin: new URL(baseUrl).origin, secrets }, operation);
}
export function withoutNetwork(project, operation) {
  return context.run({ project, kind: 'model', origin: 'https://offline.invalid' }, operation);
}
