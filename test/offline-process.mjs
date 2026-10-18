import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';

let attempts = 0;
const deny = () => { attempts++; throw new Error('Offline test attempted network'); };
globalThis.fetch = deny;
const require = createRequire(import.meta.url);
for (const [name, methods] of [['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']]]) {
  const api = require(name);
  for (const method of methods) api[method] = deny;
  if (name === 'node:net') api.Socket.prototype.connect = deny;
}
syncBuiltinESMExports();
const { createProject } = await import('../app/state.mjs');
const { createProductRuntime } = await import('../app/runtime.mjs');
const project = createProject({ brief: { request: '虚构运动鞋新品快闪', brand: '虚构品牌', references: ['虚构音乐参考'], mustKeep: ['试穿'] } });
const runtime = await createProductRuntime(project, { env: {} });
try {
  const sessionId = runtime.session.sessionId;
  await runtime.submit(project.brief.request);
  assert.equal(project.status.phase, 'needs_input');
  assert.equal(project.questions[0].field, 'venue');
  assert.equal(project.evidence.length, 0);
  const firstCalls = project.usage.modelCalls;
  project.brief.venue = '上海室内150平方米';
  project.questions = [];
  project.version++;
  project.status.phase = 'busy';
  await runtime.submit('上海室内150平方米');
  assert.equal(runtime.session.sessionId, sessionId);
  assert.equal(project.status.phase, 'ready');
  assert.equal(project.evidence.length, 1);
  assert.equal(project.concepts.length, 2);
  assert.equal(project.usage.modelCalls, firstCalls + 2);
  assert(project.runtime.modelResultReads > 0);
  const results = runtime.session.messages.filter(m => m.role === 'toolResult');
  const research = results.find(m => m.toolName === 'qloo_recommend');
  const content = JSON.parse(research.content.find(c => c.type === 'text').text);
  assert.equal(content.artEvidence.id, project.concepts[0].evidenceLinks[0].evidenceId);
  assert.equal(content.results[0].properties.participation, project.concepts[0].evidenceLinks[0].observedValue);
  assert.equal(content.results[1].properties.participation, project.concepts[1].evidenceLinks[0].observedValue);
  assert(project.evidence.every(e => e.synthetic));
  assert.equal(project.usage.modelHttpAttempts, 0);
  assert.equal(project.usage.qlooHttpAttempts, 0);
  assert.equal(attempts, 0);
  console.log(JSON.stringify({ noCredentialEnvironment: true, networkAttempts: attempts, sessionId,
    clarificationAndContinuationSameSession: true, officialToolResultRead: true,
    toolNames: project.runtime.toolNames, usage: project.usage, conceptCount: project.concepts.length,
    evidenceCount: project.evidence.length }));
} finally { await runtime.dispose(); }
