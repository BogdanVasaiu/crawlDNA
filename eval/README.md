# crawldna evaluation harness (`#12`)

Turns the project's promises into **numbers you can put side by side before and after a
change**, instead of trusting an estimate. This is TODO.md item **#12**.

> **Honest limits (by design).** Absolute completeness is **not provable** from a single
> crawl — that's an academic result, not a gap in this harness. What we measure are the
> standard **proxies**: did *known* hidden content survive, how much of the sitemap did we
> keep, and — against a **golden set you supply** — did the output contain *all-and-only*
> what the task asked. The harness scores a crawl against a ground truth; it can't invent
> one. Fill the `expect` fields with values **you verified on the live page**.

## What it measures

| Part | Metric | Question it answers |
|------|--------|---------------------|
| (a)(i)  | **reveal completeness** | Did interaction-hidden content (tabs / accordions / "load more") survive into the output? |
| (a)(ii) | **sitemap coverage** + **run diff** | Of the URLs the site advertises, how many did we keep? What changed vs a previous run? |
| (b) | **task recall / precision** (SWDE-style) | Recall: are the expected things present? Precision: are the known-irrelevant things absent? |
| (c) | **tokens per call type** | Where do the tokens actually go — reveal vs scope vs links vs nav-plan? |

The scoring lives in [`src/eval/metrics.mjs`](../src/eval/metrics.mjs) (pure, dependency-free,
unit-tested offline) and [`src/eval/report.mjs`](../src/eval/report.mjs). The runner that
drives a real crawl is [`scripts/eval.mjs`](../scripts/eval.mjs).

## Running it

```bash
# every eval/golden/*.json
npm run eval -- --model qwen3-coder:30b

# a specific spec, quiet, saving a report JSON (for later --baseline diffs)
node scripts/eval.mjs eval/golden/example-docs.json --model qwen3-coder:30b --out .eval-out

# compare against a previous run
node scripts/eval.mjs eval/golden/example-docs.json --model qwen3-coder:30b \
  --baseline .eval-out/example-docs.eval.json
```

Runner flags: `--model` (required) · `--provider` · `--base-url` · `--api-key` ·
`--ollama-host` · `--browser` · `--concurrency` · `--max-pages` · `--max-actions` ·
`--min-relevance` · `--baseline <prev.eval.json>` · `--out <dir>` · `--quiet`.

The harness needs a working model **and** Playwright (the reveal metric is meaningless
without a browser). It runs **in memory** — it never writes to the runs cache.

## Golden spec schema

One JSON file per site under `eval/golden/`. Any field starting with `_` is ignored
(use it for notes).

```jsonc
{
  "name": "firebase-web-setup",                 // label for the report
  "url":  "https://firebase.google.com/docs/web/setup",
  "task": "Extract the web (JavaScript) setup documentation",

  "expect": {
    // (a)(i) snippets that appear ONLY after a reveal (behind a tab, accordion, "load
    // more"). Each one present in the output = reveal worked for it. VERIFY on the page.
    "revealContent": ["npm install firebase"],

    // (b) recall — things the task asked for that MUST be present.
    "mustInclude": ["initializeApp", "firebaseConfig"],

    // (b) precision — off-task / other-platform / boilerplate that should be DROPPED.
    "mustExclude": ["CocoaPods", "build.gradle"],

    // (a)(ii) sitemap coverage. Either fetch it live (sitemap:true, optionally narrowed
    // by a path prefix) OR pin an explicit list with "sitemapUrls":[…].
    "sitemap": true,
    "sitemapPrefix": "/docs/web"
  },

  // optional crawl options (merged under the runner's flags)
  "options": { "maxPages": 30, "minRelevance": 0 }
}
```

### Writing a good spec

- **Verify every `expect` value against the live page.** A wrong snippet scores the *spec*
  as broken, not the crawler.
- Pick `revealContent` snippets that are genuinely hidden until you click — that's what
  makes the number meaningful. Something visible on first paint proves nothing.
- Keep `mustExclude` to markers that are *unambiguously* off-task (another platform's
  code, a cookie banner, a pricing CTA). Precision here is a proxy: it only sees the
  markers you list.
- For a **non-doc task** (a menu, prices, a calendar) the same shape applies — see
  [`example-menu.json`](golden/example-menu.json). This is why #12 asks for at least one
  doc and one non-doc spec.

The example specs shipped here are **templates**: confirm their values (or repoint `url`)
before reading anything into their scores.
