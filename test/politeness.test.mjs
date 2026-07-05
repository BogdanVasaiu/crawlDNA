// #14 — politeness opt-in (delay / robots) + always-on anti-bot detection,
// fully offline (local stub site, browser 'never', no model). The acceptance
// criteria from TODO.md:
//   - delay on → same-host requests are spaced ≥ delay; off → identical to today;
//   - robots on → disallowed URLs appear as WARNINGS, not pages; off → kept;
//   - challenge fixtures (HTTP 200 and 403/429) → never in the output, each
//     produces the `anti-bot` warning, exactly one backoff retry;
//   - a real page whose TEXT merely mentions captchas does NOT trip the guard
//     (the widget/marker is required, not the word).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseRobots, isAllowed, createHostGate } from '../src/lib/robots.mjs';
import { detectChallenge, challengeBackoffMs } from '../src/lib/challenge.mjs';
import { crawlDocs } from '../src/index.mjs';

// --- unit: robots.txt parsing --------------------------------------------------

test('parseRobots: the most specific matching User-agent group wins over *', () => {
  const txt = [
    'User-agent: *',
    'Disallow: /private/',
    'Crawl-delay: 10',
    '',
    'User-agent: crawldna',
    'Disallow: /internal/',
    'Crawl-delay: 2',
  ].join('\n');
  const mine = parseRobots(txt, 'crawldna/0.1');
  assert.deepEqual(mine.rules, [{ type: 'disallow', path: '/internal/' }]);
  assert.equal(mine.crawlDelay, 2);
  const other = parseRobots(txt, 'somebot');
  assert.deepEqual(other.rules, [{ type: 'disallow', path: '/private/' }]);
  assert.equal(other.crawlDelay, 10);
});

test('parseRobots: consecutive User-agent lines share one group; comments ignored', () => {
  const txt = ['User-agent: a', 'User-agent: *', 'Disallow: /x # trailing comment', '# full comment'].join('\n');
  assert.deepEqual(parseRobots(txt, 'crawldna').rules, [{ type: 'disallow', path: '/x' }]);
});

test('isAllowed: longest match wins, Allow beats Disallow on a tie, wildcards + $ anchor', () => {
  const rules = [
    { type: 'disallow', path: '/docs/' },
    { type: 'allow', path: '/docs/public/' },
    { type: 'disallow', path: '/*.pdf$' },
  ];
  assert.equal(isAllowed(rules, '/docs/secret'), false, 'under the disallow');
  assert.equal(isAllowed(rules, '/docs/public/intro'), true, 'longer Allow overrides');
  assert.equal(isAllowed(rules, '/files/report.pdf'), false, 'wildcard + anchor');
  assert.equal(isAllowed(rules, '/files/report.pdf.html'), true, '$ really anchors');
  assert.equal(isAllowed(rules, '/blog/post'), true, 'no matching rule = allowed');
  assert.equal(isAllowed([], '/anything'), true, 'no rules = allowed');
  // "Disallow:" with an empty value disallows nothing (per the spec)
  assert.equal(isAllowed([{ type: 'disallow', path: '' }], '/x'), true);
});

test('createHostGate: same-host requests are spaced; different hosts never wait', async () => {
  const gate = createHostGate();
  const t0 = Date.now();
  await gate.wait('https://a.dev/1', 120);
  const other = Date.now();
  await gate.wait('https://b.dev/1', 120); // different host — immediate
  assert.ok(Date.now() - other < 60, 'cross-host: no wait');
  await gate.wait('https://a.dev/2', 120); // same host — waits for the slot
  assert.ok(Date.now() - t0 >= 110, 'same-host: second request ≥ delay after the first');
});

// --- unit: challenge detection --------------------------------------------------

const CF_INTERSTITIAL =
  '<html><head><meta http-equiv="refresh" content="8"><title>Just a moment...</title></head>' +
  '<body><h1>Checking your browser before accessing example.com</h1>' +
  '<p>This process is automatic.</p></body></html>';

test('detectChallenge: interstitials and captcha walls are flagged, 200 or blocked alike', () => {
  assert.ok(detectChallenge({ status: 200, html: CF_INTERSTITIAL, contentLen: 120 }).challenge, 'HTTP 200 interstitial');
  assert.ok(
    detectChallenge({ status: 403, html: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>', contentLen: 40 }).challenge,
    '403 + turnstile widget',
  );
  assert.ok(
    detectChallenge({ status: 429, html: '<p>Unusual traffic from your network.</p>', contentLen: 45 }).challenge,
    '429 + challenge phrasing',
  );
  assert.ok(detectChallenge({ status: 200, headers: { 'cf-mitigated': 'challenge' }, html: '', contentLen: 0 }).challenge, 'vendor header alone suffices');
});

test('detectChallenge: real pages never trip it — the word is not the widget', () => {
  // A documentation page ABOUT captchas, with real text mass and even a code
  // sample containing the widget URL: NOT a challenge.
  const docs =
    '<html><body><main><h1>Adding reCAPTCHA to your form</h1>' +
    '<pre>&lt;script src="https://www.google.com/recaptcha/api.js"&gt;</pre>' +
    `<p>${'Long explanatory prose about integrating the captcha widget properly. '.repeat(30)}</p>` +
    '</main></body></html>';
  assert.equal(detectChallenge({ status: 200, html: docs, contentLen: 1800 }).challenge, false);
  // A plain thin 404 has no challenge marker — thin alone flags nothing.
  assert.equal(detectChallenge({ status: 404, html: '<h1>Not found</h1>', contentLen: 9 }).challenge, false);
  // Challenge phrasing on a CONTENT-RICH page (e.g. a blog post quoting it) passes.
  assert.equal(detectChallenge({ status: 200, html: '<p>checking your browser</p>', contentLen: 5000 }).challenge, false);
});

test('challengeBackoffMs honours Retry-After seconds, bounded; sane default otherwise', () => {
  assert.equal(challengeBackoffMs({ 'retry-after': '3' }), 3000);
  assert.equal(challengeBackoffMs({ 'retry-after': '9999' }), 15000);
  assert.equal(challengeBackoffMs({}), 2500);
  assert.equal(challengeBackoffMs({ 'retry-after': 'garbage' }), 2500);
});

// --- e2e over a stub site (browser 'never', no model) ---------------------------

const hits = []; // { path, at } — request log for spacing/retry assertions
const SITE = {
  '/docs': `<html><head><title>Guide</title></head><body><main>
    <h1>Guide</h1><p>Alpha section: the guide explains the first feature in detail.</p>
    <a href="/docs/b">Setup</a> <a href="/docs/c">Usage</a></main></body></html>`,
  '/docs/b': `<html><head><title>Setup</title></head><body><main>
    <h1>Setup</h1><p>Bravo section: install the package and configure the basics.</p></main></body></html>`,
  '/docs/c': `<html><head><title>Usage</title></head><body><main>
    <h1>Usage</h1><p>Charlie section: run the tool against your project.</p></main></body></html>`,
};
let robotsBody = null; // set per test; null → 404
let challengePath = null; // path that serves the challenge fixture
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
  hits.push({ path: p, at: Date.now() });
  if (p === '/robots.txt') {
    if (robotsBody == null) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('nope');
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(robotsBody);
  }
  if (p === challengePath) {
    res.writeHead(200, { 'content-type': 'text/html', 'retry-after': '1' });
    return res.end(CF_INTERSTITIAL);
  }
  const html = SITE[p];
  if (!html) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function crawl(options = {}) {
  hits.length = 0;
  const events = [];
  const run = crawlDocs([{ url: `${base}/docs`, task: 'Extract the documentation' }], {
    model: '', browser: 'never', concurrency: 2,
    ...options,
    onEvent: (ev) => events.push(ev),
  });
  const result = await run.result;
  return { result, events };
}

test('respectRobots: disallowed URLs become warnings, not pages; off = kept (today)', async () => {
  robotsBody = 'User-agent: *\nDisallow: /docs/b';
  challengePath = null;
  const on = await crawl({ respectRobots: true });
  const urlsOn = on.result.scans[0].pages.map((p) => p.url);
  assert.ok(!urlsOn.some((u) => u.includes('/docs/b')), 'the disallowed page is not in the output');
  assert.ok(urlsOn.some((u) => u.includes('/docs/c')), 'allowed pages still crawled');
  const warn = on.events.find((e) => e.type === 'warn' && e.reason === 'robots');
  assert.ok(warn && warn.url.includes('/docs/b'), 'the skip is LOUD — a robots warning names the URL');

  const off = await crawl({ respectRobots: false });
  assert.ok(off.result.scans[0].pages.some((p) => p.url.includes('/docs/b')), 'off (default) keeps it — user-directed');
  assert.ok(!off.events.some((e) => e.type === 'warn' && e.reason === 'robots'));
  robotsBody = null;
});

test('delay: same-host page requests are spaced ≥ delay even with concurrency 2', async () => {
  challengePath = null;
  const { result } = await crawl({ delay: 150 });
  assert.equal(result.scans[0].pages.length, 3, 'nothing is lost by being polite');
  const pageHits = hits.filter((h) => h.path.startsWith('/docs')).map((h) => h.at);
  for (let i = 1; i < pageHits.length; i++) {
    assert.ok(pageHits[i] - pageHits[i - 1] >= 100, `request ${i} spaced ${pageHits[i] - pageHits[i - 1]}ms — expected ≥ ~150`);
  }
});

test('anti-bot: a challenge page (HTTP 200!) is warned, retried once, then skipped — never content', async () => {
  challengePath = '/docs/c';
  const { result, events } = await crawl({});
  const urls = result.scans[0].pages.map((p) => p.url);
  assert.ok(!urls.some((u) => u.includes('/docs/c')), 'the interstitial never enters the output');
  assert.ok(urls.some((u) => u.includes('/docs/b')), 'the rest of the site is unaffected');
  const md = result.scans[0].files.map((f) => f.markdown).join('\n');
  assert.ok(!/checking your browser/i.test(md), 'no challenge boilerplate in the consolidated output');
  const warns = events.filter((e) => e.type === 'warn' && e.reason === 'anti-bot');
  assert.equal(warns.length, 2, 'one warning at detection, one at the declared skip');
  assert.equal(hits.filter((h) => h.path === '/docs/c').length, 2, 'exactly one backoff retry');
  challengePath = null;
});
