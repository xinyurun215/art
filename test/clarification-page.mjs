// Explicit offline UI fixture: no .env, historical projects or external tools.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createAppServer } from '../app/server.mjs';

const dataDir = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'art-clarification-page-'));
const port = Number(process.argv[3] || 3042);
const app = createAppServer({ env: {}, dataDir, runtimeOptions: { decide(context, snapshot) {
  const work = JSON.parse(context.messages[0].content[0].text).project;
  assert.equal(work.brief.request, snapshot.brief.request);
  assert.deepEqual(work.clarifications, (snapshot.clarifications ?? []));
  const count = work.clarifications.length;
  console.log(JSON.stringify({ event: 'offline-model-view', projectId: snapshot.id, clarificationCount: count,
    originalRequestPresent: Boolean(work.brief.request), answerAssociationCount: work.clarifications.filter(record => record.questionId && record.question && record.answer).length,
    explicitUpdateCount: work.clarifications.filter(record => record.briefUpdate?.explicit || record.revisesRequest).length,
    modelHttpAttempts: snapshot.remainingBudget.caseLimits.modelHttpAttempts - snapshot.remainingBudget.caseRemaining.modelHttpAttempts,
    qlooHttpAttempts: snapshot.remainingBudget.caseLimits.qlooHttpAttempts - snapshot.remainingBudget.caseRemaining.qlooHttpAttempts }));
  return [{ type: 'toolCall', id: `synthetic-page-${snapshot.version}`, name: 'propose_design_response', arguments: {
    baseVersion: snapshot.version, phase: count < 3 ? 'needs_input' : 'insufficient_evidence',
    summary: count < 3 ? '明确离线澄清夹具；仅验证保存与恢复，无真实研究。' : '离线验收已保存三次回答；暂停，不生成文化证据或概念。',
    questions: count < 3 ? [{ field: ['request', 'budget', 'avoid'][count], text: [
      '还有影响参与方式的其他条件吗？简短回答会保留原始需求及已有条件。',
      '预算需要补充或明确修改吗？普通答案保留已有预算；展开明确修改可填写新的完整预算。',
      '禁止项需要补充或明确修改吗？可用明确修改控件只移除一项，其余条目保留。'][count] }] : [], concepts: [] } }];
} } });
app.server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, dataDir,
  synthetic: true, realDeepSeekRequests: 0, realQlooRequests: 0, note: '页面新建离线项目，依次原需求/预算/禁止项澄清；stop 正常关闭，同一 dataDir+port 重启恢复。' })));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true; await app.dispose(); console.log(JSON.stringify({ event: 'graceful-stop', dataDir })); process.exit(0);
}
process.on('SIGINT', shutdown);
createInterface({ input: process.stdin }).on('line', line => { if (line.trim() === 'stop') void shutdown(); });
