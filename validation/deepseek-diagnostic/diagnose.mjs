import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createProject } from '../../app/state.mjs';
import { createProductRuntime, TOOL_NAMES } from '../../app/runtime.mjs';
import { createDiagnosticFetch } from '../../app/transport.mjs';

export const mockCalls = [
  { name: 'qloo_describe', arguments: { entity: 'Daft Punk', type: 'artist' } },
  { name: 'qloo_recommend', arguments: { target_type: 'artist', signals: ['Daft Punk'], limit: 2 } },
  { name: 'propose_design_response', arguments: { baseVersion: 1,
    phase: 'insufficient_evidence', summary: '仅用于离线暂停验证', questions: [], concepts: [] } },
];

export function mockToolResponse(calls = mockCalls) {
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'offline-diagnostic',
    object: 'chat.completion.chunk', created: 0, model: 'deepseek-flash',
    choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const data = chunk({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index,
    id: `diagnostic-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) })
    + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
  return new Response(data, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const offlineEnvironment = {
  ART_ENABLE_LIVE: 'true', ART_MODEL_PROVIDER: 'deepseek', ART_MODEL_ID: 'deepseek-flash',
  ART_MODEL_API: 'openai-completions', ART_MODEL_BASE_URL: 'https://api.deepseek.com',
  ART_MODEL_API_KEY: 'synthetic-local-diagnostic-key', QLOO_API_KEY: 'synthetic-local-qloo-key',
  QLOO_API_URL: 'https://hackathon.api.qloo.com',
};

export async function runDiagnostic({ live = false, implementation, env = process.env } = {}) {
  const config = live ? { ...env, ART_ENABLE_LIVE: 'true' } : offlineEnvironment;
  if (config.ART_MODEL_PROVIDER !== 'deepseek' || config.ART_MODEL_ID !== 'deepseek-flash' || config.ART_MODEL_API !== 'openai-completions'
      || config.ART_MODEL_BASE_URL !== 'https://api.deepseek.com') throw new Error('诊断配置与已批准的 DeepSeek 调用不符');
  const input = live ? JSON.parse(readFileSync(new URL('../live-workspace/case-one-input.json', import.meta.url)))
    : { brief: { request: '离线合成诊断；仅验证协议与执行前暂停，不代表真实客户或查询',
      venue: '合成测试场地', references: ['合成文化参考'], mustKeep: ['试穿'] } };
  const project = createProject({ mode: 'live', brief: input.brief });
  const transport = createDiagnosticFetch(implementation ?? (live ? undefined : async () => mockToolResponse()),
    [config.ART_MODEL_API_KEY, config.QLOO_API_KEY]);
  project.runtime.httpAttempts = transport.ledger.attempts;
  let runtime;
  let runnerFailure = false;
  const started = Date.now();
  try {
    runtime = await createProductRuntime(project, { env: config, diagnostic: { fetch: transport.fetch } });
    await runtime.submit(project.brief.request);
  } catch { runnerFailure = true; }
  finally { if (runtime) await runtime.dispose(); }
  const assistant = runtime?.session.state.messages.findLast(message => message.role === 'assistant');
  const proposed = (assistant?.content ?? []).filter(part => part.type === 'toolCall');
  project.usage.modelHttpAttempts = transport.ledger.modelHttpAttempts;
  const validResponse = assistant?.stopReason === 'stop'
    ? assistant.content.some(part => part.type === 'text' && part.text.trim())
    : assistant?.stopReason === 'toolUse' && proposed.length > 0 && runtime?.diagnostic.pausedToolNames.length === proposed.length;
  const integrationPassed = Boolean(!runnerFailure && transport.ledger.attempts[0]?.status >= 200
    && transport.ledger.attempts[0]?.status < 300 && validResponse && runtime?.diagnostic.modelCallbacks === 1
    && runtime.diagnostic.blockedModelCallbacks === 0 && runtime.diagnostic.toolExecutionAttempts === 0
    && transport.ledger.modelHttpAttempts === 1 && transport.ledger.qlooHttpAttempts === 0 && transport.ledger.blockedHttpAttempts === 0);
  return {
    mode: live ? 'live' : 'offline-mocked-provider', capturedAt: new Date().toISOString(),
    model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions',
    realHttp: { model: live ? transport.ledger.modelHttpAttempts : 0, qloo: 0 },
    mockedFetchAttempts: live ? 0 : transport.ledger.modelHttpAttempts,
    ledger: transport.ledger, session: { id: project.runtime.sessionId, toolNames: project.runtime.toolNames,
      ...runtime?.diagnostic, autoRetryEnabled: false, autoCompactionEnabled: false },
    response: { stopReason: assistant?.stopReason ?? 'none',
      contentTypes: [...new Set((assistant?.content ?? []).map(part => ['text', 'thinking', 'toolCall'].includes(part.type) ? part.type : 'unknown'))],
      proposedToolNames: proposed.map(part => TOOL_NAMES.includes(part.name) ? part.name : 'unknown'),
      usage: assistant?.usage ? { input: assistant.usage.input, output: assistant.usage.output,
        totalTokens: assistant.usage.totalTokens } : null },
    underlyingToolExecutions: 0,
    projectState: { version: project.version, evidenceCount: project.evidence.length, conceptCount: project.concepts.length },
    integrationPassed, runnerFailure, durationMs: Math.max(0, Date.now() - started),
    boundary: '仅诊断模型请求；所有研究与提案工具均在执行前暂停，未验证产品链路。',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const live = process.argv.length === 3 && process.argv[2] === '--live';
  const offline = process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--offline');
  try {
    if (!live && !offline) throw new Error('仅支持默认离线检查或明确的 --live');
    if (live) writeFileSync(new URL('./LIVE-ATTEMPT.lock', import.meta.url),
      JSON.stringify({ reservedAt: new Date().toISOString(), modelHttpLimit: 1, qlooHttpLimit: 0 }) + '\n', { flag: 'wx' });
    const result = await runDiagnostic({ live });
    writeFileSync(new URL(live ? './LIVE-RESULT.json' : './OFFLINE-INSPECTION.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
    if (!result.integrationPassed) process.exitCode = 1;
  } catch {
    console.error('诊断未运行或未完成；配置、一次运行保留文件或本地初始化未通过。没有输出原始异常。');
    process.exitCode = 1;
  }
}
