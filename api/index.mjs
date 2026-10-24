import { createAppServer } from '../app/server.mjs';
import { createPostgresStore } from '../app/store.mjs';

export function createFunctionHandler({ env = process.env, store, ...options } = {}) {
  let app;
  return async (request, response) => {
    if (!['preview', 'production'].includes(env.VERCEL_ENV) || !env.ART_PREVIEW_ACCESS_KEY || (!store && !env.DATABASE_URL)) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ code: 'PREVIEW_CONFIGURATION_REQUIRED', error: 'A preview or production environment, access key and database are required. Local storage was not used as a fallback.' }));
      return;
    }
    try { app ??= createAppServer({ ...options, env, store: store ?? createPostgresStore({ connectionString: env.DATABASE_URL, env }), functionMode: true }); }
    catch {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ code: 'PREVIEW_CONFIGURATION_REQUIRED', error: 'The preview configuration failed validation. Requests were not enabled and local storage was not used as a fallback.' }));
      return;
    }
    return app.handler(request, response);
  };
}

export default createFunctionHandler();
