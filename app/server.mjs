import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProject, action, configStatus, list } from './state.mjs';
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

export function createAppServer({ env = process.env } = {}) {
  const projects = new Map();
  const runtimes = new Map();
  let queue = Promise.resolve();
  function schedule(project, text) {
    project.status = { phase: 'busy', detail: '官方会话正在处理；行动与证据将持续更新' };
    // The SDK's environment helpers are process-scoped. Serialize submissions
    // to keep concurrent projects from borrowing one another's private path.
    queue = queue.then(async () => {
      if (project.mode === 'live' && validationRun.liveStopped) {
        project.runtime.failure = { kind: 'runtime', code: 'VALIDATION_RUN_STOPPED', status: null, stopReason: 'error',
          summary: '此前真实案例已停止；本项目排队任务未执行，也未发出模型或文化查询请求。' };
        project.status = { phase: 'error', detail: project.runtime.failure.summary };
        action(project, 'runtime', '排队任务停止', project.status.detail, 'error');
        return;
      }
      try {
        if (!runtimes.has(project.id)) runtimes.set(project.id, await createProductRuntime(project, { env }));
        await runtimes.get(project.id).submit(text);
      } catch {
        project.runtime.failure ??= safeRuntimeFailure(project, 'model');
        stopLiveRun(project, project.runtime.failure);
        project.status = { phase: 'error', detail: project.runtime.failure.summary };
        action(project, 'runtime', '本轮暂停', '没有将失败标记为成功，也没有生成替代证据。', 'error');
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
      const match = /^\/api\/projects\/([^/]+)(\/messages)?$/.exec(url.pathname);
      if (match) {
        const project = projects.get(match[1]);
        if (!project) return json(response, 404, { error: '项目不存在；本地演示仅保留当前服务进程内的项目。' });
        if (request.method === 'GET' && !match[2]) return json(response, 200, { project });
        if (request.method === 'POST' && match[2]) {
          if (project.mode === 'live' && validationRun.liveStopped)
            return json(response, 409, { error: '本轮真实验证已因错误停止；不能追加真实请求。' });
          if (project.status.phase === 'busy') return json(response, 409, { error: '当前任务仍在处理，请稍后补充。' });
          const input = await body(request);
          if (typeof input.text !== 'string' || !input.text.trim()) return json(response, 400, { error: '请输入补充说明' });
          const text = input.text.trim();
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
    } catch (error) { json(response, 400, { error: ['请先描述项目需求', '不支持的运行模式', '不支持的离线场景', '输入超过本地演示上限', '请求须为有效的 JSON 数据'].includes(error.message) ? error.message : '输入格式无效' }); }
  });
  return { server, projects, async dispose() {
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
