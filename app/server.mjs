import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProject, action, configStatus, list, selectConcept, beginRevision, beginPendingFeedback,
  finishRevisionRequest, decideRevision } from './state.mjs';
import { createProductRuntime } from './runtime.mjs';
import { validationRun, stopLiveRun, safeRuntimeFailure } from './transport.mjs';

const publicRoot = fileURLToPath(new URL('../public', import.meta.url));
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };

async function body(request) {
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 32768) throw new Error('输入超过本地演示上限');
  }
  try { return JSON.parse(data || '{}'); } catch { throw new Error('请求须为有效的 JSON 数据'); }
}

export function createAppServer({ env = process.env, dataDir = resolve(publicRoot, '..', '.art-runtime', 'projects'),
  runtimeOptions = {} } = {}) {
  const projects = new Map();
  const runtimes = new Map();
  function saveProject(project) {
    if (!project || !/^[a-zA-Z0-9_-]+$/.test(project.id)) throw new Error('项目标识无效');
    mkdirSync(dataDir, { recursive: true });
    const path = resolve(dataDir, `${project.id}.json`);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, project }), 'utf8');
    renameSync(temporary, path);
    projects.set(project.id, project);
    return project;
  }
  if (existsSync(dataDir)) for (const file of readdirSync(dataDir).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))) {
    const saved = JSON.parse(readFileSync(resolve(dataDir, file), 'utf8'));
    const project = saved.project;
    if (!project || `${project.id}.json` !== file) throw new Error('项目快照标识不匹配');
    projects.set(project.id, project);
    if (project.status?.phase === 'busy' || project.revisionRequest?.status === 'running') {
      if (project.revisionRequest?.status === 'running') {
        finishRevisionRequest(project, project.revisionRequest, 'interrupted', '服务重启中断了处理；正式内容和已保存待审内容保持不变，可重新提交。');
      }
      project.status = { phase: 'interrupted', detail: '服务重启中断了处理；没有自动重试、确认修改或发出请求。' };
      saveProject(project);
    }
  }
  let queue = Promise.resolve();
  function schedule(project, text) {
    project.status = { phase: 'busy', detail: '官方会话正在处理；行动与证据将持续更新' };
    saveProject(project);
    // The SDK's environment helpers are process-scoped. Serialize submissions
    // to keep concurrent projects from borrowing one another's private path.
    queue = queue.then(async () => {
      if (project.mode === 'live' && validationRun.liveStopped) {
        project.runtime.failure = { kind: 'runtime', code: 'VALIDATION_RUN_STOPPED', status: null, stopReason: 'error',
          summary: '此前真实案例已停止；本项目排队任务未执行，也未发出模型或文化查询请求。' };
        project.status = { phase: 'error', detail: project.runtime.failure.summary };
        action(project, 'runtime', '排队任务停止', project.status.detail, 'error');
        if (project.revisionRequest?.status === 'running') finishRevisionRequest(project, project.revisionRequest, 'error', project.status.detail);
        saveProject(project);
        return;
      }
      try {
        if (!runtimes.has(project.id)) runtimes.set(project.id, await createProductRuntime(project, { ...runtimeOptions, env }));
        await runtimes.get(project.id).submit(text);
      } catch {
        project.runtime.failure ??= safeRuntimeFailure(project, 'model');
        stopLiveRun(project, project.runtime.failure);
        project.status = { phase: 'error', detail: project.runtime.failure.summary };
        action(project, 'runtime', '本轮暂停', '没有将失败标记为成功，也没有生成替代证据。', 'error');
        if (project.revisionRequest?.status === 'running') {
          finishRevisionRequest(project, project.revisionRequest, 'error', project.status.detail);
        }
      } finally {
        saveProject(project);
      }
    });
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, configStatus(env));
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(request);
        if (input.mode === 'live' && validationRun.liveStopped)
          return json(response, 409, { error: '本轮真实验证已因错误停止；不能启动后续真实案例。' });
        if (input.mode === 'live' && !configStatus(env).modes.live.available)
          return json(response, 409, { error: '真实模式未单独启用或缺少明确配置；离线演示无需密钥。' });
        const project = createProject(input);
        projects.set(project.id, project);
        schedule(project, project.brief.request);
        return json(response, 202, { project });
      }
      const match = /^\/api\/projects\/([^/]+)(?:\/(messages|select|revisions)(?:\/([^/]+)\/(accept|reject|feedback))?)?$/.exec(url.pathname);
      if (match) {
        const project = projects.get(match[1]);
        if (!project) return json(response, 404, { error: '项目不存在；请检查当前本地项目存储。' });
        if (request.method === 'GET' && !match[2]) return json(response, 200, { project });
        if (request.method === 'POST' && match[2]) {
          if (project.status.phase === 'busy') return json(response, 409, { error: '当前任务仍在处理，请稍后补充。', code: 'PROJECT_BUSY' });
          const input = await body(request);
          if (match[2] === 'select' && !match[3]) {
            selectConcept(project, input); saveProject(project);
            return json(response, 200, { project });
          }
          if (match[2] === 'revisions' && match[3] && match[4] !== 'feedback') {
            decideRevision(project, match[3], match[4], input); saveProject(project);
            return json(response, 200, { project });
          }
          if (project.mode === 'live' && validationRun.liveStopped)
            return json(response, 409, { error: '本轮真实验证已因错误停止；不能追加真实请求。' });
          if (typeof input.text !== 'string' || !input.text.trim()) return json(response, 400, { error: '请输入补充说明' });
          const text = input.text.trim();
          if (match[2] === 'revisions' && match[4] === 'feedback') {
            beginPendingFeedback(project, match[3], input);
            project.messages.push({ role: 'user', text });
            schedule(project, text);
            return json(response, 202, { project });
          }
          if (match[2] === 'revisions' || project.concepts.length) {
            // No legacy message can overwrite confirmed concepts. The browser
            // must explicitly choose the target and send the confirmed version.
            beginRevision(project, input);
            project.messages.push({ role: 'user', text });
            schedule(project, text);
            return json(response, 202, { project });
          }
          project.messages.push({ role: 'user', text });
          if (project.status.phase === 'needs_input' && project.questions.length === 1) {
            const field = project.questions[0].field;
            project.brief[field] = ['references', 'mustKeep', 'avoid'].includes(field) ? list(text) : text;
            project.questions = [];
            project.version++;
          }
          schedule(project, text);
          return json(response, 202, { project });
        }
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
      if (request.method !== 'GET') return json(response, 405, { error: '不支持的请求方式' });
      const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!path.startsWith(publicRoot + sep)) return json(response, 404, { error: '文件不存在' });
      try {
        const data = await readFile(path);
        const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
        response.writeHead(200, { 'Content-Type': `${types[extname(path)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
        response.end(data);
      } catch { json(response, 404, { error: '文件不存在' }); }
    } catch (error) { json(response, error.statusCode ?? 400, { error: error.code ? error.message
      : ['请先描述项目需求', '不支持的运行模式', '不支持的离线场景', '输入超过本地演示上限', '请求须为有效的 JSON 数据'].includes(error.message) ? error.message : '输入格式无效',
      ...(error.code ? { code: error.code, path: error.path } : {}) }); }
  });
  return { server, projects, saveProject, async dispose() {
    await queue;
    await Promise.all([...runtimes.values()].map(runtime => runtime.dispose()));
    if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createAppServer();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '127.0.0.1', () => console.log(`本地工作空间：http://127.0.0.1:${port}（默认离线合成演示）`));
  process.on('SIGINT', async () => { await app.dispose(); process.exit(0); });
}
