# sagecrawl

A **general, task-driven web crawler**. Give it one or more links, each with a
natural-language **task** describing what to extract. It crawls each site to
fulfil its task and outputs clean **Markdown**.

Its defining capability: on each page it can **take actions to reveal content
that only appears after interaction** — clicking tabs, expanding accordions,
pressing "load more", scrolling for lazy content — i.e. content a plain fetch
never sees. After revealing everything, it extracts what's relevant to the task
and follows the other useful links it finds, like a crawler.

What it extracts stays **verbatim** — exactly what your task asked for, one clean
`.md` per link. Turning that into tables, splits or filtered subsets is a separate,
optional step — **reshape** — a chat over the saved files you can reuse any number
of times. **Crawl once, reshape many times.**

It runs three ways from a single headless core:

1. **CLI** — point it at link(s) + task(s), get Markdown.
2. **Importable library** — another Node project imports it and consumes results.
3. **Web UI** *(optional)* — a control panel to set links/tasks, run, and watch
   live. It's a thin frontend over the same core and ships **only with the source
   repository**, never the npm package — so a `sagecrawl` dependency stays lean and
   the CLI/library work with zero UI weight.

> 📐 **How it works:** see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full
> pipeline — the AI-driven reveal engine, the two-phase (crawl → reshape) model,
> and output layout.

## Install

Standalone:

```sh
git clone <repo> sagecrawl
cd sagecrawl
npm install
node bin/cli.mjs https://docusaurus.io/docs --task "Extract all documentation"
```

As a library:

```sh
npm install sagecrawl
```

The npm package is just the crawler core + CLI — the Web UI is **not** included, so
it adds no dead weight to your dependency. If you want the UI, use the repo install
above and run `npm run serve` (see [Web UI](#web-ui)).

### Requirements

- **Node.js ≥ 20** (uses built-in `fetch`, `node:util.parseArgs`, web streams).
- **A language model** — the engine needs one for its AI judgment (reveal / scope /
  link-gating / reshape). **There is no default — you must choose one.** Two ways,
  pick either:
  - **[Ollama](https://ollama.com)** running locally — pull a capable model and pass
    it: `ollama pull qwen3-coder:30b`, then `--model qwen3-coder:30b`.
  - **Any OpenAI-compatible API** (OpenAI, OpenRouter, Groq, Together, …):
    `--provider openai --base-url <…/v1> --model <id> --api-key <key>` (the key can
    also come from `SAGECRAWL_API_KEY` / `OPENAI_API_KEY`).

  If the model isn't reachable the crawl still runs but **warns** that it has dropped
  to degraded heuristic mode (no AI reveal/scope/link-gating) — so you never get poor
  output without knowing why.
- **[Playwright](https://playwright.dev) Chromium** — needed for crawls that take
  actions / reveal hidden content (the engine). Pure structured or static extraction
  (e.g. a docs site exposing `llms-full.txt` or a sitemap) runs **without** it.
  Install the browser once:

  ```sh
  npx playwright install chromium
  ```

`playwright` is an `optionalDependency` and is lazy-loaded only when a crawl
actually needs the browser.

## CLI

```sh
sagecrawl <url> [--task "..."]                       # crawl one site (Phase 1)
sagecrawl crawl <url> [--task "..."] [--model qwen3-coder:30b]
                    [--browser auto|never|always] [--concurrency 4]
                    [--include "..."] [--exclude "..."] [--max-pages 0]
                    [--cache-dir <dir>]
sagecrawl reshape <runId> --ask "..."                # reshape a saved extraction (Phase 2)
sagecrawl runs [list|rm <id…>|clear|path]            # manage cached runs
sagecrawl serve [--port 4000]                        # start the Web UI
sagecrawl --help
```

**The CLI saves every run automatically** to the runs cache (`<cwd>/.sagecrawl/runs` —
rooted at the directory you run from, overridable with `--cache-dir` or the
`SAGECRAWL_CACHE_DIR` env var) — there is no `--out` flag. Each run is one folder: the
grouped Markdown file(s), a `manifest.json`, and a small `run.json` summary.
*(As a **library**, saving is opt-in — see [Library API](#library-api).)*

**Per-link tasks** — either repeated pairs:

```sh
sagecrawl --url https://a.dev --task "Get pricing" --url https://b.dev --task "Get API docs"
```

…or a JSON file (`--targets targets.json`) whose contents are a `targets` array:

```json
[
  { "url": "https://a.dev/docs", "task": "Extract all documentation" },
  { "url": "https://b.dev",      "task": "List every product and its price" }
]
```

### Managing cached runs

```sh
sagecrawl runs                 # list saved runs (id, date, task, files)
sagecrawl runs rm <id> [<id>…] # delete specific run(s)
sagecrawl runs clear           # delete every cached run
sagecrawl runs path            # print the cache directory
```

## Web UI

> **Optional, and from the repo only.** The Web UI ships with the source repository,
> not the npm package. Run it from a repo clone (`git clone … && npm install`):
>
> ```sh
> npm run serve            # or: node bin/cli.mjs serve --port 4000
> # open http://localhost:4000
> ```
>
> If you run `sagecrawl serve` from a bare `npm install` (no UI present), it won't
> crash — it prints how to get the UI and points you at the CLI/library, which do
> everything without it.

The UI has two steps:

1. **Setup + history.** Add multiple links (each with its own task, or one
   shared task) and set options, then **Start**. Below the form is a list of
   **previous runs** (with the cache path shown) — click one to open it, or
   delete runs (per-run ✕, or "Delete all").
2. **Run / view.** For a live crawl: watch where it's looking, the extractions
   **with their content rendered as you go**, and the actions the engine takes;
   the progress bar reaches 100% when the frontier drains. When it finishes, the
   produced files appear **as tabs** (one per file), shown as **formatted
   Markdown** (headings, lists, tables, links, images), with the run's save path.
   For a past run: browse its saved files the same way. **← runs** returns to
   step 1.

## Library API

The single most important contract (refdna depends on it):

```js
import { crawlDocs } from 'sagecrawl';

const run = crawlDocs(targets, options);

// (a) consume live events
for await (const ev of run) {
  // ev = { type, ...payload }
}

// (b) or get the final result
const result = await run.result;

// (c) control (used by the UI / long jobs)
run.stop(); // graceful; result still resolves with what was gathered
```

`run` is **async-iterable** and exposes `run.result` (`Promise<Result>`) and
`run.stop()`.

### Targets

```
string                                 // one URL, uses options.task
string[]                               // many URLs, all use options.task
{ url, task? }                         // one target with its own task
Array<{ url, task? }>                  // many targets, each with its own task
```

### Options

| option | default | meaning |
|---|---|---|
| `task` | `"Extract the complete documentation."` | shared/default task |
| `model` | — (**required**) | model id — Ollama (e.g. `"qwen3-coder:30b"`) or OpenAI-compatible (e.g. `"gpt-4o-mini"`) |
| `provider` | `"ollama"` | `"ollama"` (local) \| `"openai"` (any OpenAI-compatible API) |
| `baseUrl` | — | API base URL for `provider: "openai"` |
| `apiKey` | — | API key for `provider: "openai"` (falls back to `SAGECRAWL_API_KEY` / `OPENAI_API_KEY`) |
| `ollamaHost` | `127.0.0.1:11434` | override the Ollama server |
| `browser` | `"auto"` | `never` \| `auto` \| `always` (lazy-loads Playwright) |
| `concurrency` | `4` | parallel page fetches |
| `maxPages` | `0` | safety cap (0 = unlimited) |
| `maxActions` | `40` | per-page reveal action cap (a ceiling — simple pages stop early) |
| `include` | — | only crawl URLs matching (string regex or `RegExp`) |
| `exclude` | — | skip URLs matching |
| `save` | `false` | persist the run to the cache. **Library default: off** (result returned in memory). The CLI/UI turn it on |
| `cacheDir` | — | where to save when saving is on (default `<cwd>/.sagecrawl/runs`); setting it also turns saving on |
| `perDocument` | `false` | also package one identifiable `.md` per page (+ `index.md` + `documents.jsonl`) for programmatic use, alongside the consolidated `.md`. Verbatim — see [Output](#output) |
| `nearDupHamming` | `0` | collapse near-duplicate pages within this SimHash Hamming distance (`0` = off, exact dupes only). **Opt-in** — can drop a page whose unique content is small; `3` ≈ recommended |
| `onEvent` | — | `(ev) => void` callback |

### Result

```js
{
  scans: [ {                          // one entry per submitted link
    scanId, index, url, task, title,
    pages: [ { url, task, title, markdown, meta: { strategy, framework?, fetchedAt, bytes } } ],
    files: [ { filename, title, markdown, bytes, pages: [url, …] } ],  // the verbatim .md, in memory
    documents: [ { id, url, title, fetchedAt, bytes, markdown, headings, file } ],  // only when perDocument:true
    stats, warnings,
  } ],
  stats: {
    pages, durationMs,
    strategyCounts: { 'docs:llms-full', 'docs:sitemap', 'docs:framework', agent },
    tokens: { calls, inputTokens, outputTokens, byKind: { reveal, scope, links, 'nav-plan', … } },  // AI cost, split by call type
  },
  warnings: [ { url?, reason, message } ],
  run: { id, dir, scans } | null,     // null unless the run was SAVED (see below)
}
```

**As a library, nothing is written to disk by default.** Every extracted file's
Markdown is already here in memory under `scans[].files[].markdown` — save it
wherever you like:

```js
import { crawlDocs } from 'sagecrawl';
import { writeFile } from 'node:fs/promises';

const run = crawlDocs([{ url, task }], { provider: 'openai', baseUrl, apiKey, model: 'gpt-4o-mini' });
const { scans } = await run.result;                 // no disk writes
for (const s of scans)
  for (const f of s.files)
    await writeFile(`./out/${f.filename}`, f.markdown);   // you decide where
```

To *also* have sagecrawl persist a run to its cache (so `reshape` can reuse it), pass
`save: true` or a `cacheDir` — then `result.run` is populated.

## How it crawls

The crawler is **browser-first and AI-driven**, built for precision over speed,
and works the same way on any site — no per-framework special-casing.

**Per page (the engine):**

1. **Render** the page in a real browser so dynamic / client-rendered content
   (SPAs, JS widgets) actually exists.
2. **Reveal everything that hides content.** It exhaustively exercises every
   tab, accordion, segmented control, "load more"/lazy-scroll and JS widget *in
   the main content* — capturing each revealed state and de-duplicating so
   mutually-exclusive variants (e.g. Firebase's per-SDK code tabs) are all kept.
   Interactive controls are found not just by selectors but by a
   **listener-sniffer** that tags any element with a JS click handler, so
   non-obvious widgets aren't missed. Site chrome (nav/header/footer) is skipped
   and cookie/consent banners are dismissed once.
3. **Extract** the revealed content to clean, **verbatim** Markdown.
4. **Decide relevance with AI** (for non-documentation tasks): keep only the
   sections that belong to the task — "extract the pizza menu", "extract the
   pricing" — dropping nav/marketing/footer.
5. **Discover more pages, and let AI decide what to follow.** The engine surfaces
   *every* destination on the page — in-content links, nav/footer/app-bar links,
   and route tables mined from page JS/JSON — **exactly as written, making no
   assumption about URL shape**. The AI then decides which are real pages worth
   following for the task. This is deliberate: routing/pagination is
   site-specific (a fragment route like `#/contact`, a query route like
   `?view=pricing`, or some bespoke scheme), so instead of teaching the algorithm
   each pattern, the AI recognises the navigation and skips mere same-page
   anchors. Anything chosen is followed by loading that exact URL so the page (or
   SPA view) renders before extraction; identical content is de-duplicated.

**Documentation accelerators.** When the task is documentation, two complete
sources short-circuit the work when present: **`/llms-full.txt`** (the
publisher's own full export, used verbatim) and **`/sitemap.xml`** (an
authoritative page list used to *seed* the engine). Every seeded page still goes
through the browser-first engine, so dynamic docs are fully revealed.

**Precision matters.** Completeness is preferred over speed. Whenever
completeness can't be guaranteed, a `warn` event is emitted and recorded in the
manifest. Login-gated, CAPTCHA-protected, and image/`<canvas>`-only content is
skipped with a warning — never circumvented.

> The browser is required for the engine. With `--browser never` the crawler
> degrades to static extraction (no reveal) and warns that hidden content may be
> missing.

## Output

The **CLI and Web UI** save every run automatically — one folder per run under the
runs cache (`<cwd>/.sagecrawl/runs/<runId>/`). *(As a library, saving is opt-in — see
[Library API](#library-api); the layout below is what gets written when it's on.)*

- **One verbatim `.md` per link.** The crawl consolidates everything it kept for a
  link into a single faithful Markdown file (named from the task), in crawl order.
  When a link spans several pages, each page is introduced by a heading + a
  `_Source:_` line so provenance is clear; the content itself is never rewritten.
  The crawl **does not** split, filter or reshape — that is Phase 2.
- **`manifest.json`** — `runId`, `createdAt`, `targets`, `options`, the `files`
  list (`{ filename, title, bytes, pages }`), every page `{ url, task, title,
  strategy, file }`, plus `stats` and `warnings`. **refdna reads this manifest.**
- **`run.json`** — a small summary used to list runs quickly.

Each Markdown file starts with a short YAML front-matter block (`task`,
`generatedAt`, `sources`). Manage saved runs with `sagecrawl runs …` or the Web UI's
"Previous runs" list.

### Per-document output (opt-in)

For programmatic consumers (a pipeline, an index, a RAG chunker) the single
consolidated file is awkward. Pass `perDocument: true` (CLI `--per-document`) to
**also** get one identifiable document per page, alongside the consolidated `.md`:

- `documents/<id>.md` — one file per kept page, each with a small front-matter
  (`url`, `title`, `fetchedAt`) then the page's **verbatim** Markdown. The `<id>` is
  stable (derived from the URL).
- `documents.jsonl` — one machine-readable record per line: `{ id, url, title,
  fetchedAt, bytes, file, headings }` (an H1–H3 outline per page, for section paths).
- `index.md` — an llms.txt-style index of everything crawled.

This is **pure repackaging** — the content is identical to the consolidated file
(the union of the per-document bodies equals it, byte-for-byte per page); nothing is
filtered or transformed. In the library, `result.scans[].documents` carries the same
records in memory even when saving is off.

## Reshape (Phase 2)

The crawl gives you a faithful extraction; **reshape** turns it into whatever you
need, on demand, over the **saved** files — as many times as you like, reusing the
same extraction as context (like a knowledge base). It can **filter** ("only the
available slots"), **reshape** ("as a table"), **regroup** ("by day") and **split**
into several files. It is **value-faithful**: every kept name, number, price and
time is copied exactly — it never invents or alters a value.

```sh
sagecrawl reshape <runId> --ask "make a table of the prices"
sagecrawl reshape <runId> --ask "split the menu into one file per category" --scan 01-example-com
```

In the Web UI, open a saved link and use the **Reshape** panel — each answer is
saved as a new file (under `<runId>/<scan>/chat/`) you can open and reuse. The
crawl's own files are never modified.

## Measuring quality

An evaluation harness turns the crawler's promises into **numbers you can compare
before/after a change**: reveal completeness (did known interaction-hidden content
survive?), sitemap coverage + run diff, task recall/precision against a golden set
(SWDE-style), and **tokens per call type** (`reveal` / `scope` / `links` / `nav-plan`).
The scoring in [`src/eval/`](src/eval/) is pure and ships with the package; the runner
that drives a real crawl is repo-only:

```sh
npm run eval -- --model qwen3-coder:30b        # scores every eval/golden/*.json
```

Write one JSON spec per site under `eval/golden/`. See [eval/README.md](eval/README.md)
for the schema and the honest limits (absolute completeness is not provable — these are
the standard proxies).

## Tests

The unit suite runs in seconds with **no browser, no model and no network** (the AI
judgment layer is exercised against a local OpenAI-compatible stub), using Node's
built-in runner — zero extra dependencies:

```sh
npm test
```

It covers extraction (chrome removal, link-density pruning and its never-lose-content
cascade), URL normalisation/scoping, task-relevance scoring, SimHash near-dup detection,
the docs-intent detector, output assembly (consolidated + per-document), the LLM
provider descriptor, the eval metrics, and the AI link/scope/reveal gates' completeness
contracts (empty verdict honoured, garbage → follow-all, no candidate lost to a batch cap).
Run it before and after any engine change; a live check on a reference site
(`npm run eval`) remains the final word for crawl behaviour.

## License

MIT — see [LICENSE](LICENSE).
