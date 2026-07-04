// Run cache (§9): every crawl is saved, whether or not the caller asked for it.
//
// A run is one folder under the cache root. Each submitted link is an
// independent SCAN, stored in its own subfolder:
//   <cacheRoot>/<runId>/
//     manifest.json       full, machine-friendly index (scans[] → files + pages)
//     run.json            a small summary used to list runs quickly; carries a
//                         status: 'running' → 'done' | 'stopped' (resumable)
//     <scanId>/           one subfolder per link, e.g. 01-docusaurus-io/
//       <grouped>.md      that link's AI-grouped Markdown files (lib/layout.mjs)
//       manifest.json     a self-contained per-scan index
//       pages.jsonl       incremental journal (#13) while crawling / when interrupted
//
// The run is just the container recording which links were crawled together;
// the user can open one link on its own or the whole run grouped. The cache root
// defaults to `<project>/.sagecrawl/runs`, overridable with the `cacheDir` option or
// the SAGECRAWL_CACHE_DIR env var. Runs are kept until explicitly deleted.

import { mkdir, writeFile, appendFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeBundle } from './output.mjs';
import { slug, hostOf } from './url.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Resolve the cache root directory (explicit option > env > the CONSUMER's cwd).
 * The default is rooted at `process.cwd()` — the project that is RUNNING sagecrawl —
 * never the package's own install location. When sagecrawl is imported as a
 * dependency, the old package-relative default resolved inside `node_modules/`,
 * which is both surprising and wiped on reinstall. The runs cache belongs to the
 * caller's project, so cwd is the correct, portable default.
 */
export function cacheRoot(opts = {}) {
  if (opts && opts.cacheDir) return path.resolve(opts.cacheDir);
  if (process.env.SAGECRAWL_CACHE_DIR) return path.resolve(process.env.SAGECRAWL_CACHE_DIR);
  return path.join(process.cwd(), '.sagecrawl', 'runs');
}

function runDir(id, opts = {}) {
  if (!ID_RE.test(String(id))) throw new Error(`invalid run id: ${id}`);
  return path.join(cacheRoot(opts), id);
}

/** A sortable, collision-resistant run id: 20260615-084021-3f9c1a. */
export function newRunId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 8);
  return `${ts}-${rand}`;
}

/**
 * A path-safe, ordered id for one scan (link) within a run: "01-docusaurus-io".
 * The index prefix keeps it unique even when two links share a host.
 */
export function scanIdFor(url, i) {
  return `${String((i || 0) + 1).padStart(2, '0')}-${slug(hostOf(url) || '')}`;
}

function sanitizeOptions(o = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'function') continue; // drop onEvent etc.
    if (k === 'llm' || k.startsWith('__')) continue; // runtime objects (resolved provider, resume payload)
    if (k === 'apiKey') continue; // never write a secret to disk; resume re-reads it from flags/env
    if (v instanceof RegExp) clean[k] = v.source;
    else clean[k] = v;
  }
  return clean;
}

const scanPages = (s) => (s && s.stats && s.stats.pages) || (s && s.pages ? s.pages.length : 0) || 0;
const aggregatePages = (scans) => scans.reduce((n, s) => n + scanPages(s), 0);

/** Sum AI token usage across scans — a fallback when no run-level total is given.
 *  Merges the per-call-type `byKind` breakdown too, so the saved run keeps WHERE the
 *  tokens went (reveal/scope/links/nav-plan) and not just the grand total. */
function aggregateTokens(scans) {
  const t = { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, byKind: {} };
  for (const s of scans) {
    const u = s && s.stats && s.stats.tokens;
    if (!u) continue;
    t.calls += u.calls || 0;
    t.inputTokens += u.inputTokens || 0;
    t.outputTokens += u.outputTokens || 0;
    t.cachedInputTokens += u.cachedInputTokens || 0;
    for (const [kind, k] of Object.entries(u.byKind || {})) {
      const dst = t.byKind[kind] || (t.byKind[kind] = { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
      dst.calls += k.calls || 0;
      dst.inputTokens += k.inputTokens || 0;
      dst.outputTokens += k.outputTokens || 0;
      dst.cachedInputTokens += k.cachedInputTokens || 0;
    }
  }
  return t;
}

/** The full, machine-friendly index for one scan (also written into its folder). */
function buildScanManifest(scan) {
  // url -> first file that contains its content
  const pageToFile = new Map();
  for (const f of scan.files || []) {
    for (const url of f.pages || []) if (!pageToFile.has(url)) pageToFile.set(url, f.filename);
  }
  const m = {
    scanId: scan.scanId,
    url: scan.url,
    task: scan.task,
    title: scan.title,
    stats: scan.stats || { pages: (scan.pages || []).length },
    warnings: scan.warnings || [],
    files: (scan.files || []).map((f) => ({ filename: f.filename, title: f.title, bytes: f.bytes, pages: f.pages })),
    pages: (scan.pages || []).map((p) => ({
      url: p.url,
      task: p.task,
      title: p.title,
      strategy: p.meta && p.meta.strategy,
      framework: (p.meta && p.meta.framework) || undefined,
      file: pageToFile.get(p.url) || null,
    })),
  };
  // #10 per-document format (opt-in): metadata-only index of the per-page files, so a
  // consumer can load pages individually from documents/ + documents.jsonl. Omitted when
  // the format wasn't produced, so default manifests are unchanged.
  if (scan.documents && scan.documents.length) {
    m.documents = scan.documents.map((d) => ({
      id: d.id,
      url: d.url,
      title: d.title,
      fetchedAt: d.fetchedAt,
      bytes: d.bytes,
      file: `documents/${d.file}`,
      headings: d.headings,
    }));
  }
  return m;
}

function buildManifest({ id, createdAt, durationMs, targets, options, scans, warnings, tokens, status }) {
  return {
    runId: id,
    createdAt,
    status: status || 'done',
    durationMs,
    targets: (targets || []).map((t) => ({ url: t.url, task: t.task })),
    options: sanitizeOptions(options),
    stats: { pages: aggregatePages(scans), durationMs, scans: scans.length, tokens: tokens || aggregateTokens(scans) },
    scans: scans.map(buildScanManifest),
    warnings: warnings || [],
  };
}

function buildSummary({ id, createdAt, durationMs, scans, warnings, tokens, status }) {
  return {
    id,
    createdAt,
    status: status || 'done',
    durationMs,
    pages: aggregatePages(scans),
    tokens: tokens || aggregateTokens(scans),
    scans: scans.map((s) => ({
      scanId: s.scanId,
      url: s.url,
      task: s.task,
      title: s.title,
      pages: scanPages(s),
      files: (s.files || []).map((f) => ({ filename: f.filename, bytes: f.bytes })),
      warnings: (s.warnings || []).length,
    })),
    warnings: (warnings || []).length,
  };
}

// --- incremental persistence (#13) ------------------------------------------
// When saving is on, the crawl journals its state AS IT GOES so a crash (or a
// voluntary Stop) never loses extracted content:
//   run.json               written at START by initRun with status 'running'
//                          (+ targets/options, so a crashed run stays resumable),
//                          rewritten at the end by saveRun with 'done'/'stopped'
//   <scanId>/pages.jsonl   one JSON line per KEPT page: { page, links } — verbatim,
//                          append-only; resume replays it to rebuild the dedup
//                          state and to re-seed the frontier with the page's links
// pages.jsonl is deleted on a clean 'done' save (the same pages then live in the
// consolidated .md); it is KEPT on 'stopped' so the run remains resumable.

/**
 * Create (or, on resume, re-open) a run folder up front and mark it 'running'.
 * The original createdAt is preserved when the folder already exists.
 */
export async function initRun({ id = null, targets = [], options = {} }) {
  const runId = id || newRunId();
  const dir = runDir(runId, options);
  await mkdir(dir, { recursive: true });
  let createdAt = new Date().toISOString();
  try {
    const prev = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
    if (prev && prev.createdAt) createdAt = prev.createdAt;
  } catch {
    /* fresh run */
  }
  const summary = {
    id: runId,
    createdAt,
    status: 'running',
    durationMs: 0,
    pages: 0,
    // targets + options make a CRASHED run resumable: with no final manifest yet,
    // resume reads them from here.
    targets: (targets || []).map((t) => ({ url: t.url, task: t.task })),
    options: sanitizeOptions(options),
    scans: [],
  };
  await writeFile(path.join(dir, 'run.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  return { id: runId, dir, createdAt };
}

/** Append one kept page ({ page, links }) to a scan's journal. */
export async function appendJournal(id, scanId, record, opts = {}) {
  const sid = String(scanId);
  if (!ID_RE.test(sid)) throw new Error(`invalid scan id: ${sid}`);
  const dir = path.join(runDir(id, opts), sid);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, 'pages.jsonl'), JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Read a scan's journal. A crash can tear the last line mid-write: unparsable
 * lines are skipped — that page simply gets re-crawled on resume (never lost).
 */
export async function readJournal(id, scanId, opts = {}) {
  const sid = String(scanId);
  if (!ID_RE.test(sid)) throw new Error(`invalid scan id: ${sid}`);
  let raw;
  try {
    raw = await readFile(path.join(runDir(id, opts), sid, 'pages.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* torn tail line from a crash — skip; the page will be re-crawled */
    }
  }
  return out;
}

/**
 * Load everything resume needs from an interrupted run: its targets, its saved
 * options and each scan's journaled pages. Prefers the final manifest (a stopped
 * run wrote one); falls back to the initial run.json (a crashed run didn't).
 */
export async function loadRunForResume(id, opts = {}) {
  const dir = runDir(id, opts);
  let summary;
  try {
    summary = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
  } catch {
    throw new Error(`run ${id} not found in ${cacheRoot(opts)}`);
  }
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    /* crashed before the final save — run.json carries targets/options */
  }
  const status = summary.status || (manifest && manifest.status) || 'done';
  const targets = (manifest && manifest.targets) || summary.targets || [];
  const options = (manifest && manifest.options) || summary.options || {};
  const journals = {};
  for (let i = 0; i < targets.length; i++) {
    const sid = scanIdFor(targets[i].url, i);
    journals[sid] = await readJournal(id, sid, opts);
  }
  return { id, dir, createdAt: summary.createdAt, status, targets, options, journals };
}

/**
 * Persist a finished run to the cache.
 * @param {object} a
 * @param {Array<{url,task}>} a.targets
 * @param {object} a.options
 * @param {Array} a.scans   per-link scans: { scanId, url, task, title, pages, files, stats, warnings }
 * @param {string} [a.id]        reuse an existing run folder (incremental runs / resume)
 * @param {string} [a.createdAt] preserve the original creation time on resume
 * @param {string} [a.status]    'done' (frontier drained) | 'stopped' (voluntary stop — resumable)
 * @returns {Promise<{ id, dir, manifest, summary }>}
 */
export async function saveRun({
  targets,
  options,
  scans = [],
  durationMs = 0,
  warnings = [],
  tokens = null,
  id: existingId = null,
  createdAt: existingCreatedAt = null,
  status = 'done',
}) {
  const id = existingId || newRunId();
  const dir = runDir(id, options);
  const createdAt = existingCreatedAt || new Date().toISOString();

  await mkdir(dir, { recursive: true });

  // Each scan gets its own subfolder with its files + a self-contained manifest.
  // When the opt-in per-document format was produced (scan._docBundle), it is written
  // alongside under documents/ + index.md + documents.jsonl (see lib/output.mjs).
  for (const scan of scans) {
    const sid = String(scan.scanId);
    if (!ID_RE.test(sid)) throw new Error(`invalid scan id: ${sid}`);
    await writeBundle(path.join(dir, sid), {
      files: scan.files || [],
      manifest: buildScanManifest(scan),
      documents: scan._docBundle || null,
      states: scan._statesBundle || null,
    });
  }

  const manifest = buildManifest({ id, createdAt, durationMs, targets, options, scans, warnings, tokens, status });
  const summary = buildSummary({ id, createdAt, durationMs, scans, warnings, tokens, status });

  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile(path.join(dir, 'run.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  // A clean 'done' save supersedes the incremental journal (the same pages now live
  // in the consolidated files); a 'stopped' run keeps its journal so resume works.
  if (status === 'done') {
    for (const scan of scans) {
      await rm(path.join(dir, String(scan.scanId), 'pages.jsonl'), { force: true }).catch(() => {});
    }
  }

  return { id, dir, manifest, summary };
}

// --- legacy compatibility -------------------------------------------------
// Older runs (pre-scan) stored files/pages flat at the run root with a single
// task. Wrap them as one synthetic scan (scanId '' = files live at the root) so
// they still list and open.

function legacyScan({ url, task, pages, files, stats, warnings }) {
  return {
    scanId: '',
    url: url || '',
    task: task || '',
    title: url ? hostOf(url) : '',
    pages: pages || [],
    files: files || [],
    stats: stats || { pages: Array.isArray(pages) ? pages.length : pages || 0 },
    warnings: warnings || [],
  };
}

function normalizeManifest(m) {
  if (!m.status) m = { ...m, status: 'done' }; // pre-#13 runs are complete by construction
  if (Array.isArray(m.scans)) return m;
  const t = (m.targets && m.targets[0]) || {};
  const scan = buildScanManifest(
    legacyScan({
      url: t.url,
      task: t.task || (m.options && m.options.task),
      pages: m.pages,
      files: m.files,
      stats: m.stats,
      warnings: m.warnings,
    }),
  );
  return { ...m, scans: [scan] };
}

function normalizeSummary(s) {
  if (!s.status) s = { ...s, status: 'done' }; // pre-#13 runs are complete by construction
  if (Array.isArray(s.scans)) return s;
  const t = (s.targets && s.targets[0]) || {};
  return {
    ...s,
    scans: [
      {
        scanId: '',
        url: t.url || '',
        task: s.task || t.task || '',
        title: t.url ? hostOf(t.url) : '',
        pages: s.pages || 0,
        files: s.files || [],
        warnings: s.warnings || 0,
      },
    ],
  };
}

/** List cached runs (summaries), newest first. */
export async function listRuns(opts = {}) {
  const root = cacheRoot(opts);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const raw = await readFile(path.join(root, e.name, 'run.json'), 'utf8');
      runs.push(normalizeSummary(JSON.parse(raw)));
    } catch {
      /* skip incomplete/foreign dirs */
    }
  }
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return runs;
}

/** Load a run's full manifest. */
export async function getRun(id, opts = {}) {
  const dir = runDir(id, opts);
  const manifest = normalizeManifest(JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')));
  return { id, dir, manifest };
}

/** Read one output file's raw Markdown from a scan (or the run root for legacy). */
export async function readRunFile(id, scanId, name, opts = {}) {
  const dir = runDir(id, opts);
  const sid = String(scanId || '');
  if (sid && !ID_RE.test(sid)) throw new Error(`invalid scan id: ${sid}`);
  const base = path.basename(String(name));
  return readFile(sid ? path.join(dir, sid, base) : path.join(dir, base), 'utf8');
}

// --- Phase 2 "reshape" chat: derived files + session, per scan -------------
// Reshape outputs live UNDER the scan in a `chat/` subfolder, so the crawl's own
// files stay immutable ("crawl once, reshape many times"). `session.json` records
// the conversation and a registry of the files produced from it.

function scanChatDir(id, scanId, opts = {}) {
  const dir = runDir(id, opts);
  const sid = String(scanId || '');
  if (sid && !ID_RE.test(sid)) throw new Error(`invalid scan id: ${sid}`);
  return sid ? path.join(dir, sid, 'chat') : path.join(dir, 'chat');
}

/** Read a scan's reshape session ({ messages, files }); empty if none yet. */
export async function getChatSession(id, scanId, opts = {}) {
  try {
    const raw = await readFile(path.join(scanChatDir(id, scanId, opts), 'session.json'), 'utf8');
    const s = JSON.parse(raw);
    return {
      messages: Array.isArray(s.messages) ? s.messages : [],
      files: Array.isArray(s.files) ? s.files : [],
    };
  } catch {
    return { messages: [], files: [] };
  }
}

/** Persist a scan's reshape session. */
export async function saveChatSession(id, scanId, session, opts = {}) {
  const dir = scanChatDir(id, scanId, opts);
  await mkdir(dir, { recursive: true });
  const body = { messages: session.messages || [], files: session.files || [] };
  await writeFile(path.join(dir, 'session.json'), JSON.stringify(body, null, 2) + '\n', 'utf8');
  return body;
}

/** Write one derived (reshape) file into a scan's chat folder. Returns its name. */
export async function writeChatFile(id, scanId, name, content, opts = {}) {
  const dir = scanChatDir(id, scanId, opts);
  await mkdir(dir, { recursive: true });
  const base = path.basename(String(name));
  await writeFile(path.join(dir, base), content, 'utf8');
  return base;
}

/** Read one derived (reshape) file from a scan's chat folder. */
export async function readChatFile(id, scanId, name, opts = {}) {
  const base = path.basename(String(name));
  return readFile(path.join(scanChatDir(id, scanId, opts), base), 'utf8');
}

// --- activity trace: the live exploration timeline, kept for later replay ----
// The Web UI streams a narration (sites, clicks/navigations, captures) while a
// crawl runs and renders it as an Activity log + an exploration Tree. Persisting
// a compact copy lets a finished or reopened run show the same Activity/Tree
// instead of losing them the moment the crawl ends.

/** Persist a run's compact activity trace ([events]) for later replay. */
export async function saveActivity(id, events, opts = {}) {
  const dir = runDir(id, opts);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'activity.json'), JSON.stringify({ events: events || [] }) + '\n', 'utf8');
}

/** Read a run's saved activity trace ({ events }); empty if none was recorded. */
export async function readActivity(id, opts = {}) {
  try {
    const raw = await readFile(path.join(runDir(id, opts), 'activity.json'), 'utf8');
    const a = JSON.parse(raw);
    return { events: Array.isArray(a.events) ? a.events : [] };
  } catch {
    return { events: [] };
  }
}

/** Delete one run. */
export async function deleteRun(id, opts = {}) {
  await rm(runDir(id, opts), { recursive: true, force: true });
  return true;
}

/** Delete every cached run. Returns how many were removed. */
export async function deleteAllRuns(opts = {}) {
  const runs = await listRuns(opts);
  for (const r of runs) await deleteRun(r.id, opts);
  return runs.length;
}
