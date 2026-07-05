// Incremental persistence + resume (#13), fully offline (a local stub site, no
// browser, no model). The acceptance criteria from TODO.md, verbatim:
//   - a run interrupted mid-crawl leaves its extracted pages on disk, readable;
//   - `resume` completes it and the final output is IDENTICAL (same page set)
//     to a run that was never interrupted;
//   - zero writes when saving is off (the library contract is unchanged).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, appendFile, rm, stat, unlink } from 'node:fs/promises';
import { crawlDocs, resumeCrawl } from '../src/index.mjs';
import { initRun, appendJournal, readJournal, saveRun, loadRunForResume } from '../src/lib/runs.mjs';

// --- stub site: /docs entry linking to two more pages -----------------------
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
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  const html = PAGES[p];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});

let base;
let tmp;
let envCacheDir;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tmp = await mkdtemp(path.join(os.tmpdir(), 'crawldna-resume-test-'));
  // The zero-writes assertions must not be defeated by ambient config.
  envCacheDir = process.env.CRAWLDNA_CACHE_DIR;
  delete process.env.CRAWLDNA_CACHE_DIR;
});
after(async () => {
  server.close();
  if (envCacheDir !== undefined) process.env.CRAWLDNA_CACHE_DIR = envCacheDir;
  await rm(tmp, { recursive: true, force: true });
});

// Docs task + browser:'never' → static-fallback engine over the stub site: no
// Playwright, no model (model '' fails the health check → heuristics), no
// external network. Concurrency 1 makes the stop point deterministic.
const CRAWL_OPTS = { model: '', browser: 'never', concurrency: 1 };
const TARGET = () => ({ url: `${base}/docs`, task: 'Extract the documentation' });

const sortedPages = (scan) =>
  scan.pages.map((p) => ({ url: p.url, markdown: p.markdown })).sort((a, b) => (a.url < b.url ? -1 : 1));

/** Crawl to completion, stopping after the first kept page when `stopAfterFirst`. */
async function runCrawl({ save, stopAfterFirst = false, cacheDir } = {}) {
  let stoppedOnce = false;
  const events = [];
  const run = crawlDocs([TARGET()], {
    ...CRAWL_OPTS,
    ...(save ? { save: true, cacheDir } : {}),
    onEvent: (ev) => {
      events.push(ev);
      if (stopAfterFirst && ev.type === 'extracted' && !stoppedOnce) {
        stoppedOnce = true;
        run.stop();
      }
    },
  });
  const result = await run.result;
  return { result, events };
}

// The uninterrupted reference: what a never-killed crawl of the site produces.
let control;
test('control: the uninterrupted crawl keeps all three pages (in memory, no save)', async () => {
  const { result } = await runCrawl({ save: false });
  control = sortedPages(result.scans[0]);
  assert.equal(control.length, 3, 'the stub site has exactly three pages');
  assert.equal(result.run, null, 'saving is off — no run recorded');
});

test('zero writes when saving is off', async () => {
  // The control crawl above ran with save off from the repo cwd; prove the
  // library wrote nothing by crawling from a pristine cwd and checking it.
  const cleanCwd = await mkdtemp(path.join(os.tmpdir(), 'crawldna-nosave-'));
  const prevCwd = process.cwd();
  process.chdir(cleanCwd);
  try {
    const { result } = await runCrawl({ save: false });
    assert.equal(result.scans[0].pages.length, 3);
    await assert.rejects(stat(path.join(cleanCwd, '.crawldna')), 'no cache dir may appear');
  } finally {
    process.chdir(prevCwd);
    await rm(cleanCwd, { recursive: true, force: true });
  }
});

// --- the acceptance path: stop mid-crawl → journal on disk → resume ---------
let stoppedRunId;
test('a stopped run leaves status \'stopped\' + a readable journal with the kept page and its links', async () => {
  const { result } = await runCrawl({ save: true, cacheDir: tmp, stopAfterFirst: true });
  assert.ok(result.run, 'the interrupted run is still saved');
  stoppedRunId = result.run.id;
  assert.equal(result.scans[0].pages.length, 1, 'only the entry page was kept before the stop');

  const summary = JSON.parse(await readFile(path.join(tmp, stoppedRunId, 'run.json'), 'utf8'));
  assert.equal(summary.status, 'stopped');

  const scanId = result.scans[0].scanId;
  const journal = await readJournal(stoppedRunId, scanId, { cacheDir: tmp });
  assert.equal(journal.length, 1, 'the kept page was journaled AS IT WAS CAPTURED');
  assert.equal(journal[0].page.url, `${base}/docs`);
  assert.ok(journal[0].page.markdown.includes('Alpha section'), 'journaled content is the verbatim page');
  assert.ok(
    journal[0].links.some((l) => l.includes('/docs/b')) && journal[0].links.some((l) => l.includes('/docs/c')),
    'the page\'s discovered links travel with it (they re-seed the frontier on resume)',
  );
});

test('resume completes the stopped run: same page set as the uninterrupted crawl, same folder, journal cleared', async () => {
  const events = [];
  const run = await resumeCrawl(stoppedRunId, { cacheDir: tmp, onEvent: (ev) => events.push(ev) });
  const result = await run.result;

  const restoredEv = events.find((e) => e.type === 'resume');
  assert.ok(restoredEv && restoredEv.restored === 1, 'the restored page is announced, not re-crawled');
  assert.equal(result.run.id, stoppedRunId, 'resume writes into the SAME run folder');

  // The acceptance criterion: identical output to the never-interrupted run.
  assert.deepEqual(sortedPages(result.scans[0]), control, 'page set + verbatim content match the control run');

  const summary = JSON.parse(await readFile(path.join(tmp, stoppedRunId, 'run.json'), 'utf8'));
  assert.equal(summary.status, 'done');
  await assert.rejects(
    stat(path.join(tmp, stoppedRunId, result.scans[0].scanId, 'pages.jsonl')),
    'a completed run\'s journal is superseded by the consolidated files',
  );

  await assert.rejects(resumeCrawl(stoppedRunId, { cacheDir: tmp }), /already complete/, 'done runs do not resume');
});

test('crash variant: status \'running\', no manifest, a torn journal tail — resume still completes identically', async () => {
  // Build the exact on-disk state a kill -9 leaves behind: run.json as initRun
  // wrote it (status 'running', with targets+options), a journal, NO manifest.
  const { result } = await runCrawl({ save: true, cacheDir: tmp, stopAfterFirst: true });
  const runId = result.run.id;
  const scanId = result.scans[0].scanId;
  await initRun({
    id: runId,
    targets: [TARGET()],
    options: { ...CRAWL_OPTS, save: true, cacheDir: tmp },
  });
  await unlink(path.join(tmp, runId, 'manifest.json'));
  // A crash can tear the last journal line mid-write; it must be skipped, not fatal.
  await appendFile(path.join(tmp, runId, scanId, 'pages.jsonl'), '{"page":{"url":"htt', 'utf8');

  const loaded = await loadRunForResume(runId, { cacheDir: tmp });
  assert.equal(loaded.status, 'running');
  assert.equal(loaded.journals[scanId].length, 1, 'the torn tail line is skipped, the intact record survives');

  const run = await resumeCrawl(runId, { cacheDir: tmp });
  const res2 = await run.result;
  assert.deepEqual(sortedPages(res2.scans[0]), control, 'crash-resumed output matches the control run');
  const summary = JSON.parse(await readFile(path.join(tmp, runId, 'run.json'), 'utf8'));
  assert.equal(summary.status, 'done');
});

// --- unit: the journal / run-state primitives --------------------------------
test('initRun records targets+options for crash recovery, never secrets or runtime objects', async () => {
  const { id } = await initRun({
    targets: [{ url: 'https://ex.com', task: 't' }],
    options: {
      cacheDir: tmp,
      model: 'm',
      apiKey: 'SECRET',
      llm: { apiKey: 'SECRET2' },
      __resume: { id: 'x' },
      onEvent: () => {},
    },
  });
  const summary = JSON.parse(await readFile(path.join(tmp, id, 'run.json'), 'utf8'));
  assert.equal(summary.status, 'running');
  assert.deepEqual(summary.targets, [{ url: 'https://ex.com', task: 't' }]);
  assert.equal(summary.options.model, 'm');
  assert.ok(!('apiKey' in summary.options), 'an API key is never written to disk');
  assert.ok(!('llm' in summary.options) && !('__resume' in summary.options) && !('onEvent' in summary.options));

  // Re-opening the same run (resume) preserves the original creation time.
  const again = await initRun({ id, targets: [], options: { cacheDir: tmp } });
  assert.equal(again.createdAt, summary.createdAt);
});

test('saveRun keeps the journal on \'stopped\' and deletes it on \'done\'', async () => {
  const { id } = await initRun({ targets: [{ url: 'https://ex.com', task: 't' }], options: { cacheDir: tmp } });
  const scan = {
    scanId: '01-ex-com',
    url: 'https://ex.com',
    task: 't',
    title: 'ex.com',
    pages: [{ url: 'https://ex.com/a', task: 't', title: 'A', markdown: '# A', meta: { strategy: 'agent' } }],
    files: [{ filename: 'out.md', title: 'Out', markdown: '# A', bytes: 3, pages: ['https://ex.com/a'] }],
    stats: { pages: 1 },
    warnings: [],
  };
  await appendJournal(id, scan.scanId, { page: scan.pages[0], links: [] }, { cacheDir: tmp });

  const stopped = await saveRun({ targets: [], options: { cacheDir: tmp }, scans: [scan], id, status: 'stopped' });
  assert.equal(stopped.summary.status, 'stopped');
  assert.equal((await readJournal(id, scan.scanId, { cacheDir: tmp })).length, 1, 'stopped keeps the journal');

  const done = await saveRun({ targets: [], options: { cacheDir: tmp }, scans: [scan], id, status: 'done' });
  assert.equal(done.summary.status, 'done');
  assert.equal((await readJournal(id, scan.scanId, { cacheDir: tmp })).length, 0, 'done clears the journal');
});
