// Type definitions for crawldna — the public API of `src/index.mjs`.
// Hand-written (the source is plain ESM JavaScript). Kept in sync with
// DEFAULT_OPTIONS and the `crawlDocs` result shape documented in README.md.

export type Provider = 'ollama' | 'openai';
export type BrowserMode = 'never' | 'auto' | 'always';
/**
 * What to extract — an explicit switch, never inferred from the task wording.
 * `"complete"` (default): everything reachable (completeness shortcuts tried first,
 * pages kept whole, zero AI link-gate/scoping calls). `"targeted"`: only what the
 * task asks (AI link gate + section scoping — requires AI, incompatible with `noAi`).
 * `"auto"`: legacy behaviour — a multilingual regex on the task picks the docs path;
 * never the default (#23), kept only for saved runs and callers that name it.
 */
export type CrawlMode = 'auto' | 'complete' | 'targeted';

/** One unit of work: a URL plus the natural-language task describing what to extract. */
export interface Target {
  url: string;
  /** What to extract. Falls back to `options.task` when omitted. */
  task?: string;
}

/** Accepted shapes for the first argument of {@link crawlDocs}. */
export type Targets = string | string[] | Target | Target[];

export interface CrawlOptions {
  /** Shared/default task when a target doesn't carry its own. */
  task?: string;
  /**
   * Model id. REQUIRED — there is no default. For Ollama use a local model id
   * (e.g. `"qwen3-coder:30b"`); for an OpenAI-compatible API use that API's id
   * (e.g. `"gpt-4o-mini"`).
   */
  model?: string;
  /** `"ollama"` (local, default) or `"openai"` (any OpenAI-compatible API). */
  provider?: Provider;
  /**
   * Optional embedding model id (#22), from the same provider as `model` (e.g.
   * `"nomic-embed-text"` on Ollama, `"text-embedding-3-small"` on OpenAI). Makes
   * task→link relevance SEMANTIC — multilingual and synonym-aware — feeding the
   * best-first frontier ordering, the route budget, the opt-in `minRelevance`
   * pruning and the reshape context retrieval. Embeddings only ORDER; they never
   * drop links by themselves. Unset (default) = the lexical scorer; unreachable
   * backend = one loud warning, then the lexical floor. Ignored with `noAi`
   * (zero calls to ANY model, embeddings included).
   */
  embedModel?: string;
  /**
   * Crawl with ZERO model calls (no model needed): reveal runs on DOM heuristics,
   * pages are kept whole, every in-scope link is followed. Zero tokens; the output
   * is not task-filtered and big sites can take longer — contain with `maxPages` /
   * `include` / `exclude`. #23 — the task speaks only to the AI, so here it has NO
   * role: an explicit `task` (or `minRelevance`, which reads it) is refused loudly,
   * and output files are named from the site. Incompatible with `mode: "targeted"`
   * (task-filtering IS the model's job) — that combination is refused loudly.
   * Default `false`.
   */
  noAi?: boolean;
  /** What to extract (see {@link CrawlMode}). Default `"complete"`. */
  mode?: CrawlMode;
  /** API base URL for `provider: "openai"` (e.g. `https://api.openai.com/v1`). */
  baseUrl?: string;
  /** API key for `provider: "openai"`. Falls back to `CRAWLDNA_API_KEY` / `OPENAI_API_KEY`. */
  apiKey?: string;
  /** Override the Ollama server URL (default `http://127.0.0.1:11434`). */
  ollamaHost?: string;
  /** Whether to render pages in a real browser. Lazy-loads Playwright. Default `"auto"`. */
  browser?: BrowserMode;
  /** Parallel page renders. Default `4`. */
  concurrency?: number;
  /** Per-scan page cap; `0` = unlimited. Default `0`. */
  maxPages?: number;
  /** Per-page reveal action budget. Default `40`. */
  maxActions?: number;
  /** Only crawl URLs matching this pattern. */
  include?: string | RegExp;
  /** Skip URLs matching this pattern. */
  exclude?: string | RegExp;
  /**
   * Politeness, opt-in (#14): minimum milliseconds between requests to the SAME
   * host (concurrent workers queue behind each other per host, never across
   * hosts). `0` (default) = off.
   */
  delay?: number;
  /**
   * Politeness, opt-in (#14): read each origin's robots.txt — disallowed URLs
   * are SKIPPED with a `robots` warning (never silently) and `Crawl-delay` is
   * honoured (the larger of it and `delay` wins). Default `false`: the tool is
   * user-directed, like wget. Note the anti-bot CHALLENGE guard is separate and
   * always on: a bot-defense interstitial is never kept as content (one retry
   * with backoff, then a declared skip with an `anti-bot` warning).
   */
  respectRobots?: boolean;
  /**
   * Cap on the speculative JS-mined route candidates (paths dug out of script/JSON
   * blobs, up to 800 per page) sent to the AI link gate, top-ranked by task
   * relevance. `0` = unlimited. Default `200`. Conservative: only cuts when the
   * relevance scores discriminate among the routes — a generic task cuts nothing —
   * and real DOM links are never capped.
   */
  maxRoutes?: number;
  /**
   * Focused mode (opt-in): prune links whose task-relevance score (`0..1`) falls below
   * this threshold BEFORE the AI link gate. `0` (default) = off — relevance then only
   * orders links best-first and never drops any. Trades some recall for speed/scope,
   * and only applies when the task actually discriminates among a page's links.
   */
  minRelevance?: number;
  /**
   * Persist the run to the cache. Library default `false` — the result is returned
   * in memory only. The CLI and Web UI set this to `true`. Passing `cacheDir` also
   * turns saving on.
   */
  save?: boolean;
  /** Where to save when saving is on. Default `<cwd>/.crawldna/runs`. */
  cacheDir?: string;
  /**
   * Also package one identifiable Markdown document per page (with metadata + a stable
   * id), plus an `index.md` and a `documents.jsonl`, alongside the consolidated `.md`.
   * Off by default. Pure repackaging — content stays verbatim. See {@link Scan.documents}.
   */
  perDocument?: boolean;
  /**
   * Collapse near-duplicate pages ACROSS different paths whose 64-bit SimHash is within
   * this Hamming distance of ANY already-kept page. `0` (default) = off. **Opt-in**
   * because content similarity alone cannot tell a duplicate from a sibling — measured
   * on a real run, genuinely distinct templated API pages sat at distance ≤3 — so this
   * aggressive tier can drop real content and stays a deliberate user choice.
   */
  nearDupHamming?: number;
  /**
   * Collapse mirror/variant re-servings of a kept page (default `8`, on). A page is
   * dropped only when BOTH signals agree: its URL is a SIBLING of a kept page's (same
   * path once a leading locale segment is stripped — mirror hosts like dev./v2., UI-state
   * query variants like `?panel=settings`, locale twins `/en/x` vs `/x`) AND its content
   * SimHash is within this Hamming distance. Sibling-shaped pages with real content
   * differences (`?version=A` vs `?version=B`) measure far apart and are kept. Links found
   * on a dropped duplicate are not followed, so mirror cascades stop at the first page.
   * `0` = off.
   */
  mirrorHamming?: number;
  /** Called for every event, in addition to the async iterator. */
  onEvent?: (event: CrawlEvent) => void;
}

export type EventType =
  | 'site'
  | 'strategy'
  | 'discover'
  | 'page'
  | 'action'
  | 'extracted'
  | 'dedup'
  | 'resume'
  | 'progress'
  | 'warn'
  | 'error'
  | 'saved'
  | 'done';

/**
 * A streamed progress event. `type` is one of {@link EventType}; the remaining
 * fields depend on the type (e.g. `extracted` carries `url`/`title`/`bytes`,
 * `progress` carries `done`/`total`, `warn` carries `reason`/`message`). Every
 * event is also stamped with the active `scanId`/`scanIndex`.
 */
export interface CrawlEvent {
  type: EventType;
  scanId?: string;
  scanIndex?: number;
  [key: string]: unknown;
}

export interface PageMeta {
  strategy: string;
  framework?: string;
  fetchedAt?: string;
  bytes?: number;
  /**
   * The reveal exit audit (#21): characters of text still hidden in the page's main
   * content when the reveal loop ended. `0` = the page was measurably drained.
   * Present on browser-engine pages (`strategy: "agent"`); absent on static paths.
   */
  revealResidualChars?: number;
}

/** One captured reveal state, whole and verbatim — the faithful per-state record.
 *  The consolidated `markdown` is compact (shared frame once); this keeps each
 *  state's full co-occurrence recoverable (e.g. a tab/view swap, a partial change). */
export interface RevealState {
  /** The state's variant marker (e.g. a tab/view label), or null for the base state. */
  label: string | null;
  /** How the state was surfaced: `"baseline"`/`"tab:…"`/`"expander:…"`/`"dropdown:…"`/`"loadmore"`. */
  provenance: string;
  /** The revealing control's vertical position (#27), used to order states. */
  order: number;
  /** The whole state's Markdown, verbatim. */
  markdown: string;
}

export interface Page {
  url: string;
  task: string;
  title: string;
  markdown: string;
  /** The faithful per-state reveal record — present only when a page's reveal
   *  captured MORE THAN ONE state (else the single state IS `markdown`). Also
   *  written to disk under `states/<page>.md` when the run is saved. */
  states?: RevealState[];
  meta: PageMeta;
}

/** One consolidated, verbatim Markdown file produced for a scan. */
export interface OutputFile {
  filename: string;
  title: string;
  /** The file's full Markdown — available in memory even when nothing is saved. */
  markdown: string;
  bytes: number;
  /** Source page URLs that contributed to this file. */
  pages: string[];
}

/** AI token usage counters. `byKind` splits the same totals by call type
 *  (`"reveal"`, `"scope"`, `"links"`, `"nav-plan"`, `"embed"`, `"health"`, …) so cost
 *  can be attributed to the judgment that spent it. `cachedInputTokens` is the slice of
 *  `inputTokens` a remote provider served from its prompt cache (~10× cheaper);
 *  `0` for providers that don't report it (e.g. local Ollama). */
export interface TokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  byKind: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  >;
}

export interface Stats {
  pages: number;
  durationMs: number;
  strategyCounts: Record<string, number>;
  /** AI token usage for the run/scan; input and output are billed differently. */
  tokens: TokenUsage;
  /** Pages dropped as duplicates, by tier: `exact` (sha1), `mirror` (URL-sibling +
   *  SimHash, default on), `near` (cross-path SimHash, opt-in). */
  deduped?: { exact: number; mirror: number; near: number };
  /** Reveal exit audit (#21): how many kept pages ended with text still hidden, and the
   *  total hidden characters. `{ pages: 0, chars: 0 }` = every page measurably drained. */
  revealResidual?: { pages: number; chars: number };
}

export interface Warning {
  url?: string;
  reason?: string;
  message: string;
}

/** One page packaged as an identifiable document (opt-in `perDocument`). The body is
 *  the page's verbatim Markdown; `id` is stable (derived from the URL). */
export interface Document {
  id: string;
  url: string;
  title: string;
  fetchedAt: string;
  bytes: number;
  /** The verbatim page Markdown (no header). */
  markdown: string;
  /** An H1–H3 outline of the page, for section paths / chunking. */
  headings: Array<{ level: number; text: string }>;
  /** The per-document filename written under `documents/` when the run is saved. */
  file: string;
}

/** One submitted link's crawl: its own pages, output files, dedup and stats. */
export interface Scan {
  scanId: string;
  index: number;
  url: string;
  task: string;
  title: string;
  pages: Page[];
  files: OutputFile[];
  /** Per-page documents, populated only when `perDocument` is enabled; else empty. */
  documents: Document[];
  stats: Stats;
  warnings: Warning[];
}

/** Present on the result only when the run was saved (otherwise `run` is `null`). */
export interface SavedRun {
  id: string;
  dir: string;
  scans: unknown[];
}

export interface Result {
  scans: Scan[];
  stats: Stats;
  warnings: Warning[];
  /** Where the run was saved, or `null` when saving was off (the library default). */
  run: SavedRun | null;
}

/**
 * A running crawl. Async-iterate it for live {@link CrawlEvent}s, await
 * {@link Run.result} for the final {@link Result}, or call {@link Run.stop} to
 * end early (the result still resolves with whatever was gathered).
 */
export interface Run extends AsyncIterable<CrawlEvent> {
  result: Promise<Result>;
  stop(): void;
}

/** The default option values; spread under any options you pass to {@link crawlDocs}. */
export declare const DEFAULT_OPTIONS: Required<
  Pick<
    CrawlOptions,
    | 'task'
    | 'model'
    | 'provider'
    | 'noAi'
    | 'mode'
    | 'browser'
    | 'delay'
    | 'respectRobots'
    | 'concurrency'
    | 'maxPages'
    | 'maxActions'
    | 'maxRoutes'
    | 'minRelevance'
    | 'nearDupHamming'
    | 'mirrorHamming'
    | 'save'
    | 'perDocument'
  >
> &
  CrawlOptions;

/** Normalise the various accepted `targets` shapes into `{ url, task }[]`. */
export declare function normalizeTargets(targets: Targets, defaultTask?: string): Target[];

/**
 * Crawl one or more links, each with a natural-language task, and return a
 * {@link Run}. The crawl renders pages in a real browser, reveals interaction-
 * hidden content, and extracts task-relevant Markdown verbatim. Nothing is written
 * to disk unless `save: true` or a `cacheDir` is given. When saving is on, every
 * kept page is also journaled to disk as it is captured, so an interrupted run
 * can be completed later with {@link resumeCrawl}.
 */
export declare function crawlDocs(targets: Targets, options?: CrawlOptions): Run;

/**
 * Resume an interrupted saved run: pages already extracted are restored verbatim
 * from the run's incremental journal (never re-rendered), their recorded links
 * re-seed the frontier, and the crawl completes into the same run folder.
 * `overrides` are merged over the run's saved options. An API key is never
 * persisted — for `provider: "openai"` pass `apiKey` again (or set the env var).
 * Rejects if the run is already complete.
 */
export declare function resumeCrawl(runId: string, overrides?: CrawlOptions): Promise<Run>;

export default crawlDocs;
