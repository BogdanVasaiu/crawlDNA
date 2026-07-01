#!/usr/bin/env node
// sagecrawl CLI — a thin face over the core (§7). All logic lives in src/index.mjs.

import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';
import { crawlDocs, DEFAULT_OPTIONS } from '../src/index.mjs';
import { listRuns, deleteRun, deleteAllRuns, cacheRoot } from '../src/lib/runs.mjs';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY;
const c = (color, s) => (useColor ? color + s + C.reset : s);

const HELP = `${C.bold}sagecrawl${C.reset} — general, task-driven web crawler → clean Markdown

Usage:
  sagecrawl <url> [--task "..."]                       crawl one site
  sagecrawl crawl <url> [options]                      crawl one or more sites
  sagecrawl reshape <runId> --ask "..."                reshape a saved extraction (Phase 2)
  sagecrawl serve [--port 4000]                        start the optional Web UI (source repo only)
  sagecrawl runs [list|rm <id…>|clear|path]            manage cached runs
  sagecrawl --help

The crawler is CLI- and library-first; the Web UI is an optional frontend that
ships only with the source repository (not the npm package), so it never weighs
down a \`sagecrawl\` dependency. \`serve\` explains how to get it if it isn't present.

Two phases. The CRAWL extracts what your task asks for, VERBATIM — one faithful
.md per link (+ manifest.json). Every run is saved automatically to the runs cache
(${cacheRoot()}).
RESHAPE is separate and optional: turn that extraction into tables, splits or
filtered subsets with \`sagecrawl reshape <runId> --ask "…"\` (or Reshape in the Web
UI). It works over the saved files, as many times as you like — crawl once,
reshape many times.

Options:
  --task <text>          extraction task (repeatable, pairs with --url)
                         default: "${DEFAULT_OPTIONS.task}"
  --url <url>            a target URL (repeatable; pair with --task for per-link tasks)
  --targets <file.json>  JSON file: a targets array ([{ "url", "task" }, ...])
  --model <name>         model id for the engine (REQUIRED — e.g. qwen3-coder:30b for
                         Ollama, or gpt-4o-mini for an OpenAI-compatible API)
  --provider <name>      ollama (default) | openai (any OpenAI-compatible API)
  --base-url <url>       API base URL for --provider openai
                         (e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1)
  --api-key <key>        API key for --provider openai
                         (or set SAGECRAWL_API_KEY / OPENAI_API_KEY in the environment)
  --browser <mode>       never | auto | always   (default: ${DEFAULT_OPTIONS.browser})
  --concurrency <n>      parallel page fetches (default: ${DEFAULT_OPTIONS.concurrency})
  --max-pages <n>        safety cap, 0 = unlimited (default: ${DEFAULT_OPTIONS.maxPages})
  --max-actions <n>      per-page engine action cap (default: ${DEFAULT_OPTIONS.maxActions})
  --include <regex>      only crawl URLs matching
  --exclude <regex>      skip URLs matching
  --min-relevance <0-1>  focus on task: skip links below this task-relevance (default: ${DEFAULT_OPTIONS.minRelevance} = off)
  --ollama-host <url>    Ollama server URL (default: http://127.0.0.1:11434)
  --cache-dir <dir>      override the runs-cache location
  --per-document         also emit one identifiable .md per page + index.md + a JSONL
                         (for programmatic use); the consolidated .md is still written
  --near-dup-hamming <n> collapse near-duplicate pages within this SimHash Hamming
                         distance (default: ${DEFAULT_OPTIONS.nearDupHamming} = off; exact dupes only). 3 ≈ recommended.
                         Opt-in: can drop a page whose unique content is small
  --port <n>             port for \`serve\` (default: 4000)

Reshape (Phase 2 — over a saved run):
  --ask <text>           the reshape request, e.g. "make a table of the prices"
  --scan <id>            which link of the run to reshape (default: the only/first)

Examples:
  sagecrawl https://docusaurus.io/docs --task "Extract all documentation"
  sagecrawl https://pizzeria.example/menu --task "Extract the full menu"
  sagecrawl --url https://a.dev --task "Get pricing" --url https://b.dev --task "Get API docs"
  OPENAI_API_KEY=sk-… sagecrawl https://docs.dev --provider openai \\
    --base-url https://api.openai.com/v1 --model gpt-4o-mini
  sagecrawl reshape 20260615-084021-3f9c1a --ask "make a table of the prices"
  sagecrawl runs                # list cached runs
  sagecrawl runs rm 20260615-084021-3f9c1a
  sagecrawl serve --port 4000
`;

const OPTION_CONFIG = {
  task: { type: 'string', multiple: true },
  url: { type: 'string', multiple: true },
  targets: { type: 'string' },
  model: { type: 'string' },
  provider: { type: 'string' },
  'base-url': { type: 'string' },
  'api-key': { type: 'string' },
  browser: { type: 'string' },
  concurrency: { type: 'string' },
  'max-pages': { type: 'string' },
  'max-actions': { type: 'string' },
  include: { type: 'string' },
  exclude: { type: 'string' },
  'min-relevance': { type: 'string' },
  'ollama-host': { type: 'string' },
  'cache-dir': { type: 'string' },
  'per-document': { type: 'boolean' },
  'near-dup-hamming': { type: 'string' },
  port: { type: 'string' },
  ask: { type: 'string' },
  scan: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

async function buildTargets(values, positionals) {
  // 1) explicit JSON file
  if (values.targets) {
    const raw = await readFile(values.targets, 'utf8');
    const parsed = JSON.parse(raw.replace(/^﻿/, '')); // tolerate a UTF-8 BOM
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const tasks = values.task || [];

  // 2) repeated --url (optionally paired with --task)
  if (values.url && values.url.length) {
    return values.url.map((url, i) => {
      const task = tasks.length === 1 ? tasks[0] : tasks[i];
      return task ? { url, task } : { url };
    });
  }

  // 3) positional URLs (after an optional `crawl` subcommand)
  const urls = positionals.filter((p) => p !== 'crawl');
  const shared = tasks[0];
  return urls.map((url) => (shared ? { url, task: shared } : { url }));
}

function optionsFromFlags(values) {
  // The CLI is an app, not a library call: it always persists the run to the cache
  // (rooted at the current working directory) so `sagecrawl runs` and `sagecrawl reshape`
  // can find it afterwards. Library callers of crawlDocs save only on opt-in.
  const o = { save: true };
  if (values.model) o.model = values.model;
  if (values.provider) o.provider = values.provider;
  if (values['base-url']) o.baseUrl = values['base-url'];
  if (values['api-key']) o.apiKey = values['api-key'];
  if (values.browser) o.browser = values.browser;
  if (values.concurrency) o.concurrency = Number(values.concurrency);
  if (values['max-pages'] != null) o.maxPages = Number(values['max-pages']);
  if (values['max-actions'] != null) o.maxActions = Number(values['max-actions']);
  if (values.include) o.include = values.include;
  if (values.exclude) o.exclude = values.exclude;
  if (values['min-relevance'] != null) o.minRelevance = Number(values['min-relevance']);
  if (values['ollama-host']) o.ollamaHost = values['ollama-host'];
  if (values['cache-dir']) o.cacheDir = values['cache-dir'];
  if (values['per-document']) o.perDocument = true;
  if (values['near-dup-hamming'] != null) o.nearDupHamming = Number(values['near-dup-hamming']);
  if (values.task && values.task.length === 1) o.task = values.task[0];
  return o;
}

function renderEvent(ev) {
  switch (ev.type) {
    case 'site':
      process.stdout.write(`\n${c(C.bold, '▶ site')} ${ev.url}  ${c(C.dim, '— ' + ev.task)}\n`);
      break;
    case 'strategy':
      process.stdout.write(
        `  ${c(C.cyan, 'strategy')} ${ev.strategy}${ev.framework ? c(C.dim, ' [' + ev.framework + ']') : ''}\n`,
      );
      break;
    case 'discover':
      process.stdout.write(`  ${c(C.cyan, 'discover')} ${ev.count} page(s)\n`);
      break;
    case 'action':
      process.stdout.write(`    ${c(C.blue, ev.action)} ${c(C.dim, ev.detail || '')}\n`);
      break;
    case 'extracted':
      process.stdout.write(
        `  ${c(C.green, '✓')} ${ev.title || '(untitled)'} ${c(C.dim, `(${ev.bytes}b) ${ev.url}`)}\n`,
      );
      break;
    case 'saved': {
      const nFiles = (ev.scans || []).reduce((n, s) => n + (s.files || []).length, 0);
      process.stdout.write(
        `  ${c(C.cyan, 'saved')} ${c(C.dim, `run ${ev.runId} · ${(ev.scans || []).length} link(s) · ${nFiles} file(s)`)}\n`,
      );
      break;
    }
    case 'progress':
      if (ev.total) process.stdout.write(`  ${c(C.dim, `progress ${ev.done}/${ev.total}`)}\n`);
      break;
    case 'warn':
      process.stdout.write(`  ${c(C.yellow, '⚠ warn')} ${ev.reason ? '[' + ev.reason + '] ' : ''}${ev.message}\n`);
      break;
    case 'error':
      process.stdout.write(`  ${c(C.red, '✗ error')} ${ev.message}\n`);
      break;
    case 'done':
      break;
    default:
      break;
  }
}

async function runCrawl(values, positionals) {
  const targets = await buildTargets(values, positionals);
  if (!targets.length) {
    process.stderr.write(c(C.red, 'No targets given.\n\n'));
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }

  const options = optionsFromFlags(values);
  const run = crawlDocs(targets, options);

  const onSigint = () => {
    process.stdout.write(c(C.yellow, '\nStopping (graceful)…\n'));
    run.stop();
  };
  process.on('SIGINT', onSigint);

  for await (const ev of run) renderEvent(ev);

  const result = await run.result;
  process.off('SIGINT', onSigint);

  const sc = result.stats.strategyCounts;
  const parts = Object.entries(sc)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join('  ');
  process.stdout.write(
    `\n${c(C.bold, 'Summary')}  ${result.stats.pages} page(s) in ${result.stats.durationMs}ms\n`,
  );
  if (parts) process.stdout.write(`  ${c(C.dim, parts)}\n`);
  if (result.warnings.length) {
    process.stdout.write(`  ${c(C.yellow, result.warnings.length + ' warning(s)')}\n`);
  }
  if (result.run) {
    process.stdout.write(`  ${c(C.dim, 'saved to ' + result.run.dir)}\n`);
    for (const s of result.run.scans || []) {
      const names = (s.files || []).map((f) => f.filename).join(', ');
      process.stdout.write(
        `  ${c(C.cyan, s.title || s.url)} ${c(
          C.dim,
          `${s.pages} page(s) → ${(s.files || []).length} file(s)${names ? ': ' + names : ''}`,
        )}\n`,
      );
    }
  }
}

// Phase 2 — reshape a saved extraction into new files, on demand.
async function reshapeCommand(args, values) {
  const runId = args[0];
  const message = values.ask || (values.task && values.task[0]);
  if (!runId || !message) {
    process.stderr.write(c(C.red, 'Usage: sagecrawl reshape <runId> --ask "<request>" [--scan <id>]\n'));
    process.exitCode = 1;
    return;
  }
  const { reshape } = await import('../src/reshape.mjs');
  try {
    const out = await reshape({
      runId,
      scanId: values.scan || '',
      message,
      model: values.model || DEFAULT_OPTIONS.model,
      provider: values.provider,
      host: values['ollama-host'],
      baseUrl: values['base-url'],
      apiKey: values['api-key'],
      cacheDir: values['cache-dir'],
    });
    if (out.reply) process.stdout.write('\n' + out.reply + '\n');
    if (out.files.length) {
      process.stdout.write(`\n${c(C.bold, 'Files')}  ${c(C.dim, '(saved under the run’s chat/ folder)')}\n`);
      for (const f of out.files) {
        process.stdout.write(`  ${c(C.green, '✓')} ${f.filename} ${c(C.dim, `(${f.bytes}b)`)}\n`);
      }
    } else {
      process.stdout.write(c(C.dim, '\n(no files produced — the model answered without emitting any)\n'));
    }
    if (out.truncated) {
      process.stdout.write(c(C.yellow, '\n⚠ only the first part of a large extraction was used\n'));
    }
  } catch (err) {
    process.stderr.write(c(C.red, 'reshape failed: ' + (err && err.message ? err.message : err) + '\n'));
    process.exitCode = 1;
  }
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || '';
  }
}

async function runsCommand(args, values) {
  const opts = values['cache-dir'] ? { cacheDir: values['cache-dir'] } : {};
  const sub = args[0] || 'list';

  if (sub === 'path') {
    process.stdout.write(cacheRoot(opts) + '\n');
    return;
  }

  if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
    const ids = args.slice(1);
    if (!ids.length) {
      process.stderr.write(c(C.red, 'Usage: sagecrawl runs rm <id> [<id> …]\n'));
      process.exitCode = 1;
      return;
    }
    for (const id of ids) {
      try {
        await deleteRun(id, opts);
        process.stdout.write(`${c(C.green, '✓')} deleted ${id}\n`);
      } catch (err) {
        process.stderr.write(c(C.red, `✗ ${id}: ${err && err.message}\n`));
      }
    }
    return;
  }

  if (sub === 'clear' || sub === 'prune') {
    const n = await deleteAllRuns(opts);
    process.stdout.write(`${c(C.green, '✓')} deleted ${n} run(s)\n`);
    return;
  }

  // default: list
  const runs = await listRuns(opts);
  if (!runs.length) {
    process.stdout.write(c(C.dim, `No cached runs in ${cacheRoot(opts)}\n`));
    return;
  }
  process.stdout.write(`${c(C.bold, 'Cached runs')} ${c(C.dim, '(' + cacheRoot(opts) + ')')}\n\n`);
  for (const r of runs) {
    const scans = r.scans || [];
    const nFiles = scans.reduce((n, s) => n + (s.files || []).length, 0);
    process.stdout.write(`  ${c(C.cyan, r.id)}  ${c(C.dim, fmtDate(r.createdAt))}\n`);
    process.stdout.write(`    ${r.pages} page(s) · ${scans.length} link(s) → ${nFiles} file(s)\n`);
    for (const s of scans) {
      const files = (s.files || []).map((f) => f.filename).join(', ');
      process.stdout.write(
        `      ${c(C.dim, '• ' + (s.url || s.title || s.scanId))}` +
          `${s.task ? c(C.dim, '  — ' + s.task) : ''}${files ? c(C.dim, '  [' + files + ']') : ''}\n`,
      );
    }
  }
  process.stdout.write(`\n${c(C.dim, 'Delete: sagecrawl runs rm <id>   ·   clear all: sagecrawl runs clear')}\n`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: OPTION_CONFIG,
      allowPositionals: true,
    });
  } catch (err) {
    process.stderr.write(c(C.red, 'Argument error: ' + err.message + '\n\n'));
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }

  const { values, positionals } = parsed;

  if (values.help || (positionals[0] === 'help')) {
    process.stdout.write(HELP);
    return;
  }

  if (positionals[0] === 'serve') {
    // The Web UI is OPTIONAL and ships only with the repository, not the npm
    // package (it would be dead weight for library/CLI users). Detect whether the
    // UI is present and, if not, explain how to get it instead of crashing — the
    // crawler itself works fully without it.
    const uiEntry = new URL('../ui/server.mjs', import.meta.url);
    let hasUI = true;
    try {
      await stat(uiEntry);
    } catch {
      hasUI = false;
    }
    if (!hasUI) {
      process.stderr.write(
        c(C.yellow, '\nThe Web UI is optional and not bundled with the npm package') +
          ' (to keep it lightweight).\n\n' +
          'The crawler works fully without it — use the CLI or the library API:\n' +
          c(C.cyan, '  sagecrawl <url> --task "…"   --model qwen3-coder:30b\n') +
          c(C.cyan, "  import { crawlDocs } from 'sagecrawl'\n") +
          '\nTo use the Web UI, run it from the source repository:\n' +
          c(C.cyan, '  git clone <sagecrawl repo> && cd sagecrawl\n') +
          c(C.cyan, '  npm install && npm run serve\n'),
      );
      process.exitCode = 1;
      return;
    }
    const { startServer } = await import('../ui/server.mjs');
    const port = Number(values.port) || 4000;
    await startServer({ port });
    return;
  }

  if (positionals[0] === 'runs') {
    await runsCommand(positionals.slice(1), values);
    return;
  }

  if (positionals[0] === 'reshape') {
    await reshapeCommand(positionals.slice(1), values);
    return;
  }

  await runCrawl(values, positionals);
}

main().catch((err) => {
  process.stderr.write('Fatal: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
