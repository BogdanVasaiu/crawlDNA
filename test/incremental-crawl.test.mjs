// #6 — incremental re-crawl, end-to-end and fully offline (a local stub site with a
// mutable sitemap, no browser, no model). Acceptance criteria from TODO.md:
//   - a second crawl of the same site reuses pages whose <lastmod> is unchanged
//     (they are restored, not re-crawled) and re-crawls only what changed;
//   - the output is identical for unchanged pages;
//   - with no sitemap / no baseline it is a normal full crawl (safe default).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { crawlDocs } from '../src/index.mjs';

const PAGES = {
  '/docs': `<html><head><title>Guide</title></head><body><main>
    <h1>Guide</h1><p>Alpha section: the guide explains the first feature in detail.</p>
    <a href="/docs/b">Setup</a> <a href="/docs/c">Usage</a></main></body></html>`,
  '/docs/b': `<html><head><title>Setup</title></head><body><main>
    <h1>Setup</h1><p>Bravo section: install the package and configure the basics.</p>
    <a href="/docs/c">Usage</a></main></body></html>`,
  '/docs/c': `<html><head><title>Usage</title></head><body><main>
    <h1>Usage</h1><p>Charlie section: run the tool against your project.</p></main></body></html>`,
};

// A mutable sitemap: the test flips a lastmod to simulate a page changing.
let lastmods;
let base;
function sitemapXml() {
  const urls = Object.keys(PAGES)
    .map((p) => `<url><loc>${base}${p}</loc><lastmod>${lastmods[p]}</lastmod></url>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${urls}</urlset>`;
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  if (p === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    return res.end(sitemapXml());
  }
  const html = PAGES[p];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});

let tmp;
let envCacheDir;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  lastmods = { '/docs': '2026-01-01', '/docs/b': '2026-01-01', '/docs/c': '2026-01-01' };
  tmp = await mkdtemp(path.join(os.tmpdir(), 'crawldna-incr-test-'));
  envCacheDir = process.env.CRAWLDNA_CACHE_DIR;
  delete process.env.CRAWLDNA_CACHE_DIR;
});
after(async () => {
  server.close();
  if (envCacheDir !== undefined) process.env.CRAWLDNA_CACHE_DIR = envCacheDir;
  await rm(tmp, { recursive: true, force: true });
});

const OPTS = () => ({ model: '', browser: 'never', concurrency: 1, incremental: true, cacheDir: tmp });
const sortedPages = (scan) =>
  scan.pages.map((p) => ({ url: p.url, markdown: p.markdown })).sort((a, b) => (a.url < b.url ? -1 : 1));

async function crawl() {
  const events = [];
  const run = crawlDocs([{ url: `${base}/docs`, task: 'Extract the documentation' }], {
    ...OPTS(),
    onEvent: (ev) => events.push(ev),
  });
  const result = await run.result;
  return { result, events, scanId: result.scans[0].scanId };
}

let baselinePages;

test('first incremental crawl: full crawl, stamps lastmod, retains the journal as a baseline', async () => {
  const { result, events, scanId } = await crawl();
  baselinePages = sortedPages(result.scans[0]);
  assert.equal(baselinePages.length, 3, 'all three pages crawled');

  // No baseline yet → announced as such, nothing reused.
  assert.ok(events.some((e) => e.type === 'incremental' && e.phase === 'no-baseline'));
  const plan = events.find((e) => e.type === 'incremental' && e.phase === 'plan');
  assert.ok(plan && plan.reused === 0, 'first run reuses nothing');

  // Every kept page carries the sitemap lastmod so the NEXT run can compare.
  for (const p of result.scans[0].pages) {
    assert.equal(p.meta.lastmod, lastmods[new URL(p.url).pathname], 'page stamped with its lastmod');
  }
  // Incremental runs keep their journal (the next run's baseline).
  await stat(path.join(tmp, result.run.id, scanId, 'pages.jsonl')); // rejects if missing
});

test('second incremental crawl (nothing changed): all three pages reused, output identical', async () => {
  const { result, events } = await crawl();
  const plan = events.find((e) => e.type === 'incremental' && e.phase === 'plan');
  assert.ok(events.some((e) => e.type === 'incremental' && e.phase === 'baseline'), 'a baseline was found');
  assert.equal(plan.reused, 3, 'all pages were unchanged → all reused (skipped render)');
  assert.deepEqual(sortedPages(result.scans[0]), baselinePages, 'reused output matches the baseline verbatim');
});

test('third incremental crawl (one page changed): only the changed page is re-crawled', async () => {
  lastmods['/docs/b'] = '2026-09-09'; // /docs/b changed since the baseline
  const { result, events } = await crawl();
  const plan = events.find((e) => e.type === 'incremental' && e.phase === 'plan');
  assert.equal(plan.reused, 2, 'the two unchanged pages are reused; the changed one is not');
  assert.deepEqual(sortedPages(result.scans[0]), baselinePages, 'the full page set is still present and identical');
});
