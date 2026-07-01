// Type definitions for sagecrawl — the public API of `src/index.mjs`.
// Hand-written (the source is plain ESM JavaScript). Kept in sync with
// DEFAULT_OPTIONS and the `crawlDocs` result shape documented in README.md.

export type Provider = 'ollama' | 'openai';
export type BrowserMode = 'never' | 'auto' | 'always';

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
  /** API base URL for `provider: "openai"` (e.g. `https://api.openai.com/v1`). */
  baseUrl?: string;
  /** API key for `provider: "openai"`. Falls back to `SAGECRAWL_API_KEY` / `OPENAI_API_KEY`. */
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
  /** Where to save when saving is on. Default `<cwd>/.sagecrawl/runs`. */
  cacheDir?: string;
  /**
   * Also package one identifiable Markdown document per page (with metadata + a stable
   * id), plus an `index.md` and a `documents.jsonl`, alongside the consolidated `.md`.
   * Off by default. Pure repackaging — content stays verbatim. See {@link Scan.documents}.
   */
  perDocument?: boolean;
  /**
   * Collapse near-duplicate pages whose 64-bit SimHash is within this Hamming distance of
   * an already-kept page (template-only differences). `0` (default) = off: only EXACT
   * duplicates are dropped. **Opt-in** because collapsing "almost identical" pages can drop
   * one whose unique content is small — against "never lose content". `3` ≈ Manku/Google.
   */
  nearDupHamming?: number;
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
}

export interface Page {
  url: string;
  task: string;
  title: string;
  markdown: string;
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
 *  (`"reveal"`, `"scope"`, `"links"`, `"nav-plan"`, `"health"`, …) so cost can be
 *  attributed to the judgment that spent it. */
export interface TokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byKind: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
}

export interface Stats {
  pages: number;
  durationMs: number;
  strategyCounts: Record<string, number>;
  /** AI token usage for the run/scan; input and output are billed differently. */
  tokens: TokenUsage;
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
    | 'browser'
    | 'concurrency'
    | 'maxPages'
    | 'maxActions'
    | 'minRelevance'
    | 'nearDupHamming'
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
 * to disk unless `save: true` or a `cacheDir` is given.
 */
export declare function crawlDocs(targets: Targets, options?: CrawlOptions): Run;

export default crawlDocs;
