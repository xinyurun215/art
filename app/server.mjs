import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProject, action, configStatus, answerClarification, selectConcept, setFieldLock, beginRevision, beginPendingFeedback,
  finishRevisionRequest, decideRevision } from './state.mjs';
import { createProductRuntime } from './runtime.mjs';
import { createHttpBudget, bindDatabaseBudget, validationRun, stopLiveRun, safeRuntimeFailure, recordLocalFailure } from './transport.mjs';
import { pendingReference, respondToReference, referenceQuestion } from './references.mjs';
import { interruptProject } from './store.mjs';

const publicRoot = fileURLToPath(new URL('../public', import.meta.url));
const completedCase = async () => {
  try { return JSON.parse(await readFile(new URL('../fixtures/completed-case.json', import.meta.url), 'utf8')); }
  catch { return null; }
};
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
let databaseExecutionActive = false;

function publicProject(project, file = false) {
  const safe = structuredClone(project);
  delete safe.guestOwner;
  delete safe.creation;
  if (file) return safe;
  safe.runtime = Object.fromEntries(['sessionId', 'toolNames', 'modelResultReads', 'feedback', 'failure', 'localFailure',
    'queryStopped', 'totalLatencyMs', 'generationBudget', 'httpAttempts'].filter(key => Object.hasOwn(project.runtime, key))
    .map(key => [key, structuredClone(project.runtime[key])]));
  if (project.runtime.runs) safe.runtime.runs = project.runtime.runs.map(({ status, startedAt, deadline, finishedAt }) => ({ status, startedAt, deadline, finishedAt }));
  return safe;
}

async function body(request) {
  if (request.body !== undefined) {
    const data = typeof request.body === 'object' && !Buffer.isBuffer(request.body) ? JSON.stringify(request.body) : String(request.body);
    if (Buffer.byteLength(data) > 32768) throw new Error('Input exceeds the local demo limit');
    try { return JSON.parse(data); } catch { throw new Error('The request must contain valid JSON'); }
  }
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 32768) throw new Error('Input exceeds the local demo limit');
  }
  try { return JSON.parse(data || '{}'); } catch { throw new Error('The request must contain valid JSON'); }
}

export function createAppServer({ env = process.env, dataDir = resolve(publicRoot, '..', '.art-runtime', 'projects'),
  runtimeOptions = {}, store = null, functionMode = false, maxRunMs = 250000, runtimeFactory = createProductRuntime } = {}) {
  const projects = new Map();
  const runtimes = new Map();
  const production = configStatus(env).production;
  function saveProject(project, options = {}) {
    if (store) return store.save(project, options).then(saved => { projects.set(saved.id, saved); return saved; });
    if (options.create && projects.has(project.id)) {
      const saved = projects.get(project.id);
      if (saved.creation?.fingerprint !== project.creation?.fingerprint)
        throw Object.assign(new Error('This creation request belongs to different input. The original project was not overwritten.'), { statusCode: 409, code: 'PROJECT_CREATION_CONFLICT' });
      return saved;
    }
    if (!project || !/^[a-zA-Z0-9_-]+$/.test(project.id)) throw new Error('Invalid project identifier');
    const path = resolve(dataDir, `${project.id}.json`);
    const temporary = `${path}.tmp`;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, project }), 'utf8');
      renameSync(temporary, path);
    } catch {
      try { unlinkSync(temporary); } catch { /* A leftover candidate is never loaded as a project. */ }
      throw Object.assign(new Error('The project was not saved. The last saved state is unchanged; this input can be submitted again.'),
        { statusCode: 503, code: 'PROJECT_SAVE_FAILED' });
    }
    const authority = projects.get(project.id);
    if (authority && authority !== project) {
      for (const key of Object.keys(authority)) delete authority[key];
      Object.assign(authority, structuredClone(project));
    } else projects.set(project.id, project);
    return authority ?? project;
  }
  const httpBudget = store ? { limits: store.limits, sharedLimits: store.sharedLimits,
    bind() {}, persist() {}, release() {} } : createHttpBudget({ env, dataDir, onReserve: saveProject });
  try {
  if (!store && existsSync(dataDir)) for (const file of readdirSync(dataDir).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))) {
    const saved = JSON.parse(readFileSync(resolve(dataDir, file), 'utf8'));
    const project = saved.project;
    if (!project || `${project.id}.json` !== file) throw new Error('Project snapshot identity mismatch');
    httpBudget.bind(project);
    projects.set(project.id, project);
    if (project.status?.phase === 'busy' || project.revisionRequest?.status === 'running') {
      if (project.revisionRequest?.status === 'running') {
        finishRevisionRequest(project, project.revisionRequest, 'interrupted', 'A server restart interrupted this request. Confirmed content and saved pending changes are unchanged; you may submit again.');
      }
      project.status = { phase: 'interrupted', detail: 'A server restart interrupted this request. No request was retried or sent, and no change was accepted automatically.' };
      saveProject(project);
    }
  }
  } catch (error) { httpBudget.release(); throw error; }
  let queue = Promise.resolve();
  let closing = false;
  async function executeStored(project, text, initial = false) {
    if (databaseExecutionActive) {
      if (initial) {
        const current = await store.get(project.id);
        if (current && current.status.phase !== 'created') return current;
      }
      throw Object.assign(new Error('Another request is running. This request was not queued.'), { code: 'RUNTIME_BUSY', statusCode: 409 });
    }
    databaseExecutionActive = true;
    let runtime, temporary, timer, saved, operation, settled = false;
    const controller = new AbortController();
    try {
      saved = await store.save(project, { start: true, initial, leaseMs: maxRunMs + 20000 });
      project = saved.project;
      projects.set(project.id, structuredClone(project));
      if (saved.alreadyStarted) return project;
      bindDatabaseBudget(project, store, saved.token, controller.signal, saved.usage);
      const expired = new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort();
        void runtime?.abort().catch(() => {});
        reject(Object.assign(new Error('This run reached the processing time limit. Saved content and reserved usage were kept; no request was automatically resent.'), { code: 'RUN_INTERRUPTED' }));
      }, maxRunMs); });
      operation = (async () => {
        temporary = await mkdtemp(resolve(tmpdir(), 'art-function-'));
        runtime = await runtimeFactory(project, { ...runtimeOptions, env, memorySession: true, runtimeRoot: temporary });
        if (controller.signal.aborted) { await runtime.abort(); return; }
        await runtime.submit(text);
      })();
      operation.finally(() => { settled = true; databaseExecutionActive = false; }).catch(() => {});
      try { await Promise.race([operation, expired]); }
      catch (error) {
        if (error.code === 'RUN_INTERRUPTED') interruptProject(project, error.message);
        else {
          if (!project.runtime.sessionId && !project.runtime.localFailure)
            recordLocalFailure(project, 'model', error.code === 'ERR_MODULE_NOT_FOUND' ? 'MODEL_MODULE_UNAVAILABLE' : 'MODEL_RUNTIME_SETUP_FAILED',
              'The live runtime could not start. No model or cultural-data request was sent.');
          project.runtime.failure ??= safeRuntimeFailure(project, 'model');
          project.status = { phase: 'error', detail: project.runtime.failure.summary };
          if (project.revisionRequest?.status === 'running') finishRevisionRequest(project, project.revisionRequest, 'error', project.status.detail);
        }
      }
      clearTimeout(timer);
      const run = project.runtime.runs.at(-1);
      Object.assign(run, { status: project.status.phase === 'interrupted' ? 'interrupted' : project.status.phase === 'error' ? 'error' : 'completed',
        finishedAt: new Date().toISOString() });
      const final = await store.save(structuredClone(project), { token: saved.token });
      projects.set(final.id, final);
      return final;
    } finally {
      clearTimeout(timer);
      if (!operation || settled) {
        databaseExecutionActive = false;
        await runtime?.dispose();
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } else {
        // An uncooperative tool keeps this process busy until it settles. No second SDK can borrow its environment.
        void operation.catch(() => {}).finally(async () => {
          await runtime?.dispose();
          if (temporary) await rm(temporary, { recursive: true, force: true });
        }).catch(() => {});
      }
    }
  }
  async function schedule(project, text, initial = false) {
    project.status = { phase: 'busy', detail: 'The official session is running. Actions and evidence will update as it proceeds.' };
    if (store) return executeStored(project, text, initial);
    saveProject(project);
    const candidate = structuredClone(project);
    // The SDK's environment helpers are process-scoped. Serialize submissions
    // to keep concurrent projects from borrowing one another's private path.
    queue = queue.then(async () => {
      let entry = runtimes.get(candidate.id);
      if (entry) {
        for (const key of Object.keys(entry.project)) delete entry.project[key];
        Object.assign(entry.project, candidate);
      }
      const project = entry?.project ?? candidate;
      if (project.mode === 'live' && validationRun.liveStopped) {
        project.runtime.failure = { kind: 'runtime', code: 'VALIDATION_RUN_STOPPED', status: null, stopReason: 'error',
          summary: 'The live validation round has already stopped. This queued task did not run or send a model or cultural-data request.' };
        project.status = { phase: 'error', detail: project.runtime.failure.summary };
        action(project, 'runtime', 'Queued task stopped', project.status.detail, 'error');
        if (project.revisionRequest?.status === 'running') finishRevisionRequest(project, project.revisionRequest, 'error', project.status.detail);
        saveProject(project);
        return;
      }
      try {
        if (!entry) {
          httpBudget.bind(project);
          entry = { project, runtime: await createProductRuntime(project, { ...runtimeOptions, env }) };
          runtimes.set(project.id, entry);
        }
        await entry.runtime.submit(text);
      } catch (error) {
        if (!project.runtime.sessionId && !project.runtime.localFailure)
          recordLocalFailure(project, 'model', error.code === 'ERR_MODULE_NOT_FOUND' ? 'MODEL_MODULE_UNAVAILABLE' : 'MODEL_RUNTIME_SETUP_FAILED',
            'The live runtime could not start. No model or cultural-data request was sent.');
        project.runtime.failure ??= safeRuntimeFailure(project, 'model');
        stopLiveRun(project, project.runtime.failure);
        project.status = { phase: 'error', detail: project.runtime.failure.summary };
        action(project, 'runtime', 'Run paused', 'The failure was not treated as success. No substitute evidence was generated.', 'error');
        if (project.revisionRequest?.status === 'running') {
          finishRevisionRequest(project, project.revisionRequest, 'error', project.status.detail);
        }
      } finally {
        saveProject(project);
      }
    }).catch(async () => {
      const entry = runtimes.get(candidate.id);
      runtimes.delete(candidate.id);
      try { await entry?.runtime.dispose(); } catch { /* A failed save must not stop later queue entries or shutdown. */ }
    });
  }
  const loadProject = async (id, guestOwner) => {
    const project = store ? await store.get(id, { guestOwner }) : projects.get(id);
    return guestOwner === undefined || (guestOwner && project?.guestOwner === guestOwner) ? project : null;
  };
  const handler = async (request, response) => {
    try {
      const judge = functionMode && env.VERCEL_ENV === 'production' && request.headers.host === 'art-lovat-two.vercel.app';
      let guestToken = /(?:^|;\s*)__Host-art-guest=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
      const owner = () => judge ? (guestToken ? createHash('sha256').update(guestToken).digest('hex') : null) : undefined;
      if (closing) return json(response, 503, { error: 'The service is shutting down and is not accepting new requests.' });
      if (functionMode) {
        if (!['preview', 'production'].includes(env.VERCEL_ENV) || !store || !env.ART_PREVIEW_ACCESS_KEY)
          return json(response, 503, { error: 'A preview or production environment with a database and access key is required.', code: 'PREVIEW_CONFIGURATION_REQUIRED' });
        const supplied = Buffer.from(String(request.headers.authorization ?? ''));
        const expected = Buffer.from(`Basic ${Buffer.from(`preview:${env.ART_PREVIEW_ACCESS_KEY}`).toString('base64')}`);
        if (!judge && (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))) {
          response.setHeader('WWW-Authenticate', 'Basic realm="TasteStage protected preview", charset="UTF-8"');
          return json(response, 401, { error: 'Preview access credentials are required.', code: 'PREVIEW_AUTHENTICATION_REQUIRED' });
        }
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (functionMode && request.method === 'POST' && url.pathname.startsWith('/api/')) {
        const origin = request.headers.origin;
        const sameOrigin = origin === undefined || (URL.canParse(origin) && new URL(origin).protocol === 'https:'
          && new URL(origin).host === request.headers.host);
        if (!sameOrigin || request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
          return json(response, 403, { error: 'Changes require a same-origin JSON request.', code: 'CROSS_ORIGIN_REQUEST_BLOCKED' });
      }
      if (url.pathname === '/api/cases/completed') {
        if (request.method !== 'GET') return json(response, 409, { code: 'CASE_READ_ONLY', error: 'This recorded case is read only. Create your own project to generate or edit.' });
        const project = await completedCase();
        if (!project) return json(response, 404, { code: 'CASE_UNAVAILABLE', error: 'The completed case is not available. Create your own project or try again after a new recorded case is prepared.' });
        return json(response, 200, { project });
      }
      if (request.method === 'GET' && url.pathname === '/api/config') return json(response, 200, {
        ...configStatus(env), limits: httpBudget.limits, serverLimits: httpBudget.sharedLimits });
      if (request.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(request);
        if (production && input.mode === undefined) input.mode = 'live';
        if (closing) return json(response, 503, { error: 'The service is shutting down and is not accepting new requests.' });
        if (!store && input.mode === 'live' && validationRun.liveStopped)
          return json(response, 409, { error: 'This live validation round stopped after an error. Further live cases cannot start.' });
        if (typeof input.creationKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.creationKey))
          return json(response, 400, { code: 'CREATION_KEY_REQUIRED', error: 'Save a valid creation request key before creating a project.' });
        const project = createProject(input);
        project.id = createHash('sha256').update(`art-project:${input.creationKey}`).digest('hex');
        project.creation = { fingerprint: createHash('sha256').update(JSON.stringify({
          brief: project.brief, mode: project.mode, scenario: project.scenario })).digest('hex') };
        project.status = { phase: 'created', detail: 'The project is saved. Generation has not started.' };
        let setGuestCookie = false;
        if (judge) {
          if (!guestToken) {
            guestToken = createHash('sha256').update(`art-guest-creation:${input.creationKey}`).digest('hex');
            setGuestCookie = true;
          }
          project.guestOwner = owner();
        }
        let saved;
        if (production && (project.mode !== 'live' || project.scenario !== 'sufficient' || input.offlineFixture !== undefined)) {
          // Upgrade recovery may return an already-saved offline identity only.
          // It never creates a new synthetic project or changes its original input.
          const existing = project.mode === 'offline' ? await loadProject(project.id, owner()) : null;
          if (!existing) return json(response, 400, { code: 'SYNTHETIC_MODE_DISABLED', error: 'Production uses live generation. New offline projects and synthetic fixtures are unavailable.' });
          if (existing.creation?.fingerprint !== project.creation.fingerprint || existing.guestOwner !== project.guestOwner)
            return json(response, 409, { code: 'PROJECT_CREATION_CONFLICT', error: 'This creation request belongs to different input or a different visitor. The saved project was not changed.' });
          saved = existing;
        } else {
          if (!store && !projects.has(project.id)) httpBudget.bind(project, true);
          saved = await saveProject(project, { create: true });
        }
        if (setGuestCookie) response.setHeader('Set-Cookie', `__Host-art-guest=${guestToken}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        return json(response, 201, { project: publicProject(saved, !store) });
      }
      const match = /^\/api\/projects\/([^/]+)(?:\/(start|messages|select|locks|revisions)(?:\/([^/]+)\/(accept|reject|feedback))?)?$/.exec(url.pathname);
      if (match) {
        if (match[1].startsWith('case-')) {
          if (request.method === 'GET' && !match[2]) {
            const project = await completedCase();
            if (!project || project.id !== match[1]) return json(response, 404, { code: 'CASE_UNAVAILABLE', error: 'This recorded case is not available. No substitute case was loaded.' });
            return json(response, 200, { project });
          }
          return json(response, 409, { code: 'CASE_READ_ONLY', error: 'This recorded case is read only. Create your own project to generate or edit.' });
        }
        let project = await loadProject(match[1], owner());
        if (!project) return json(response, 404, { error: judge ? 'The project does not exist or was not created in this browser.' : 'The project does not exist. Check the current local project storage.' });
        if (request.method === 'GET' && !match[2]) return json(response, 200, { project: publicProject(project, !store) });
        if (request.method === 'POST' && match[2]) {
          const input = await body(request);
          if (closing) return json(response, 503, { error: 'The service is shutting down and is not accepting new requests.' });
          project = await loadProject(match[1], owner());
          if (!project) return json(response, 404, { error: 'The project does not exist. Check the projects saved in this browser.' });
          if (production && project.mode !== 'live') return json(response, 409, { code: 'OFFLINE_PROJECT_READ_ONLY',
            error: 'This saved synthetic project is read only in production. You can read or export it, or create a separate live project.' });
          if (production && ((input.mode !== undefined && input.mode !== 'live')
            || input.offlineFixture !== undefined || (input.scenario !== undefined && input.scenario !== 'sufficient')))
            return json(response, 400, { code: 'SYNTHETIC_MODE_DISABLED', error: 'Synthetic fixtures are unavailable in production.' });
          if (match[2] === 'start' && !match[3]) {
            if (project.status.phase !== 'created') return json(response, 200, { project: publicProject(project, !store) });
            if (!store && project.mode === 'live' && validationRun.liveStopped)
              return json(response, 409, { error: 'This live validation round has stopped. Generation did not start.' });
            const live = configStatus(env).modes.live;
            if (project.mode === 'live' && !live.available)
              return json(response, production ? 503 : 409, { ...(production ? { code: 'LIVE_SERVICE_UNAVAILABLE' } : {}),
                error: `Live generation is unavailable because ${live.enabled ? 'required provider configuration is missing' : 'the live service is disabled'}. The project is saved and has not started. Read it again and retry when the service is available.` });
            const saved = await schedule(structuredClone(project), project.brief.request, true);
            return json(response, store ? 200 : 202, { project: publicProject(saved ?? projects.get(project.id), !store) });
          }
          if (project.status.phase === 'created') return json(response, 409, { code: 'PROJECT_NOT_STARTED', error: 'The project is saved. Explicitly start its initial generation.' });
          if (project.status.phase === 'busy') return json(response, 409, { error: 'The current request is still running. Wait before adding input.', code: 'PROJECT_BUSY' });
          project = structuredClone(project);
          if (['select', 'locks'].includes(match[2]) && !match[3]) {
            (match[2] === 'select' ? selectConcept : setFieldLock)(project, input); project = await saveProject(project);
            return json(response, 200, { project: publicProject(project, !store) });
          }
          if (match[2] === 'revisions' && match[3] && match[4] !== 'feedback') {
            decideRevision(project, match[3], match[4], input); project = await saveProject(project);
            return json(response, 200, { project: publicProject(project, !store) });
          }
          if (!store && project.mode === 'live' && validationRun.liveStopped)
            return json(response, 409, { error: 'This live validation round stopped after an error. Further live requests cannot be added.' });
          if (match[2] === 'messages' && (pendingReference(project) || input.referenceResolution)) {
            if (!input.referenceResolution) {
              referenceQuestion(project); await saveProject(project);
              return json(response, 409, { error: 'Choose an actual candidate or use the details form. A text reply does not select an entity automatically.', code: 'REFERENCE_SELECTION_REQUIRED' });
            }
            const continuation = respondToReference(project, input.referenceResolution);
            project.messages.push({ role: 'user', text: continuation ?? 'Entity selection was cancelled. The original cultural reference is unresolved and needs more detail.' });
            if (continuation) project = await schedule(project, continuation) ?? project;
            else project = await saveProject(project);
            return json(response, continuation && !store ? 202 : 200, { project: publicProject(project, !store) });
          }
          if (typeof input.text !== 'string' || !input.text.trim()) return json(response, 400, { error: 'Enter the additional details' });
          const text = input.text.trim();
          if (match[2] === 'revisions' && match[4] === 'feedback') {
            beginPendingFeedback(project, match[3], input);
            project.messages.push({ role: 'user', text });
            project = await schedule(project, text) ?? project;
            return json(response, store ? 200 : 202, { project: publicProject(project, !store) });
          }
          if (match[2] === 'revisions' || project.concepts.length) {
            // No legacy message can overwrite confirmed concepts. The browser
            // must explicitly choose the target and send the confirmed version.
            beginRevision(project, input);
            project.messages.push({ role: 'user', text });
            project = await schedule(project, text) ?? project;
            return json(response, store ? 200 : 202, { project: publicProject(project, !store) });
          }
          if (project.status.phase === 'needs_input' || input.clarification || input.briefUpdate) answerClarification(project, input);
          project.messages.push({ role: 'user', text: input.text });
          project = await schedule(project, input.text) ?? project;
          return json(response, store ? 200 : 202, { project: publicProject(project, !store) });
        }
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'API route not found' });
      if (request.method !== 'GET') return json(response, 405, { error: 'Unsupported request method' });
      const path = resolve(publicRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (!path.startsWith(publicRoot + sep)) return json(response, 404, { error: 'File not found' });
      try {
        const data = await readFile(path);
        const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
        response.writeHead(200, { 'Content-Type': `${types[extname(path)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
        response.end(data);
      } catch { json(response, 404, { error: 'File not found' }); }
    } catch (error) { json(response, error.statusCode ?? 400, { error: error.code ? error.message
      : ['Describe the project brief first', 'Unsupported run mode', 'Unsupported offline scenario', 'Input exceeds the local demo limit', 'The request must contain valid JSON'].includes(error.message) ? error.message : 'Invalid input format',
      ...(error.code ? { code: error.code, path: error.path } : {}) }); }
  };
  const server = createServer(handler);
  return { server, handler, projects, saveProject, async dispose() {
    closing = true;
    const closed = server.listening ? new Promise((done, reject) => server.close(error => error ? reject(error) : done())) : Promise.resolve();
    await queue;
    await Promise.all([...runtimes.values()].map(entry => entry.runtime.dispose()));
    await closed;
    httpBudget.persist(); httpBudget.release();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createAppServer();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '127.0.0.1', () => console.log(`Local workspace: http://127.0.0.1:${port} (offline synthetic demo by default)`));
  process.on('SIGINT', async () => { await app.dispose(); process.exit(0); });
}
