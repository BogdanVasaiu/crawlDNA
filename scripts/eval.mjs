#!/usr/bin/env node
// The measurement RUNNER (TODO.md #12). Crawls one or more GOLDEN SPECS and prints the
// scored report (reveal completeness, sitemap coverage, task recall/precision, tokens
// per call type). This is the piece that needs a real model + browser, so it lives in
// scripts/ (repo-only, not shipped in the npm package) — the pure scoring in
// src/eval/*.mjs is what ships and is unit-tested offline.
//
// Usage:
//   node scripts/eval.mjs [spec.json …] --model qwen3-coder:30b [options]
//   npm run eval -- --model qwen3-coder:30b            # runs every eval/golden/*.json
//
// A spec is JSON: { name, url, task, expect:{ revealContent?, mustInclude?, mustExclude?,
// sitemapUrls?|sitemap?, sitemapPrefix? }, options? }. See eval/README.md.

import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { crawlDocs } from '../src/index.mjs';
import { collectSitemapUrls } from '../src/profiles/docs/sitemap.mjs';
import { evaluate, formatReport } from '../src/eval/report.mjs';
import { pathOf } from '../src/lib/url.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(HERE, '..', 'eval', 'golden');

const OPTIONS = {
  model: { type: 'string' },
  provider: { type: 'string' },
  'base-url': { type: 'string' },
  'api-key': { type: 'string' },
  'ollama-host': { type: 'string' },
  browser: { type: 'string' },
  concurrency: { type: 'string' },
  'max-pages': { type: 'string' },
  'max-actions': { type: 'string' },
  'min-relevance': { type: 'string' },
  baseline: { type: 'string' }, // path to a previous eval JSON, for a run diff
  out: { type: 'string' }, // dir to write per-spec eval JSON (enables future baselines)
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `crawldna eval — measure a crawl against a golden spec (TODO.md #12)

  node scripts/eval.mjs [spec.json …] --model <id> [options]
  npm run eval -- --model qwen3-coder:30b

With no spec paths, every eval/golden/*.json is run. A spec is JSON:
  { "name", "url", "task",
    "expect": { "revealContent":[…], "mustInclude":[…], "mustExclude":[…],
                "sitemap": true | "sitemapUrls":[…], "sitemapPrefix":"/docs" },
    "options": { … crawl options … } }

Options: --model (required) --provider --base-url --api-key --ollama-host
         --browser --concurrency --max-pages --max-actions --min-relevance
         --baseline <prev.eval.json> --out <dir> --quiet`;

/** Load a spec file (tolerating a UTF-8 BOM). */
async function loadSpec(p) {
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw.replace(/^﻿/, ''));
}

/** The sitemap URL list to score coverage against: inline, or fetched live and
 *  optionally narrowed to a section prefix. Null when the spec doesn't ask for it. */
async function gatherSitemap(spec) {
  const e = spec.expect || {};
  if (Array.isArray(e.sitemapUrls)) return e.sitemapUrls;
  if (e.sitemap || e.checkSitemap) {
    const all = await collectSitemapUrls(spec.url, {});
    if (!e.sitemapPrefix) return all;
    return all.filter((u) => {
      const p = pathOf(u);
      return p === e.sitemapPrefix || p.startsWith(e.sitemapPrefix.replace(/\/$/, '') + '/');
    });
  }
  return null;
}

function crawlOptionsFrom(spec, values) {
  const o = { save: false, task: spec.task, ...(spec.options || {}) };
  if (values.model) o.model = values.model;
  if (values.provider) o.provider = values.provider;
  if (values['base-url']) o.baseUrl = values['base-url'];
  if (values['api-key']) o.apiKey = values['api-key'];
  if (values['ollama-host']) o.ollamaHost = values['ollama-host'];
  if (values.browser) o.browser = values.browser;
  if (values.concurrency) o.concurrency = Number(values.concurrency);
  if (values['max-pages'] != null) o.maxPages = Number(values['max-pages']);
  if (values['max-actions'] != null) o.maxActions = Number(values['max-actions']);
  if (values['min-relevance'] != null) o.minRelevance = Number(values['min-relevance']);
  return o;
}

async function runOne(specPath, values) {
  const spec = await loadSpec(specPath);
  if (!spec.url) throw new Error(`spec ${specPath} has no "url"`);
  const quiet = !!values.quiet;
  if (!quiet) process.stderr.write(`\n▶ crawling ${spec.name || spec.url} …\n`);

  const run = crawlDocs({ url: spec.url, task: spec.task }, crawlOptionsFrom(spec, values));
  for await (const ev of run) {
    if (quiet) continue;
    if (ev.type === 'extracted') process.stderr.write(`  ✓ ${ev.title || ev.url}\n`);
    else if (ev.type === 'warn') process.stderr.write(`  ⚠ ${ev.message}\n`);
    else if (ev.type === 'error') process.stderr.write(`  ✗ ${ev.message}\n`);
  }
  const result = await run.result;

  const sitemapUrls = await gatherSitemap(spec).catch(() => null);
  let baselinePages = null;
  if (values.baseline) {
    try {
      const prev = JSON.parse((await readFile(values.baseline, 'utf8')).replace(/^﻿/, ''));
      baselinePages = prev.pages || null;
    } catch (err) {
      process.stderr.write(`  (baseline not loaded: ${err && err.message})\n`);
    }
  }

  const report = evaluate({ result, spec, sitemapUrls, baselinePages });
  process.stdout.write('\n' + formatReport(report) + '\n');

  if (values.out) {
    await mkdir(values.out, { recursive: true });
    const pages = [];
    for (const scan of result.scans || []) for (const p of scan.pages || []) pages.push({ url: p.url, bytes: (p.meta && p.meta.bytes) || 0 });
    const base = (spec.name || path.basename(specPath, '.json')).replace(/[^\w.-]+/g, '-');
    await writeFile(path.join(values.out, base + '.eval.json'), JSON.stringify({ report, pages }, null, 2) + '\n', 'utf8');
  }
  return report;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true });
  } catch (err) {
    process.stderr.write('Argument error: ' + err.message + '\n\n' + HELP + '\n');
    process.exitCode = 1;
    return;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (!values.model && !values['base-url']) {
    process.stderr.write('A model is required: --model <id> (and --provider/--base-url for an API).\n\n' + HELP + '\n');
    process.exitCode = 1;
    return;
  }

  let specs = positionals;
  if (!specs.length) {
    try {
      const files = await readdir(GOLDEN_DIR);
      specs = files.filter((f) => f.endsWith('.json')).map((f) => path.join(GOLDEN_DIR, f));
    } catch {
      /* no golden dir */
    }
  }
  if (!specs.length) {
    process.stderr.write(`No spec files given and none found in ${GOLDEN_DIR}\n`);
    process.exitCode = 1;
    return;
  }

  for (const p of specs) {
    try {
      await runOne(p, values);
    } catch (err) {
      process.stderr.write(`✗ ${p}: ${(err && err.message) || err}\n`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  process.stderr.write('Fatal: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
