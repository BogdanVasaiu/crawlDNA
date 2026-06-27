#!/usr/bin/env node
// docdna CLI — a thin face over the core (§7). All logic lives in src/index.mjs.

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
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

const HELP = `${C.bold}docdna${C.reset} — general, task-driven web crawler → clean Markdown

Usage:
  docdna <url> [--task "..."]                       crawl one site
  docdna crawl <url> [options]                      crawl one or more sites
  docdna reshape <runId> --ask "..."                reshape a saved extraction (Phase 2)
  docdna serve [--port 4000]                        start the Web UI
  docdna runs [list|rm <id…>|clear|path]            manage cached runs
  docdna --help

Two phases. The CRAWL extracts what your task asks for, VERBATIM — one faithful
.md per link (+ manifest.json). Every run is saved automatically to the runs cache
(${cacheRoot()}).
RESHAPE is separate and optional: turn that extraction into tables, splits or
filtered subsets with \`docdna reshape <runId> --ask "…"\` (or Reshape in the Web
UI). It works over the saved files, as many times as you like — crawl once,
reshape many times.

Options:
  --task <text>          extraction task (repeatable, pairs with --url)
                         default: "${DEFAULT_OPTIONS.task}"
  --url <url>            a target URL (repeatable; pair with --task for per-link tasks)
  --targets <file.json>  JSON file: a targets array ([{ "url", "task" }, ...])
  --model <name>         model id for the engine (default: ${DEFAULT_OPTIONS.model})
  --provider <name>      ollama (default) | openai (any OpenAI-compatible API)
  --base-url <url>       API base URL for --provider openai
                         (e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1)
  --api-key <key>        API key for --provider openai
                         (or set DOCDNA_API_KEY / OPENAI_API_KEY in the environment)
  --browser <mode>       never | auto | always   (default: ${DEFAULT_OPTIONS.browser})
  --concurrency <n>      parallel page fetches (default: ${DEFAULT_OPTIONS.concurrency})
  --max-pages <n>        safety cap, 0 = unlimited (default: ${DEFAULT_OPTIONS.maxPages})
  --max-actions <n>      per-page engine action cap (default: ${DEFAULT_OPTIONS.maxActions})
  --include <regex>      only crawl URLs matching
  --exclude <regex>      skip URLs matching
  --ollama-host <url>    Ollama server URL (default: http://127.0.0.1:11434)
  --cache-dir <dir>      override the runs-cache location
  --port <n>             port for \`serve\` (default: 4000)

Reshape (Phase 2 — over a saved run):
  --ask <text>           the reshape request, e.g. "make a table of the prices"
  --scan <id>            which link of the run to reshape (default: the only/first)

Examples:
  docdna https://docusaurus.io/docs --task "Extract all documentation"
  docdna https://pizzeria.example/menu --task "Extract the full menu"
  docdna --url https://a.dev --task "Get pricing" --url https://b.dev --task "Get API docs"
  OPENAI_API_KEY=sk-… docdna https://docs.dev --provider openai \\
    --base-url https://api.openai.com/v1 --model gpt-4o-mini
  docdna reshape 20260615-084021-3f9c1a --ask "make a table of the prices"
  docdna runs                # list cached runs
  docdna runs rm 20260615-084021-3f9c1a
  docdna serve --port 4000
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
  'ollama-host': { type: 'string' },
  'cache-dir': { type: 'string' },
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
  const o = {};
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
  if (values['ollama-host']) o.ollamaHost = values['ollama-host'];
  if (values['cache-dir']) o.cacheDir = values['cache-dir'];
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
    process.stderr.write(c(C.red, 'Usage: docdna reshape <runId> --ask "<request>" [--scan <id>]\n'));
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
      process.stderr.write(c(C.red, 'Usage: docdna runs rm <id> [<id> …]\n'));
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
  process.stdout.write(`\n${c(C.dim, 'Delete: docdna runs rm <id>   ·   clear all: docdna runs clear')}\n`);
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
