import { createAppServer } from '../app/server.mjs';
import { createPostgresStore } from '../app/store.mjs';

export function createFunctionHandler({ env = process.env, store, ...options } = {}) {
  let app;
  return async (request, response) => {
    if (env.VERCEL_ENV !== 'preview' || !env.ART_PREVIEW_ACCESS_KEY || (!store && !env.DATABASE_URL)) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ code: 'PREVIEW_CONFIGURATION_REQUIRED', error: '需要受保护预览、访问密钥和数据库；未回退本地存储。' }));
      return;
    }
    try { app ??= createAppServer({ ...options, env, store: store ?? createPostgresStore({ connectionString: env.DATABASE_URL, env }), functionMode: true }); }
    catch {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ code: 'PREVIEW_CONFIGURATION_REQUIRED', error: '预览配置未通过校验；未启用请求或回退本地存储。' }));
      return;
    }
    return app.handler(request, response);
  };
}

export default createFunctionHandler();
