// Explicit offline browser fixture. It never reads .env or historical projects.
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createAppServer } from '../app/server.mjs';
import { offlineDecision } from '../app/runtime.mjs';

const dataDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'art-reference-page-'));
const port = Number(process.argv[3] || 3041);
const fixture = JSON.parse(readFileSync(new URL('../fixtures/culture-signals.json', import.meta.url)));
const candidates = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'North Light', type: 'urn:entity:movie', release_year: 1995,
    description: '明确模拟返回：1995年电影，创作者 Synthetic One；非真实 Qloo 数据。' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'North Light', type: 'urn:entity:movie', release_year: 2015,
    description: '明确模拟返回：字段年份2015，描述提及2016；创作者 Synthetic Two。保持原样，不自动纠正。' }
];
const calls = [];
const qlooExecutor = { transport: { kind: 'direct', name: 'explicit-synthetic-page-fixture', remote: false }, async execute(operation, input) {
  calls.push({ operation, input: structuredClone(input) });
  const values = /North Light/i.test(input.entity ?? '') ? candidates : [];
  return { correlationId: 'explicit-synthetic-no-http', result: operation === 'describe'
    ? { status: 'needs_input', results: [], resolution: { issues: [{ input: input.entity, field: 'entity', input_kind: 'entity',
      kind: values.length ? 'ambiguous' : 'not_found', candidates: values }] } }
    : { status: 'ok', synthetic: true, summary: fixture.label, results: structuredClone(fixture.sufficient) } };
} };
const app = createAppServer({ env: {}, dataDir, runtimeOptions: { qlooExecutor, decide(context, snapshot) {
  if (!snapshot.referenceResolution.records.length || snapshot.referenceResolution.unresolvedCount) return [{ type: 'toolCall',
    id: `synthetic-resolution-${Date.now()}`, name: 'qloo_describe', arguments: {
      entity: snapshot.brief.references[0] ?? 'North Light', type: 'movie' } }];
  return offlineDecision(context, snapshot);
} } });
app.server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`,
  dataDir, synthetic: true, realDeepSeekRequests: 0, realQlooRequests: 0,
  reference: '电影《North Light》', note: '明确离线模拟；使用完整场地条件与此参考建立项目，刷新或以同一dataDir重启可恢复。' })));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.dispose();
  console.log(JSON.stringify({ syntheticExecutorCalls: calls }));
  process.exit(0);
}
process.on('SIGINT', shutdown);
createInterface({ input: process.stdin }).on('line', line => { if (line.trim() === 'stop') void shutdown(); });
