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
import { saveRun, scanIdFor, initRun, appendJournal, loadRunForResume, cacheRoot } from './lib/runs.mjs';
import { retainBrowser, releaseBrowser, configureContextPool } from './lib/browser.mjs';
import { normalizeUrl, inScope, pathOf, originOf, hostOf, siblingKey } from './lib/url.mjs';
import { isDocsTask } from './lib/task.mjs';
import { resolveLlm, checkModel, abortPendingLlm, llmDisabled } from './lib/llm.mjs';
import { simhash, hamming } from './lib/simhash.mjs';

export const DEFAULT_OPTIONS = {
  task: 'Extract the complete documentation.',
  model: '', // REQUIRED — no fake default. The engine needs a real model: a local
  // Ollama model (e.g. 'qwen3-coder:30b') or an OpenAI-compatible model id. There is
  // no model that is universally present, so pretending one exists only produces a
  // silent failure. Pick one explicitly (see `provider`).
  provider: 'ollama', // 'ollama' (local) | 'openai' (any OpenAI-compatible API: URL + key)
  noAi: false, // CRAWL WITHOUT AI. The engine keeps its full mechanics — render, reveal
  // (heuristic-triaged clicks), extract, dedup — but makes ZERO model calls: pages are
  // kept whole (no section scoping) and EVERY in-scope link is followed (no link gate).
  // Costs no tokens and needs no model; trade-off: the output is not task-filtered and
  // a large site may take LONGER overall (the AI link gate is what keeps a crawl small).
  // Pair with include/exclude, minRelevance or maxPages to contain it. The task still
  // matters deterministically: docs detection, best-first frontier ordering, route budget.
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
  maxRoutes: 200, // #16 — cap on the SPECULATIVE JS-mined routes (perceive digs up to
  // 800 same-site paths per page out of script/JSON blobs) that reach the AI link
  // gate, ranked by task relevance first. 0 = unlimited. Conservative: the cut only
  // happens when the scores discriminate among the routes — a generic task (all 1)
  // or an off-vocabulary one (all 0) cuts NOTHING. Real DOM links are never capped.
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
  nearDupHamming: 0, // CROSS-PATH NEAR-DUP DEDUP (0 = off, exact-only — the safe default).
  // When > 0, a page whose 64-bit SimHash is within this Hamming distance of ANY already-kept
  // page is collapsed. OPT-IN because content similarity alone cannot tell a duplicate from a
  // sibling: measured on a real run (vuetify, 1491 pages), 36 pairs of GENUINELY DISTINCT API
  // pages sat at distance ≤3 (two at 0 — templated pages whose distinguishing tokens are link
  // text, which pageSignature strips). Any global threshold would drop real content.
  mirrorHamming: 8, // MIRROR/VARIANT DEDUP (default ON). Collapse a page only when BOTH
  // signals agree it is a re-serving of a kept page: (1) its URL is a SIBLING of the kept
  // page's — same path once a leading locale segment is stripped, so mirror hosts
  // (dev./staging./v2.), UI-state query variants (?panel=settings) and locale twins
  // (/en/x vs /x) qualify — and (2) its content SimHash is within this Hamming distance.
  // The two-signal AND is what makes a default-on setting safe: measured on the same run,
  // TRUE sibling duplicates cluster at distance ≤8 (72% of 657 pairs; median 4) while
  // sibling-SHAPED pages with real content differences (release-notes?version=A vs B,
  // same path on an unrelated product subdomain) start at 10 and sit mostly ≥23. Without
  // this gate, 57% of that run's pages (and ~35 min of its hour) were mirror re-crawls.
  // 0 = off. Cross-PATH near-dups are never touched by this tier (see nearDupHamming).
  onEvent: undefined,
};

/**
 * The content signature addPage dedups on: links/URLs/whitespace stripped, then
 * lowercased. Shared with the resume replay (#13) so a restored run recognises
 * its own pages — the two MUST stay byte-identical or resume would re-keep them.
 */
export function pageSignature(markdown) {
  return String(markdown || '')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, '') // drop links/images entirely
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

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
  opts.maxRoutes = Math.max(0, Math.floor(Number(opts.maxRoutes) || 0));
  opts.nearDupHamming = Math.min(64, Math.max(0, Math.floor(Number(opts.nearDupHamming) || 0)));
  opts.mirrorHamming = Math.min(64, Math.max(0, Math.floor(Number(opts.mirrorHamming) || 0)));
  // Size the browser-context pool to the concurrency so each worker keeps (and reuses)
  // its own context — the site's shared CSS/JS is then cached across pages instead of
  // re-downloaded per page. See src/lib/browser.mjs.
  configureContextPool(opts.concurrency);
  // Resolve the model provider once; the engine reads ctx.options.llm and stays
  // provider-agnostic (Ollama or any OpenAI-compatible API).
  opts.llm = resolveLlm(opts);

  // Resume payload (#13), set only by resumeCrawl: { id, journals } — the run id to
  // re-open and each scan's already-journaled pages. Internal; never a public option.
  const resume = opts.__resume || null;

  // Persistence is opt-in (see DEFAULT_OPTIONS.save): write a run to the cache only
  // when the caller asked — explicitly via `save`, or implicitly by naming a place
  // to put it (`cacheDir` / SAGECRAWL_CACHE_DIR). Otherwise the crawl stays in memory.
  const willSave = opts.save === true || !!opts.cacheDir || !!process.env.SAGECRAWL_CACHE_DIR || !!resume;

  // Incremental journal (#13): when saving is on, every kept page is appended to
  // <run>/<scanId>/pages.jsonl AS IT IS CAPTURED, so a crash (or Stop) at hour 4 of
  // a 5-hour crawl loses nothing. Appends are serialised through a promise chain
  // (concurrent workers must not interleave lines) and flushed before the final
  // save. Zero writes when saving is off — the library contract is unchanged.
  const journal = {
    id: null, // set once initRun has created the run folder; null = journaling off
    createdAt: null,
    queue: Promise.resolve(),
    warned: false,
    append(scanId, record) {
      if (!this.id) return;
      this.queue = this.queue
        .then(() => appendJournal(this.id, scanId, record, opts))
        .catch((err) => {
          if (!this.warned) {
            this.warned = true;
            emit({
              type: 'warn',
              reason: 'journal',
              message:
                'Failed to journal a page to disk (' + (err && err.message) + '). The crawl ' +
                'continues in memory, but a crash before the final save would lose pages.',
            });
          }
        });
    },
  };

  const list = normalizeTargets(targets, opts.task);
  const stream = createEventStream();
  const startTime = Date.now();

  // Each submitted link is an independent SCAN: its own pages, its own dedup,
  // its own output files. A run is just the container recording which scans were
  // crawled together (the user can later open one link or the whole run).
  const emptyCounts = () => ({ 'docs:llms-full': 0, 'docs:sitemap': 0, agent: 0 });
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
    stats: { pages: 0, durationMs: 0, strategyCounts: emptyCounts(), tokens: emptyTokens(), deduped: { exact: 0, mirror: 0, near: 0 } },
    warnings: [],
    _hashes: new Set(), // de-dupe pages with identical content, PER scan
    _siblings: new Map(), // siblingKey → [{sh, url}] of KEPT pages, for the mirror tier
    _startedAt: 0,
  }));

  // Resume (#13): replay each scan's journal BEFORE crawling. Restored pages go
  // straight into the scan (they are part of the final output) and their hashes
  // into the dedup set; their URLs become pre-visited so they are never re-rendered;
  // their recorded LINKS re-seed the frontier — without them, pages reachable only
  // through an already-kept page could never be rediscovered.
  if (resume && resume.journals) {
    for (const scan of scans) {
      const records = resume.journals[scan.scanId];
      if (!Array.isArray(records) || !records.length) continue;
      const visited = new Set();
      const seeds = new Set();
      for (const rec of records) {
        const page = rec && rec.page;
        for (const l of (rec && rec.links) || []) seeds.add(l);
        if (!page || !page.url || typeof page.markdown !== 'string') continue;
        const sig = pageSignature(page.markdown);
        const hash = createHash('sha1').update(sig).digest('hex');
        visited.add(normalizeUrl(page.url) || page.url);
        if (scan._hashes.has(hash)) continue; // defensive: a journal shouldn't hold dupes
        scan._hashes.add(hash);
        // Rebuild the same dedup indexes addPage maintains, so the resumed crawl
        // recognises mirrors/near-dups of RESTORED pages too.
        if (opts.nearDupHamming > 0 || opts.mirrorHamming > 0) {
          const sh = simhash(sig);
          if (opts.nearDupHamming > 0) {
            if (!scan._simhashes) scan._simhashes = [];
            scan._simhashes.push(sh);
          }
          if (opts.mirrorHamming > 0) {
            const key = siblingKey(page.url);
            const kin = scan._siblings.get(key) || [];
            kin.push({ sh, url: page.url });
            scan._siblings.set(key, kin);
          }
        }
        scan.pages.push(page);
        const s = (page.meta && page.meta.strategy) || 'agent';
        scan.stats.strategyCounts[s] = (scan.stats.strategyCounts[s] || 0) + 1;
      }
      scan._resume = { visited, seeds: [...seeds], restored: scan.pages.length };
    }
  }

  const result = {
    scans,
    stats: { pages: 0, durationMs: 0, strategyCounts: emptyCounts(), tokens: emptyTokens(), deduped: { exact: 0, mirror: 0, near: 0 } },
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
    // `extra.links` (optional) = the page's discovered links, journaled with it so
    // resume can re-seed the frontier without re-rendering already-kept pages.
    // Returns TRUE when the page was kept, FALSE when it was dropped (duplicate,
    // page cap) — the crawl loop uses this to stop expanding links from duplicates.
    addPage(page, extra = {}) {
      const scan = ctx.currentScan;
      if (!scan) return false;
      if (opts.maxPages > 0 && scan.pages.length >= opts.maxPages) return false;
      // Skip pages whose content duplicates one already captured in THIS scan
      // (the same page reached via throwaway query params like ?version=). The
      // signature ignores link/URL targets so near-identical pages collapse too.
      const md = page.markdown || '';
      const sig = pageSignature(md);
      const hash = createHash('sha1').update(sig).digest('hex');
      if (scan._hashes.has(hash)) {
        scan.stats.deduped.exact += 1;
        emit({ type: 'dedup', url: page.url, kind: 'exact' });
        return false;
      }
      scan._hashes.add(hash);
      const sh = opts.mirrorHamming > 0 || opts.nearDupHamming > 0 ? simhash(sig) : null;
      // MIRROR/VARIANT collapse (mirrorHamming > 0, DEFAULT ON): drop the page only when
      // its URL is a SIBLING of a kept page's (same locale-stripped path — a mirror host,
      // a UI-state query variant, a locale twin) AND its content SimHash is within the
      // threshold. URL shape alone or content closeness alone never drops anything: the
      // AND is what keeps sibling-shaped pages with real differences (?version=A vs B)
      // and near-identical TEMPLATES at different paths (two tiny API pages) safe.
      if (opts.mirrorHamming > 0) {
        const kin = scan._siblings.get(siblingKey(page.url));
        if (kin) {
          for (const prev of kin) {
            if (prev.url !== page.url && hamming(sh, prev.sh) <= opts.mirrorHamming) {
              scan.stats.deduped.mirror += 1;
              emit({ type: 'dedup', url: page.url, kind: 'mirror', of: prev.url });
              return false;
            }
          }
        }
      }
      // OPT-IN cross-path near-duplicate collapse (nearDupHamming > 0): drop a page whose
      // SimHash is within the Hamming threshold of ANY kept page, regardless of URL.
      // Default 0 = off — content similarity alone can't tell a duplicate from a sibling
      // (templated API pages measure ≤3 apart), so this aggressive tier stays a user choice.
      if (opts.nearDupHamming > 0) {
        if (!scan._simhashes) scan._simhashes = [];
        for (const prev of scan._simhashes) {
          if (hamming(sh, prev) <= opts.nearDupHamming) {
            scan.stats.deduped.near += 1;
            emit({ type: 'dedup', url: page.url, kind: 'near' });
            return false;
          }
        }
        scan._simhashes.push(sh);
      }
      if (sh && opts.mirrorHamming > 0) {
        const key = siblingKey(page.url);
        const kin = scan._siblings.get(key) || [];
        kin.push({ sh, url: page.url });
        scan._siblings.set(key, kin);
      }
      scan.pages.push(page);
      const s = (page.meta && page.meta.strategy) || 'agent';
      scan.stats.strategyCounts[s] = (scan.stats.strategyCounts[s] || 0) + 1;
      // Incremental persistence (#13): the kept page hits the disk NOW, verbatim,
      // append-only — a crash from here on cannot lose it. No-op when saving is off.
      journal.append(scan.scanId, { page, links: extra.links || [] });
      // Note: progress is driven by markProcessed (work done), not by kept pages.
      emit({
        type: 'extracted',
        url: page.url,
        title: page.title,
        bytes: (page.meta && page.meta.bytes) || Buffer.byteLength(md, 'utf8'),
        preview: md.slice(0, 600),
      });
      return true;
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
    // Hold the shared browser for this run's lifetime; the matching release in the
    // finally below closes it only when NO other run is still using it (the UI can
    // start a new crawl while the previous one is winding down).
    retainBrowser();
    try {
      // Create the run folder UP FRONT (#13) so the incremental journal has a home
      // and a kill -9 leaves a listed, resumable run (status 'running') instead of
      // nothing. On resume this re-opens the existing folder, preserving createdAt.
      if (willSave) {
        try {
          const init = await initRun({ id: resume ? resume.id : null, targets: list, options: opts });
          journal.id = init.id;
          journal.createdAt = init.createdAt;
        } catch (err) {
          emit({
            type: 'warn',
            reason: 'cache',
            message: 'Failed to create the run folder: ' + (err && err.message) + '. Crawling in memory only.',
          });
        }
      }

      // Health-check the model ONCE before crawling. The judgment calls all
      // `.catch()` and bias toward keep/follow/reveal, so a misconfigured model
      // would silently degrade the whole crawl to heuristics (no AI reveal/scope/
      // link-gating) and the caller would get poor output with no clue why. Warn
      // loudly instead — the crawl still runs (heuristics keep it from losing
      // content), but the reason is now visible.
      if (llmDisabled(opts.llm)) {
        // Deliberate no-AI mode: same heuristics, but CHOSEN — say what that means
        // once (this is the run's one no-AI notice) and skip the health ping.
        emit({
          type: 'warn',
          reason: 'no-ai',
          message:
            'AI is off for this run (no-AI mode): heuristic reveal, pages kept whole, ' +
            'every in-scope link followed. Zero tokens — but the output is not ' +
            'task-filtered; use include/exclude, minRelevance or maxPages to contain the crawl.',
        });
      } else {
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
      }

      for (const scan of scans) {
        if (stopped) break;
        ctx.beginScan(scan);
        emit({ type: 'site', url: scan.url, task: scan.task, title: scan.title });
        if (scan._resume && scan._resume.restored) {
          emit({ type: 'resume', url: scan.url, restored: scan._resume.restored });
        }
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
        for (const [k, v] of Object.entries(s.stats.deduped)) {
          result.stats.deduped[k] = (result.stats.deduped[k] || 0) + v;
        }
      }

      // Persistence is opt-in. When the caller didn't ask to save (the library
      // default), write nothing: result.scans[].files[].markdown is already in
      // memory for them to put wherever they like. When they did opt in, save one
      // folder per run (one subfolder per scan) under the cache root (cwd default).
      if (willSave) {
        try {
          // Flush the journal before finalising: every append must be on disk
          // before the manifest claims the run is complete (and before a 'done'
          // save deletes the journal).
          await journal.queue.catch(() => {});
          const saved = await saveRun({
            targets: list,
            options: opts,
            scans,
            durationMs: result.stats.durationMs,
            warnings: result.warnings,
            tokens: result.stats.tokens,
            id: journal.id,
            createdAt: journal.createdAt,
            // A voluntary Stop leaves the run resumable ('stopped', journal kept);
            // a drained frontier is 'done' (journal superseded by the final files).
            status: stopped ? 'stopped' : 'done',
          });
          result.run = { id: saved.id, dir: saved.dir, scans: saved.summary.scans };
          emit({ type: 'saved', runId: saved.id, dir: saved.dir, scans: saved.summary.scans });
        } catch (err) {
          emit({ type: 'warn', reason: 'cache', message: 'Failed to save run: ' + (err && err.message) });
        }
      }

      await releaseBrowser(); // closes the shared browser only when no run still holds it
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

  // Resume (#13): pages restored from the journal are pre-visited (never re-rendered)
  // and their recorded links re-seed the frontier below, so the crawl picks up exactly
  // where it left off — anything not yet kept is reached again through those links.
  const pre = (ctx.currentScan && ctx.currentScan._resume) || null;
  const visited = new Set(pre ? pre.visited : undefined);
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
  if (pre) for (const s of pre.seeds) enqueue(s);
  // Base the bar on the ACTUAL frontier, not on any earlier setTotal() estimate
  // (e.g. a sitemap's raw count) that may include URLs filtered out at enqueue —
  // an unreachable floor is what left the bar stuck below 100%.
  ctx.progress.total = ctx.progress.done + queue.length;
  ctx.emit({ type: 'progress', done: ctx.progress.done, total: ctx.progress.total });

  // Restored pages count as production, so a fully-crawled resumed scan doesn't
  // trigger the root-bootstrap fallback for no reason.
  let produced = pre ? pre.restored : 0;
  let bootstrapped = false;
  let active = 0; // pages currently being crawled
  const retried = new Set(); // URLs already given their one transient-failure retry

  // Each page's reveal loop is self-contained, so pages can be crawled in
  // parallel (each in its own browser context) — far faster on large docs sets.
  const concurrency = Math.max(1, Number(ctx.options.concurrency) || 1);

  async function processOne(url) {
    if (!discoveryOnly.has(url)) ctx.emit({ type: 'page', url, status: 0 });
    let outcome;
    try {
      outcome = await crawlPageWithEngine({ url, task: target.task }, ctx);
    } catch (err) {
      outcome = { page: null, links: [], failed: true, error: err };
    }
    // A transient load failure (navigation timeout, connection reset) yields neither
    // content nor links. Losing the page silently breaks "never miss content", so
    // give each URL exactly one retry before declaring it failed.
    if (outcome.failed) {
      if (!retried.has(url) && !ctx.shouldStop()) {
        retried.add(url);
        visited.delete(url);
        queued.delete(url);
        enqueue(url);
        ctx.emit({ type: 'warn', url, reason: 'retry', message: 'Page failed to load; retrying once.' });
      } else {
        ctx.emit({
          type: 'error',
          url,
          message: 'page failed: ' + ((outcome.error && outcome.error.message) || 'did not load (after retry)'),
        });
      }
      return;
    }
    let expand = true;
    if (outcome.page && !discoveryOnly.has(url)) {
      // The page's links travel with it into the journal (#13): resume re-seeds
      // the frontier from them instead of re-rendering the page to rediscover them.
      const kept = ctx.addPage(outcome.page, { links: outcome.links || [] });
      produced++;
      // A dropped duplicate's links replicate a page that was already expanded —
      // following them re-crawls the whole mirror/variant cascade (measured live:
      // 57% of a run). Discovery-only pages still always expand (that's their job).
      if (!kept) expand = false;
    }
    if (expand) for (const link of outcome.links || []) enqueue(link);
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

/**
 * Resume an interrupted run (#13): status 'running' after a crash/kill, or
 * 'stopped' after a voluntary Stop. Replays the run's incremental journal —
 * already-extracted pages are restored verbatim (never re-rendered), their
 * recorded links re-seed the frontier, and the crawl completes into the SAME
 * run folder. Returns the same async-iterable Run object as {@link crawlDocs}.
 *
 * `overrides` are merged over the run's saved options (model, provider,
 * concurrency, …). An `apiKey` is never persisted, so for `provider: 'openai'`
 * pass it again here or via SAGECRAWL_API_KEY / OPENAI_API_KEY.
 *
 * @param {string} runId
 * @param {Partial<typeof DEFAULT_OPTIONS>} [overrides]
 * @returns {Promise<ReturnType<typeof crawlDocs>>}
 */
export async function resumeCrawl(runId, overrides = {}) {
  const state = await loadRunForResume(runId, overrides);
  if (state.status === 'done') {
    throw new Error(`run ${runId} is already complete — nothing to resume`);
  }
  if (!state.targets.length) {
    throw new Error(`run ${runId} has no recorded targets (saved before resume support?) — cannot resume`);
  }
  const saved = { ...state.options };
  // Runtime/derived values must be recomputed, never replayed from disk.
  delete saved.llm;
  delete saved.onEvent;
  delete saved.__resume;
  return crawlDocs(state.targets, {
    ...saved,
    ...overrides,
    save: true,
    // Pin the cache to where the run was actually found, so the completed run
    // lands in the same folder even if the caller's cwd changed.
    cacheDir: cacheRoot(overrides),
    __resume: { id: state.id, journals: state.journals },
  });
}

export default crawlDocs;
