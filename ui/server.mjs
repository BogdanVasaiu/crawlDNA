// Web UI server (§8): a tiny node:http server, no framework.
//   GET  /         -> ui/index.html
//   POST /start    -> { targets, options } -> start a crawl via the core
//   POST /resume   -> { runId, options? }  -> complete an interrupted run (#13)
//   GET  /events   -> Server-Sent Events stream of core events (§6)
//   POST /stop     -> run.stop() (the run stays resumable)
//
// One active crawl at a time (fine for v1).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { crawlDocs, resumeCrawl } from '../src/index.mjs';
import { ensureBrowser } from '../src/lib/browser.mjs';
import { reshape } from '../src/reshape.mjs';
import { resolveLlm, listModels } from '../src/lib/llm.mjs';
import {
  listRuns,
  getRun,
  readRunFile,
  deleteRun,
  deleteAllRuns,
  cacheRoot,
  getChatSession,
  readChatFile,
  saveActivity,
  readActivity,
} from '../src/lib/runs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const clients = new Set(); // active SSE responses
let currentRun = null;
let eventBuffer = []; // replayed to late subscribers within a run
let activityTrace = []; // compact, persistable narration of the current run

// Keep only the narrative events the Activity log + exploration Tree are built
// from, and drop the heavy bits (e.g. extraction previews). Returns null for
// events that don't belong in the persisted trace (progress, page, ping, …).
function traceEvent(ev) {
  switch (ev.type) {
    case 'site':
      return { type: 'site', scanId: ev.scanId, url: ev.url, task: ev.task, title: ev.title };
    case 'strategy':
      return { type: 'strategy', scanId: ev.scanId, strategy: ev.strategy, framework: ev.framework };
    case 'discover':
      return { type: 'discover', scanId: ev.scanId, count: ev.count };
    case 'action':
      return { type: 'action', scanId: ev.scanId, action: ev.action, detail: ev.detail, url: ev.url, state: ev.state };
    case 'extracted':
      return { type: 'extracted', scanId: ev.scanId, url: ev.url, title: ev.title, bytes: ev.bytes };
    case 'warn':
      return { type: 'warn', scanId: ev.scanId, reason: ev.reason, message: ev.message };
    case 'error':
      return { type: 'error', scanId: ev.scanId, message: ev.message };
    default:
      return null;
  }
}

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleStart(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid JSON body' });
  }

  const { targets, options = {} } = payload || {};
  if (!targets || (Array.isArray(targets) && targets.length === 0)) {
    return json(res, 400, { error: 'no targets' });
  }

  let run;
  try {
    run = crawlDocs(targets, {
      ...options,
      // The Web UI is an app: always persist so History and Reshape work. The cache
      // is rooted at the server's cwd by default (library callers save only on opt-in).
      save: true,
      onEvent: wireEvents(),
    });
  } catch (err) {
    // Contract violations are rejected synchronously (e.g. mode 'targeted' + noAi,
    // unknown mode) — surface the reason, never a silent 500.
    return json(res, 400, { error: String((err && err.message) || err) });
  }
  trackRun(run);

  json(res, 200, { ok: true });
}

// Stop any in-flight crawl, reset the buffers, and return the onEvent sink that
// feeds SSE clients + the persisted Activity trace. Shared by /start and /resume
// (a resumed run already knows its id, so its Activity persists under it).
function wireEvents(initialRunId = null) {
  if (currentRun) {
    try {
      currentRun.stop();
    } catch {
      /* ignore */
    }
  }
  eventBuffer = [];
  activityTrace = [];
  let savedRunId = initialRunId;
  return (ev) => {
    eventBuffer.push(ev);
    if (eventBuffer.length > 20000) eventBuffer.shift();
    const t = traceEvent(ev);
    if (t) {
      activityTrace.push(t);
      // Keep a long history so a reopened large crawl replays its whole Activity
      // + Tree (the old 4000 cap silently dropped the earliest part of the run).
      if (activityTrace.length > 20000) activityTrace.shift();
    }
    if (ev.type === 'saved' && ev.runId) savedRunId = ev.runId;
    // Persist the timeline once the run is saved so a finished/reopened run can
    // replay its Activity + Tree (best-effort: never let this break the crawl).
    if ((ev.type === 'saved' || ev.type === 'done') && savedRunId) {
      saveActivity(savedRunId, activityTrace).catch(() => {});
    }
    broadcast(ev);
  };
}

// Await the run's end to clear `currentRun` (onEvent already drives the stream).
function trackRun(run) {
  currentRun = run;
  run.result
    .then(() => {
      if (currentRun === run) currentRun = null;
    })
    .catch(() => {
      if (currentRun === run) currentRun = null;
    });
}

// Complete an interrupted run (#13): journaled pages are restored, only the
// missing ones are crawled, and the output lands in the SAME run folder.
async function handleResume(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid JSON body' });
  }
  const { runId, options = {} } = payload || {};
  if (!runId) return json(res, 400, { error: 'runId is required' });

  let run;
  try {
    run = await resumeCrawl(runId, { ...options, onEvent: wireEvents(runId) });
  } catch (err) {
    return json(res, 400, { error: String((err && err.message) || err) });
  }
  trackRun(run);

  json(res, 200, { ok: true, runId });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  // Replay the current run's events so a late subscriber is in sync.
  for (const ev of eventBuffer) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  clients.add(res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

// --- cached runs (history) ---

async function handleRunsList(res) {
  json(res, 200, { root: cacheRoot(), runs: await listRuns() });
}

async function handleRunGet(res, id) {
  try {
    const { manifest, dir } = await getRun(id);
    json(res, 200, { ...manifest, dir });
  } catch {
    json(res, 404, { error: 'run not found' });
  }
}

async function handleRunFile(res, id, scan, name) {
  try {
    const text = await readRunFile(id, scan, name);
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(text);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('file not found');
  }
}

async function handleRunDelete(res, id) {
  try {
    await deleteRun(id);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: String(err && err.message) });
  }
}

async function handleRunsClear(res) {
  const n = await deleteAllRuns();
  json(res, 200, { ok: true, deleted: n });
}

// --- Phase 2: reshape (chat with a saved extraction) ---

async function handleReshape(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'invalid JSON body' });
  }
  const { runId, scanId = '', message, model, provider, host, baseUrl, apiKey } = payload || {};
  if (!runId || !String(message || '').trim()) {
    return json(res, 400, { error: 'runId and message are required' });
  }
  try {
    const out = await reshape({ runId, scanId, message, model, provider, host, baseUrl, apiKey });
    json(res, 200, out);
  } catch (err) {
    json(res, 400, { error: String((err && err.message) || err) });
  }
}

async function handleActivity(res, id) {
  json(res, 200, await readActivity(id));
}

async function handleChatGet(res, id, scan) {
  try {
    json(res, 200, await getChatSession(id, scan));
  } catch {
    json(res, 200, { messages: [], files: [] });
  }
}

async function handleChatFile(res, id, scan, name) {
  try {
    const text = await readChatFile(id, scan, name);
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(text);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('file not found');
  }
}

// --- model list (provider-aware) ---
// Lists the models a provider offers for the setup UI's picker. For 'ollama' we
// also report `installed` (a best-effort `ollama` CLI check) so the UI can tell
// "not installed" from "installed but not running"; for an OpenAI-compatible API
// we just probe its /models endpoint. Cloud models are flagged so the UI can
// group them apart from local ones.
let _ollamaInstalled = null; // probed once per process: the CLI doesn't (un)install mid-serve
async function handleModels(res, params) {
  const provider = params.get('provider') || 'ollama';
  const llm = resolveLlm({
    provider,
    ollamaHost: params.get('host') || undefined,
    baseUrl: params.get('baseUrl') || undefined,
    apiKey: params.get('apiKey') || undefined,
  });
  const result = await listModels(llm);
  let installed = false;
  if (llm.provider === 'ollama') {
    if (_ollamaInstalled === null) {
      try {
        execSync('ollama --version', { stdio: 'ignore', timeout: 5000 });
        _ollamaInstalled = true;
      } catch {
        _ollamaInstalled = false; // CLI missing or not on PATH
      }
    }
    installed = _ollamaInstalled;
  }
  json(res, 200, { provider: llm.provider, installed, ...result });
}

async function handleIndex(res) {
  try {
    const html = await readFile(path.join(__dirname, 'index.html'));
    // The UI is a single local file that changes whenever crawldna is updated;
    // never let the browser serve a cached (stale) copy, or UI fixes silently
    // won't appear until a hard refresh.
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(html);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('index.html not found');
  }
}

// `host` defaults to loopback ON PURPOSE: this server has no authentication and can
// start crawls, read every extraction and delete runs — exposed on 0.0.0.0 that is
// an open remote control for anyone on the same network. Pass an explicit host only
// when you understand that trade-off.
export async function startServer({ port = 4000, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return handleIndex(res);
      if (req.method === 'GET' && url.pathname === '/api/models') {
        return handleModels(res, url.searchParams);
      }
      // Back-compat: the old Ollama-only probe endpoint.
      if (req.method === 'GET' && url.pathname === '/api/ollama') {
        if (!url.searchParams.get('provider')) url.searchParams.set('provider', 'ollama');
        return handleModels(res, url.searchParams);
      }
      if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res);
      if (req.method === 'POST' && url.pathname === '/start') return handleStart(req, res);
      if (req.method === 'POST' && url.pathname === '/resume') return handleResume(req, res);
      if (req.method === 'POST' && url.pathname === '/reshape') return handleReshape(req, res);
      if (req.method === 'POST' && url.pathname === '/stop') {
        if (currentRun) currentRun.stop();
        return json(res, 200, { ok: true });
      }

      // Cached runs: /runs, /runs/:id, /runs/:id/file?name=…
      if (url.pathname === '/runs') {
        if (req.method === 'GET') return handleRunsList(res);
        if (req.method === 'DELETE') return handleRunsClear(res);
      }
      if (url.pathname.startsWith('/runs/')) {
        const parts = url.pathname.split('/').filter(Boolean); // ['runs', id, 'file'?]
        const id = decodeURIComponent(parts[1] || '');
        if (parts.length === 2) {
          if (req.method === 'GET') return handleRunGet(res, id);
          if (req.method === 'DELETE') return handleRunDelete(res, id);
        }
        if (parts.length === 3 && parts[2] === 'file' && req.method === 'GET') {
          return handleRunFile(res, id, url.searchParams.get('scan') || '', url.searchParams.get('name') || '');
        }
        // The run's saved activity timeline (Activity log + exploration Tree).
        if (parts.length === 3 && parts[2] === 'activity' && req.method === 'GET') {
          return handleActivity(res, id);
        }
        // Phase 2 reshape: the scan's conversation + its derived files.
        if (parts.length === 3 && parts[2] === 'chat' && req.method === 'GET') {
          return handleChatGet(res, id, url.searchParams.get('scan') || '');
        }
        if (parts.length === 3 && parts[2] === 'chatfile' && req.method === 'GET') {
          return handleChatFile(res, id, url.searchParams.get('scan') || '', url.searchParams.get('name') || '');
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      json(res, 500, { error: String(err && err.message) });
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      process.stderr.write(
        `\n✗ Port ${port} is already in use — an old crawldna server is still running.\n` +
          `  Close that terminal/process, or start with a different port: crawldna serve --port ${port + 1}\n`,
      );
    } else {
      process.stderr.write('✗ Server error: ' + (err && err.message) + '\n');
    }
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  process.stdout.write(`crawldna UI on http://localhost:${port}\n`);

  // Make the browser ready up front so the user never hits a mid-crawl error.
  const ready = await ensureBrowser({ log: (m) => process.stdout.write(m + '\n') });
  process.stdout.write(
    ready
      ? '✓ Chromium ready — dynamic crawling enabled.\n'
      : '⚠ Chromium unavailable — run `npx playwright install chromium`. Crawls will use static fallback until then.\n',
  );

  return { server, port };
}
