// docdna — public API + core orchestration.
//
// crawlDocs(targets, options) returns a `run` that is:
//   - async-iterable (yields events, §6)
//   - exposes `run.result` (Promise<Result>, §5)
//   - exposes `run.stop()` (graceful stop)
//
// The CLI, UI, and refdna are all just consumers of this. No crawling or
// strategy logic lives outside the core.

import { createHash } from 'node:crypto';
import { runDocsProfile } from './profiles/docs.mjs';
import { crawlPageWithEngine } from './engine/crawl-page.mjs';
import { aiInterpretTask } from './engine/decide.mjs';
import { applyExclusions } from './extract.mjs';
import { planFiles, transformFiles } from './lib/layout.mjs';
import { saveRun, scanIdFor } from './lib/runs.mjs';
import { closeBrowser } from './lib/browser.mjs';
import { normalizeUrl, inScope, pathOf, originOf, hostOf } from './lib/url.mjs';
import { isDocsTask } from './lib/task.mjs';

export const DEFAULT_OPTIONS = {
  task: 'Extract the complete documentation.',
  model: 'qwen3',
  ollamaHost: undefined, // override the Ollama server URL (default: http://127.0.0.1:11434)
  browser: 'auto', // 'never' | 'auto' | 'always'
  concurrency: 4,
  maxPages: 0, // 0 = unlimited
  maxActions: 15,
  include: undefined,
  exclude: undefined,
  cacheDir: undefined, // override the runs-cache root (default: <project>/.docdna/runs)
  onEvent: undefined,
};

/** Normalise the `targets` argument (§5) into `[{ url, task }]`. */
export function normalizeTargets(targets, defaultTask) {
  const one = (t) => {
    if (typeof t === 'string') return { url: t, task: defaultTask };
    if (t && typeof t === 'object' && t.url) return { url: t.url, task: t.task || defaultTask };
    return null;
  };
  const list = Array.isArray(targets) ? targets : [targets];
  return list.map(one).filter(Boolean);
}

/** An async-iterable event stream backed by a buffer (no backpressure loss). */
function createEventStream() {
  const queue = [];
  let pending = null;
  let closed = false;

  return {
    push(ev) {
      if (closed) return;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ value: ev, done: false });
      } else {
        queue.push(ev);
      }
    },
    close() {
      closed = true;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            pending = resolve;
          });
        },
        return() {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

/**
 * The defining capability lives behind this single entry point.
 * @param {string|string[]|{url,task?}|Array<{url,task?}>} targets
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 */
export function crawlDocs(targets, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  opts.concurrency = Math.max(1, Number(opts.concurrency) || 1);
  opts.maxPages = Math.max(0, Number(opts.maxPages) || 0);
  opts.maxActions = Math.max(1, Number(opts.maxActions) || 1);

  const list = normalizeTargets(targets, opts.task);
  const stream = createEventStream();
  const startTime = Date.now();

  // Each submitted link is an independent SCAN: its own pages, its own dedup,
  // its own output files. A run is just the container recording which scans were
  // crawled together (the user can later open one link or the whole run).
  const emptyCounts = () => ({ 'docs:llms-full': 0, 'docs:sitemap': 0, 'docs:framework': 0, agent: 0 });
  const scans = list.map((t, i) => ({
    scanId: scanIdFor(t.url, i),
    index: i,
    url: t.url,
    task: t.task,
    title: hostOf(t.url) || t.url,
    pages: [],
    files: [],
    stats: { pages: 0, durationMs: 0, strategyCounts: emptyCounts() },
    warnings: [],
    _hashes: new Set(), // de-dupe pages with identical content, PER scan
    _startedAt: 0,
  }));

  const result = {
    scans,
    stats: { pages: 0, durationMs: 0, strategyCounts: emptyCounts() },
    warnings: [],
    run: null, // { id, dir, scans } once the run is saved to the cache
  };

  let stopped = false;
  let resolveResult;
  const resultPromise = new Promise((r) => {
    resolveResult = r;
  });

  // Interpret each scan's task ONCE into faithful output directives (e.g.
  // "don't include images" -> exclude.images). Enforced centrally in addPage so
  // EVERY page source (llms-full, sitemap, engine, static fallback) honours it.
  // Cached per task string; model failure degrades to the deterministic backstop
  // inside aiInterpretTask, never aborts the crawl.
  const _directiveCache = new Map();
  async function interpretTask(task) {
    if (_directiveCache.has(task)) return _directiveCache.get(task);
    let d;
    try {
      d = await aiInterpretTask({ model: opts.model, task, host: opts.ollamaHost });
    } catch {
      d = { exclude: { images: false, links: false } };
    }
    _directiveCache.set(task, d);
    const ex = (d && d.exclude) || {};
    if (ex.images || ex.links) {
      const parts = [ex.images && 'images', ex.links && 'links'].filter(Boolean).join(', ');
      emit({ type: 'action', action: 'exclude', detail: 'excluding ' + parts + ' (task directive)' });
    }
    if (d && d.transform && d.transform.shape) {
      emit({ type: 'action', action: 'transform', detail: 'output shape: ' + d.transform.shape });
    }
    return d;
  }

  function emit(ev) {
    // Stamp the active scan so consumers (UI/CLI) can route every event to the
    // right link, without the engine/profiles having to know about scans.
    if (ctx.currentScan && ev.scanId == null) {
      ev.scanId = ctx.currentScan.scanId;
      ev.scanIndex = ctx.currentScan.index;
    }
    if (ev.type === 'warn') {
      const w = { url: ev.url, reason: ev.reason, message: ev.message, scanId: ev.scanId };
      result.warnings.push(w);
      if (ctx.currentScan) ctx.currentScan.warnings.push(w);
    }
    stream.push(ev);
    if (typeof opts.onEvent === 'function') {
      try {
        opts.onEvent(ev);
      } catch {
        /* a faulty consumer must not break the crawl */
      }
    }
  }

  // Per-scan page cap: a scan stops at maxPages on its own, like a separate run,
  // without aborting the others. The global stop() still halts everything.
  const shouldStop = () =>
    stopped || (opts.maxPages > 0 && !!ctx.currentScan && ctx.currentScan.pages.length >= opts.maxPages);

  const ctx = {
    options: opts,
    emit,
    shouldStop,
    currentScan: null,
    directives: null, // faithful task exclusions for the active scan (set per scan)
    progress: { done: 0, total: 0 },
    // Open a scan: it becomes the target for addPage/dedup/progress + event tags.
    beginScan(scan) {
      ctx.currentScan = scan;
      scan._startedAt = Date.now();
      ctx.progress = { done: 0, total: 0 };
    },
    setTotal(n) {
      ctx.progress.total = Math.max(ctx.progress.total, Number(n) || 0);
    },
    // Progress measures WORK PROCESSED, not pages kept — so the bar always
    // reaches 100% when the frontier drains (dedup/discovery/empty pages would
    // otherwise leave it short, e.g. stuck at 162/297). Call once per unit of
    // work attempted, whether or not it produced a kept page.
    markProcessed() {
      ctx.progress.done += 1;
      emit({ type: 'progress', done: ctx.progress.done, total: ctx.progress.total });
    },
    addPage(page) {
      const scan = ctx.currentScan;
      if (!scan) return;
      if (opts.maxPages > 0 && scan.pages.length >= opts.maxPages) return;
      // Enforce the scan's faithful task exclusions ("don't include images")
      // before dedup/output, so it applies uniformly to every page source and
      // the dedup signature sees the same content the file will. Verbatim-safe.
      const ex = (ctx.directives && ctx.directives.exclude) || null;
      if (ex && (ex.images || ex.links)) {
        const stripped = applyExclusions(page.markdown || '', ex);
        page = {
          ...page,
          markdown: stripped,
          meta: { ...(page.meta || {}), bytes: Buffer.byteLength(stripped, 'utf8') },
        };
      }
      // Skip pages whose content duplicates one already captured in THIS scan
      // (the same page reached via throwaway query params like ?version=). The
      // signature ignores link/URL targets so near-identical pages collapse too.
      const md = page.markdown || '';
      const sig = md
        .replace(/!?\[[^\]]*\]\([^)]*\)/g, '') // drop links/images entirely
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const hash = createHash('sha1').update(sig).digest('hex');
      if (scan._hashes.has(hash)) return;
      scan._hashes.add(hash);
      scan.pages.push(page);
      const s = (page.meta && page.meta.strategy) || 'agent';
      scan.stats.strategyCounts[s] = (scan.stats.strategyCounts[s] || 0) + 1;
      // Note: progress is driven by markProcessed (work done), not by kept pages.
      emit({
        type: 'extracted',
        url: page.url,
        title: page.title,
        bytes: (page.meta && page.meta.bytes) || Buffer.byteLength(md, 'utf8'),
        preview: md.slice(0, 600),
      });
    },
    // Passed to the docs profile so it can drive (or fall back to) the general
    // engine — optionally seeded with a known page set — without a circular import.
    runEngine: (target, opts) => runGeneralCrawl(target, ctx, opts),
  };

  (async () => {
    try {
      for (const scan of scans) {
        if (stopped) break;
        ctx.beginScan(scan);
        emit({ type: 'site', url: scan.url, task: scan.task, title: scan.title });
        scan._directives = ctx.directives = await interpretTask(scan.task);
        const target = { url: scan.url, task: scan.task };
        if (isDocsTask(scan.task)) {
          await runDocsProfile(target, ctx);
        } else {
          await runGeneralCrawl(target, ctx);
        }
        scan.stats.pages = scan.pages.length;
        scan.stats.durationMs = Date.now() - scan._startedAt;
      }
    } catch (err) {
      emit({ type: 'error', message: 'crawl failed: ' + (err && err.message ? err.message : String(err)) });
    } finally {
      ctx.currentScan = null; // the finalize events below are run-level, not per-scan

      // Each scan files its OWN kept pages independently (its task drives the
      // layout), so two links behave like two separate runs grouped under one.
      for (const scan of scans) {
        try {
          const dir = scan._directives || {};
          if (!scan.pages.length) {
            scan.files = [];
          } else {
            // The general block router decides ALL file layout from the task +
            // the actual content (single / per-page / by-category / images-with-
            // or-without-their-text / duplicate-into-two-files / …).
            scan.files = await planFiles({ model: opts.model, task: scan.task, pages: scan.pages, host: opts.ollamaHost });
            // Opt-in output transform ("…as a table"). Grounded + self-targeting;
            // a no-op unless the task explicitly requested a shape.
            if (dir.transform && scan.files.length) {
              scan.files = await transformFiles(scan.files, {
                model: opts.model,
                task: scan.task,
                transform: dir.transform,
                host: opts.ollamaHost,
              });
            }
          }
        } catch (err) {
          scan.files = [];
          emit({
            type: 'warn',
            url: scan.url,
            reason: 'layout',
            message: 'Failed to plan files for ' + scan.url + ': ' + (err && err.message),
            scanId: scan.scanId,
          });
        }
      }

      // Aggregate stats across scans for the run-level summary line.
      result.stats.pages = scans.reduce((n, s) => n + s.pages.length, 0);
      result.stats.durationMs = Date.now() - startTime;
      for (const s of scans) {
        for (const [k, v] of Object.entries(s.stats.strategyCounts)) {
          result.stats.strategyCounts[k] = (result.stats.strategyCounts[k] || 0) + v;
        }
      }

      // Every run is cached: one folder, one subfolder per scan.
      try {
        const saved = await saveRun({
          targets: list,
          options: opts,
          scans,
          durationMs: result.stats.durationMs,
          warnings: result.warnings,
        });
        result.run = { id: saved.id, dir: saved.dir, scans: saved.summary.scans };
        emit({ type: 'saved', runId: saved.id, dir: saved.dir, scans: saved.summary.scans });
      } catch (err) {
        emit({ type: 'warn', reason: 'cache', message: 'Failed to save run: ' + (err && err.message) });
      }

      await closeBrowser();
      emit({ type: 'done', stats: result.stats, run: result.run });
      stream.close();
      resolveResult(result);
    }
  })();

  return {
    [Symbol.asyncIterator]() {
      return stream[Symbol.asyncIterator]();
    },
    get result() {
      return resultPromise;
    },
    stop() {
      stopped = true;
    },
  };
}

/**
 * General per-site crawl (§3): a sequential frontier driven by the browser-first
 * engine, with dedupe + scope. Used for non-doc tasks and to drive the docs
 * profile over a seeded page set.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.seeds]   pages to enqueue up front (e.g. from a sitemap)
 * @param {boolean}  [opts.announce] emit a `strategy: agent` event (default true)
 * @param {string}   [opts.scopePrefix] restrict the frontier to URLs under this path
 */
async function runGeneralCrawl(target, ctx, opts = {}) {
  const { seeds = [], announce = true, scopePrefix = null } = opts;
  // Link-following is always AI-gated in the page engine (crawl-page.mjs), so
  // the crawl never wanders into off-task pages regardless of the strategy.
  const start = normalizeUrl(target.url) || target.url;
  if (announce) ctx.emit({ type: 'strategy', url: target.url, strategy: 'agent' });

  const inFrontierScope = (n) => {
    if (!inScope(n, target.url, ctx.options)) return false;
    if (scopePrefix) {
      const p = pathOf(n);
      if (!(p === scopePrefix || p.startsWith(scopePrefix + '/'))) return false;
    }
    return true;
  };

  const visited = new Set();
  const queued = new Set();
  const queue = [];
  // Discovery-only URLs are crawled to harvest their links (e.g. the site root's
  // navigation) but are not themselves emitted as result pages.
  const discoveryOnly = new Set();

  const enqueue = (raw) => {
    const n = normalizeUrl(raw);
    if (!n || queued.has(n) || visited.has(n)) return;
    if (!inFrontierScope(n)) return;
    queued.add(n);
    queue.push(n);
  };
  const enqueueDiscovery = (raw) => {
    const n = normalizeUrl(raw);
    if (!n || queued.has(n) || visited.has(n)) return;
    queued.add(n);
    queue.push(n);
    discoveryOnly.add(n);
  };

  enqueue(start);
  for (const s of seeds) enqueue(s);
  // Base the bar on the ACTUAL frontier, not on any earlier setTotal() estimate
  // (e.g. a sitemap's raw count) that may include URLs filtered out at enqueue —
  // an unreachable floor is what left the bar stuck below 100%.
  ctx.progress.total = ctx.progress.done + queue.length;
  ctx.emit({ type: 'progress', done: ctx.progress.done, total: ctx.progress.total });

  let produced = 0;
  let bootstrapped = false;
  let active = 0; // pages currently being crawled

  // Each page's reveal loop is self-contained, so pages can be crawled in
  // parallel (each in its own browser context) — far faster on large docs sets.
  const concurrency = Math.max(1, Number(ctx.options.concurrency) || 1);

  async function processOne(url) {
    if (!discoveryOnly.has(url)) ctx.emit({ type: 'page', url, status: 0 });
    let outcome;
    try {
      outcome = await crawlPageWithEngine({ url, task: target.task }, ctx);
    } catch (err) {
      ctx.emit({ type: 'error', url, message: 'page failed: ' + (err && err.message) });
      return;
    }
    if (outcome.page && !discoveryOnly.has(url)) {
      ctx.addPage(outcome.page);
      produced++;
    }
    for (const link of outcome.links || []) enqueue(link);
  }

  async function worker() {
    while (!ctx.shouldStop()) {
      if (queue.length === 0) {
        if (active > 0) {
          // Another worker may still enqueue links; wait briefly and re-check.
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        // Frontier truly drained. Recover once if the entry led nowhere (e.g. a
        // 404 section root or an SPA with no static links) by discovering from
        // the site root's navigation.
        if (!bootstrapped && produced === 0) {
          bootstrapped = true;
          const root = normalizeUrl((originOf(target.url) || '') + '/');
          if (root && root !== start) {
            ctx.emit({
              type: 'warn',
              url: target.url,
              reason: 'bootstrap-root',
              message: 'Entry yielded no pages; discovering from the site root and following navigation.',
            });
            enqueueDiscovery(root);
            continue;
          }
        }
        return;
      }

      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      active += 1;
      try {
        await processOne(url);
      } finally {
        active -= 1;
        // One unit of work done; total = processed + still-queued + in-flight.
        // Every queued URL is guaranteed to be processed, so done converges to
        // total and the bar hits 100% exactly when the frontier drains.
        ctx.progress.done += 1;
        ctx.progress.total = ctx.progress.done + queue.length + active;
        ctx.emit({ type: 'progress', done: ctx.progress.done, total: ctx.progress.total });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

export default crawlDocs;
