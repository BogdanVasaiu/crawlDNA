# docdna

> The name `docdna` is a placeholder and will be renamed.

A **general, task-driven web crawler**. Give it one or more links, each with a
natural-language **task** describing what to extract. It crawls each site to
fulfil its task and outputs clean **Markdown**.

Its defining capability: on each page it can **take actions to reveal content
that only appears after interaction** — clicking tabs, expanding accordions,
pressing "load more", scrolling for lazy content — i.e. content a plain fetch
never sees. After revealing everything, it extracts what's relevant to the task
and follows the other useful links it finds, like a crawler.

It runs three ways from a single headless core:

1. **CLI** — point it at link(s) + task(s), get Markdown.
2. **Web UI** — a control panel to set links/tasks, run, and watch live.
3. **Importable library** — another Node project imports it and consumes results.

> 📐 **How it works:** see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full
> pipeline — the AI-driven reveal engine, the task/directive model, and output
> layout.

## Install

Standalone:

```sh
git clone <repo> docdna
cd docdna
npm install
node bin/cli.mjs https://docusaurus.io/docs --task "Extract all documentation"
```

As a library:

```sh
npm install docdna
```

### Requirements

- **Node.js ≥ 20** (uses built-in `fetch`, `node:util.parseArgs`, web streams).
- **[Ollama](https://ollama.com)** running locally with a tool-calling model for
  the agentic engine. Default model: `qwen3` (the `gemma` family also works).
  Pull it once with `ollama pull qwen3`, or pass `--model <name>` to use one you
  already have.
- **[Playwright](https://playwright.dev) Chromium** — *only* needed for crawls
  that take actions / reveal hidden content (the engine). Pure structured or
  static extraction (e.g. a docs site exposing `llms-full.txt` or a sitemap)
  runs **without** it. Install the browser once:

  ```sh
  npx playwright install chromium
  ```

`playwright` is an `optionalDependency` and is lazy-loaded only when a crawl
actually needs the browser.

## CLI

```sh
docdna <url> [--task "..."]                       # crawl one site
docdna crawl <url> [--task "..."] [--model qwen3-coder:30b]
                    [--browser auto|never|always] [--concurrency 4]
                    [--include "..."] [--exclude "..."] [--max-pages 0]
                    [--cache-dir <dir>]
docdna runs [list|rm <id…>|clear|path]            # manage cached runs
docdna serve [--port 4000]                        # start the Web UI
docdna --help
```

**Every run is saved automatically** to the runs cache (`<project>/.docdna/runs`,
overridable with `--cache-dir` or the `DOCDNA_CACHE_DIR` env var) — there is no
`--out` flag. Each run is one folder: the grouped Markdown file(s), a
`manifest.json`, and a small `run.json` summary.

**Per-link tasks** — either repeated pairs:

```sh
docdna --url https://a.dev --task "Get pricing" --url https://b.dev --task "Get API docs"
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
docdna runs                 # list saved runs (id, date, task, files)
docdna runs rm <id> [<id>…] # delete specific run(s)
docdna runs clear           # delete every cached run
docdna runs path            # print the cache directory
```

## Web UI

```sh
docdna serve --port 4000
# open http://localhost:4000
```

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
import { crawlDocs } from 'docdna';

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
| `model` | `"qwen3"` | Ollama model for the engine |
| `browser` | `"auto"` | `never` \| `auto` \| `always` (lazy-loads Playwright) |
| `concurrency` | `4` | parallel page fetches |
| `maxPages` | `0` | safety cap (0 = unlimited) |
| `maxActions` | `15` | per-page action cap for the engine |
| `include` | — | only crawl URLs matching (string regex or `RegExp`) |
| `exclude` | — | skip URLs matching |
| `cacheDir` | — | override the runs-cache root (default `<project>/.docdna/runs`) |
| `onEvent` | — | `(ev) => void` callback |

### Result

```js
{
  pages: [ { url, task, title, markdown, meta: { strategy, framework?, fetchedAt, bytes } } ],
  stats: { pages, durationMs, strategyCounts: { 'docs:llms-full', 'docs:sitemap', 'docs:framework', agent } },
  warnings: [ { url?, reason, message } ],
  run: { id, dir, files: [ { filename, bytes } ] }   // where this run was cached
}
```

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

Every run is saved automatically — one folder per run under the runs cache
(`<project>/.docdna/runs/<runId>/`):

- **AI-grouped Markdown.** By default the whole extraction lands in a **single
  `.md`**. The model splits it into **several named files only when the task asks
  to**:
  - *by category* — *"extract the drinks and pizzas separately"* →
    `drinks.md` + `pizzas.md` (*"extract the menu prices"* → just `menu.md`);
  - *by page* — *"extract the information by pages"* (or "per page", "each page
    separately") → **one file per crawled page**, named from the page
    (`home.md`, `about.md`, `contact.md`, …), shown as one tab each.

  Content is kept **verbatim** (the model only chooses the grouping and
  filenames). For category splits, any section the model doesn't explicitly
  place is folded into the first file; per-page splits are assembled
  deterministically, so no extracted content is ever dropped.
- **`manifest.json`** — `runId`, `createdAt`, `targets`, `options`, the `files`
  list (`{ filename, title, bytes, pages }`), every page `{ url, task, title,
  strategy, file }`, plus `stats` and `warnings`. **refdna reads this manifest.**
- **`run.json`** — a small summary used to list runs quickly.

Each Markdown file starts with a short YAML front-matter block (`task`,
`generatedAt`, `sources`). Manage saved runs with `docdna runs …` or the Web UI's
"Previous runs" list.

## License

MIT — see [LICENSE](LICENSE).
