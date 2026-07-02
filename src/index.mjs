// sagecrawl — public API + core orchestration.
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
import { assembleScan, assemblePerDocument } from './lib/layout.mjs';
import { saveRun, scanIdFor } from './lib/runs.mjs';
import { closeBrowser, configureContextPool } from './lib/browser.mjs';
import { normalizeUrl, inScope, pathOf, originOf, hostOf } from './lib/url.mjs';
import { isDocsTask } from './lib/task.mjs';
import { resolveLlm, checkModel, abortPendingLlm } from './lib/llm.mjs';
import { simhash, hamming } from './lib/simhash.mjs';

export const DEFAULT_OPTIONS = {
  task: 'Extract the complete documentation.',
  model: '', // REQUIRED — no fake default. The engine needs a real model: a local
  // Ollama model (e.g. 'qwen3-coder:30b') or an OpenAI-compatible model id. There is
  // no model that is universally present, so pretending one exists only produces a
  // silent failure. Pick one explicitly (see `provider`).
  provider: 'ollama', // 'ollama' (local) | 'openai' (any OpenAI-compatible API: URL + key)
  ollamaHost: undefined, // override the Ollama server URL (default: http://127.0.0.1:11434)
  baseUrl: undefined, // OpenAI-compatible API base URL (provider 'openai')
  apiKey: undefined, // API key (provider 'openai'); falls back to SAGECRAWL_API_KEY / OPENAI_API_KEY
  browser: 'auto', // 'never' | 'auto' | 'always'
  concurrency: 4,
  maxPages: 0, // 0 = unlimited
  maxActions: 40, // per-page reveal action cap. A ceiling, not a target: simple pages
  // stop early when no controls remain; stateful pages (paginators, calendar months,
  // many tabs) need the headroom. Disabled controls are skipped so it isn't wasted.
  include: undefined,
  exclude: undefined,
  minRelevance: 0, // FOCUSED MODE (0 = off, precision-first default). When > 0 (0..1),
  // links whose task-relevance score is below this are pruned BEFORE the AI gate — a
  // universal, task-driven way to keep the crawl on-topic without per-site rules. Only
  // applies when the task discriminates among a page's links, so a generic task is never
  // over-pruned. Trades some recall for speed/scope, so it stays opt-in. See lib/relevance.mjs.
  // Persistence is OPT-IN. As a library, sagecrawl writes NOTHING by default: the full
  // result (scans[].files[].markdown) is returned in memory for the caller to save
  // wherever they like. A run is written to the cache ONLY when the caller opts in —
  // by setting `save: true`, or by giving an explicit `cacheDir` (or SAGECRAWL_CACHE_DIR).
  // The CLI and Web UI are apps, so they pass `save: true` (cache rooted at cwd).
  save: false,
  cacheDir: undefined, // where to save when saving is on (default: <cwd>/.sagecrawl/runs)
  perDocument: false, // ALSO package one identifiable .md per page (+ index.md + JSONL)
  // for programmatic consumers, alongside the consolidated .md. Off by default (the
  // consolidated file is friendlier for a human). Pure repackaging — content stays
  // verbatim, nothing is filtered or transformed. See lib/layout.mjs assemblePerDocument.
  nearDupHamming: 0, // NEAR-DUP DEDUP (0 = off, exact-only — the safe default). When > 0,
  // pages whose 64-bit SimHash is within this Hamming distance of an already-kept page are
  // collapsed as near-duplicates (template-only differences). OPT-IN because collapsing
  // "almost identical" pages can drop a page whose unique bit is small — against "never
  // lose content"; the default drops NOTHING beyond exact duplicates. 3 ≈ Manku/Google.
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
  opts.minRelevance = Math.min(1, Math.max(0, Number(opts.minRelevance) || 0));
  opts.nearDupHamming = Math.min(64, Math.max(0, Math.floor(Number(opts.nearDupHamming) || 0)));
  // Size the browser-context pool to the concurrency so each worker keeps (and reuses)
  // its own context — the site's shared CSS/JS is then cached across pages instead of
  // re-downloaded per page. See src/lib/browser.mjs.
  configureContextPool(opts.concurrency);
  // Resolve the model provider once; the engine reads ctx.options.llm and stays
  // provider-agnostic (Ollama or any OpenAI-compatible API).
  opts.llm = resolveLlm(opts);

  // Persistence is opt-in (see DEFAULT_OPTIONS.save): write a run to the cache only
  // when the caller asked — explicitly via `save`, or implicitly by naming a place
  // to put it (`cacheDir` / SAGECRAWL_CACHE_DIR). Otherwise the crawl stays in memory.
  const willSave = opts.save === true || !!opts.cacheDir || !!process.env.SAGECRAWL_CACHE_DIR;

  const list = normalizeTargets(targets, opts.task);
  const stream = createEventStream();
  const startTime = Date.now();

  // Each submitted link is an independent SCAN: its own pages, its own dedup,
  // its own output files. A run is just the container recording which scans were
  // crawled together (the user can later open one link or the whole run).
  const emptyCounts = () => ({ 'docs:llms-full': 0, 'docs:sitemap': 0, 'docs:framework': 0, agent: 0 });
  // AI usage meter — input/output token totals so a run's API cost can be
  // approximated after the fact (input and output are billed differently).
  // `byKind` splits the same totals by WHICH judgment spent them (reveal / scope /
  // links / nav-plan / …), so the eval harness (src/eval) can show WHERE the tokens
  // go, not just the grand total. Same shape as the top-level counters, per kind.
  // `cachedInputTokens` (#4) counts the slice of inputTokens a remote provider served
  // from its prompt cache (~10× cheaper) — visible proof the stable prefixes pay off.
  const emptyTokens = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, byKind: {} });
  const scans = list.map((t, i) => ({
    scanId: scanIdFor(t.url, i),
    index: i,
    url: t.url,
    task: t.task,
    title: hostOf(t.url) || t.url,
    pages: [],
    files: [],
    documents: [], // per-page format, populated only when opts.perDocument is on (#10)
    stats: { pages: 0, durationMs: 0, strategyCounts: emptyCounts(), tokens: emptyTokens() },
    warnings: [],
    _hashes: new Set(), // de-dupe pages with identical content, PER scan
    _startedAt: 0,
  }));

  const result = {
    scans,
    stats: { pages: 0, durationMs: 0, strategyCounts: emptyCounts(), tokens: emptyTokens() },
    warnings: [],
    run: null, // { id, dir, scans } once the run is saved to the cache
  };

  let stopped = false;
  let resolveResult;
  const resultPromise = new Promise((r) => {
    resolveResult = r;
  });

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
      emit({ type: 'progress', done: ctx.progress.done, total: ctx.progress.total, tokens: { ...result.stats.tokens } });
    },
    addPage(page) {
      const scan = ctx.currentScan;
      if (!scan) return;
      if (opts.maxPages > 0 && scan.pages.length >= opts.maxPages) return;
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
      // OPT-IN near-duplicate collapse (nearDupHamming > 0): drop a page whose SimHash is
      // within the Hamming threshold of one already kept (same content, template-only
      // difference). Default 0 = off, so NOTHING beyond exact dupes is ever dropped — this
      // can only lose content when the user explicitly asks for it. Computed over the same
      // link/URL-stripped signature, so differing nav/URLs don't hide a near-dup.
      if (opts.nearDupHamming > 0) {
        const sh = simhash(sig);
        if (!scan._simhashes) scan._simhashes = [];
        for (const prev of scan._simhashes) {
          if (hamming(sh, prev) <= opts.nearDupHamming) return; // near-dup of a kept page
        }
        scan._simhashes.push(sh);
      }
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
    tokens: result.stats.tokens, // run-level alias, surfaced on progress events
  };

  // Sink every model call's token usage into the run total and the active scan, so
  // the saved run records how much AI it cost (the engine/profiles stay unaware).
  // `kind` (reveal/scope/links/nav-plan/…) is accumulated into `byKind` alongside the
  // grand totals, so the cost can be attributed per call type without any extra plumbing.
  opts.llm.__onUsage = ({ kind = 'other', inputTokens = 0, outputTokens = 0, cachedInputTokens = 0 } = {}) => {
    const bump = (t) => {
      if (!t) return;
      t.calls += 1;
      t.inputTokens += inputTokens;
      t.outputTokens += outputTokens;
      t.cachedInputTokens = (t.cachedInputTokens || 0) + cachedInputTokens;
      if (!t.byKind) t.byKind = {};
      const k = t.byKind[kind] || (t.byKind[kind] = { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
      k.calls += 1;
      k.inputTokens += inputTokens;
      k.outputTokens += outputTokens;
      k.cachedInputTokens = (k.cachedInputTokens || 0) + cachedInputTokens;
    };
    bump(result.stats.tokens);
    if (ctx.currentScan) bump(ctx.currentScan.stats.tokens);
  };

  (async () => {
    try {
      // Health-check the model ONCE before crawling. The judgment calls all
      // `.catch()` and bias toward keep/follow/reveal, so a misconfigured model
      // would silently degrade the whole crawl to heuristics (no AI reveal/scope/
      // link-gating) and the caller would get poor output with no clue why. Warn
      // loudly instead — the crawl still runs (heuristics keep it from losing
      // content), but the reason is now visible.
      const health = await checkModel(opts.llm);
      if (!health.ok) {
        emit({
          type: 'warn',
          reason: 'model',
          message:
            `Model not usable (${health.reason}). Running in DEGRADED heuristic mode — ` +
            `AI reveal/scope/link-gating are OFF. Set a working model: a running local ` +
            `Ollama model (e.g. model:'qwen3-coder:30b'), or provider:'openai' with baseUrl + apiKey.`,
        });
      }

      for (const scan of scans) {
        if (stopped) break;
        ctx.beginScan(scan);
        emit({ type: 'site', url: scan.url, task: scan.task, title: scan.title });
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
          if (!scan.pages.length) {
            scan.files = [];
          } else {
            // Phase 1 output: one consolidated, VERBATIM .md per link. No splitting,
            // filtering or reshaping happens here — that is Phase 2 ("reshape", the
            // chat over these saved files). The crawl stays faithful by construction.
            scan.files = assembleScan({ task: scan.task, pages: scan.pages });
            // #10 (opt-in): ALSO package one identifiable document per page (+ index +
            // JSONL). Pure repackaging of the SAME pages — the consolidated .md above is
            // unchanged and no content is lost. `_docBundle` carries the files to save.
            if (opts.perDocument) {
              const doc = assemblePerDocument({ task: scan.task, pages: scan.pages });
              scan.documents = doc.documents;
              scan._docBundle = doc;
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

      // Persistence is opt-in. When the caller didn't ask to save (the library
      // default), write nothing: result.scans[].files[].markdown is already in
      // memory for them to put wherever they like. When they did opt in, save one
      // folder per run (one subfolder per scan) under the cache root (cwd default).
      if (willSave) {
        try {
          const saved = await saveRun({
            targets: list,
            options: opts,
            scans,
            durationMs: result.stats.durationMs,
            warnings: result.warnings,
            tokens: result.stats.tokens,
          });
          result.run = { id: saved.id, dir: saved.dir, scans: saved.summary.scans };
          emit({ type: 'saved', runId: saved.id, dir: saved.dir, scans: saved.summary.scans });
        } catch (err) {
          emit({ type: 'warn', reason: 'cache', message: 'Failed to save run: ' + (err && err.message) });
        }
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
      // Drop the queued judgment-call backlog so Stop is near-instant instead of
      // waiting for a slow local model to chew through it (only ≤N in-flight calls
      // remain, each bounded by the request timeout).
      abortPendingLlm();
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
        ctx.emit({ type: 'progress', done: ctx.progress.done, total: ctx.progress.total, tokens: { ...ctx.tokens } });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

export default crawlDocs;
