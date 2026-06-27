// Run cache (§9): every crawl is saved, whether or not the caller asked for it.
//
// A run is one folder under the cache root. Each submitted link is an
// independent SCAN, stored in its own subfolder:
//   <cacheRoot>/<runId>/
//     manifest.json       full, machine-friendly index (scans[] → files + pages)
//     run.json            a small summary used to list runs quickly
//     <scanId>/           one subfolder per link, e.g. 01-docusaurus-io/
//       <grouped>.md      that link's AI-grouped Markdown files (lib/layout.mjs)
//       manifest.json     a self-contained per-scan index
//
// The run is just the container recording which links were crawled together;
// the user can open one link on its own or the whole run grouped. The cache root
// defaults to `<project>/.docdna/runs`, overridable with the `cacheDir` option or
// the DOCDNA_CACHE_DIR env var. Runs are kept until explicitly deleted.

import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBundle } from './output.mjs';
import { slug, hostOf } from './url.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // .../src/lib
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const ID_RE = /^[A-Za-z0-9_-]+$/;

/** Resolve the cache root directory (option > env > project default). */
export function cacheRoot(opts = {}) {
  if (opts && opts.cacheDir) return path.resolve(opts.cacheDir);
  if (process.env.DOCDNA_CACHE_DIR) return path.resolve(process.env.DOCDNA_CACHE_DIR);
  return path.join(PROJECT_ROOT, '.docdna', 'runs');
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
    if (v instanceof RegExp) clean[k] = v.source;
    else clean[k] = v;
  }
  return clean;
}

const scanPages = (s) => (s && s.stats && s.stats.pages) || (s && s.pages ? s.pages.length : 0) || 0;
const aggregatePages = (scans) => scans.reduce((n, s) => n + scanPages(s), 0);

/** The full, machine-friendly index for one scan (also written into its folder). */
function buildScanManifest(scan) {
  // url -> first file that contains its content
  const pageToFile = new Map();
  for (const f of scan.files || []) {
    for (const url of f.pages || []) if (!pageToFile.has(url)) pageToFile.set(url, f.filename);
  }
  return {
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
}

function buildManifest({ id, createdAt, durationMs, targets, options, scans, warnings }) {
  return {
    runId: id,
    createdAt,
    durationMs,
    targets: (targets || []).map((t) => ({ url: t.url, task: t.task })),
    options: sanitizeOptions(options),
    stats: { pages: aggregatePages(scans), durationMs, scans: scans.length },
    scans: scans.map(buildScanManifest),
    warnings: warnings || [],
  };
}

function buildSummary({ id, createdAt, durationMs, scans, warnings }) {
  return {
    id,
    createdAt,
    durationMs,
    pages: aggregatePages(scans),
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

/**
 * Persist a finished run to the cache.
 * @param {object} a
 * @param {Array<{url,task}>} a.targets
 * @param {object} a.options
 * @param {Array} a.scans   per-link scans: { scanId, url, task, title, pages, files, stats, warnings }
 * @returns {Promise<{ id, dir, manifest, summary }>}
 */
export async function saveRun({ targets, options, scans = [], durationMs = 0, warnings = [] }) {
  const id = newRunId();
  const dir = runDir(id, options);
  const createdAt = new Date().toISOString();

  await mkdir(dir, { recursive: true });

  // Each scan gets its own subfolder with its files + a self-contained manifest.
  for (const scan of scans) {
    const sid = String(scan.scanId);
    if (!ID_RE.test(sid)) throw new Error(`invalid scan id: ${sid}`);
    await writeBundle(path.join(dir, sid), { files: scan.files || [], manifest: buildScanManifest(scan) });
  }

  const manifest = buildManifest({ id, createdAt, durationMs, targets, options, scans, warnings });
  const summary = buildSummary({ id, createdAt, durationMs, scans, warnings });

  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile(path.join(dir, 'run.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

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
