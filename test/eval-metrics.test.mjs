// Measurement primitives (#12) — pure scoring, no crawl involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  revealCoverage,
  sitemapCoverage,
  taskRespect,
  diffRuns,
  tokenBreakdown,
} from '../src/eval/metrics.mjs';

test('revealCoverage: whitespace/case-insensitive substring proxy', () => {
  const out = 'Install with:\n\n```sh\nnpm   install firebase\n```\n';
  const r = revealCoverage(out, ['npm install firebase', 'pod install']);
  assert.equal(r.found, 1);
  assert.deepEqual(r.missing, ['pod install']);
  assert.equal(r.ratio, 0.5);
  assert.equal(revealCoverage('anything', []).ratio, 1, 'nothing expected = fully covered');
});

test('sitemapCoverage: canonical URL comparison (anchors/tracking collapse)', () => {
  const kept = ['https://ex.com/a#section', 'https://ex.com/b?utm_source=x', 'https://ex.com/new'];
  const sitemap = ['https://ex.com/a', 'https://ex.com/b', 'https://ex.com/c'];
  const r = sitemapCoverage(kept, sitemap);
  assert.equal(r.covered, 2);
  assert.deepEqual(r.missing, ['https://ex.com/c']);
  assert.deepEqual(r.extra, ['https://ex.com/new']);
});

test('taskRespect: recall on mustInclude, precision on mustExclude, null when unmeasured', () => {
  const out = 'The menu has margherita and marinara. Cookie banner text leaked here.';
  const r = taskRespect(out, {
    mustInclude: ['margherita', 'marinara', 'quattro formaggi'],
    mustExclude: ['cookie banner', 'pricing plans'],
  });
  assert.equal(r.recall, 0.667);
  assert.equal(r.precision, 0.5);
  assert.deepEqual(r.missing, ['quattro formaggi']);
  assert.deepEqual(r.leaked, ['cookie banner']);
  assert.equal(taskRespect(out, {}).recall, null);
  assert.equal(taskRespect(out, {}).f1, null);
});

test('diffRuns: added / removed / changed by canonical URL', () => {
  const a = [{ url: 'https://ex.com/a', bytes: 10 }, { url: 'https://ex.com/b', bytes: 20 }];
  const b = [{ url: 'https://ex.com/a#x', bytes: 15 }, { url: 'https://ex.com/c', bytes: 5 }];
  const d = diffRuns(a, b);
  assert.deepEqual(d.added, ['https://ex.com/c']);
  assert.deepEqual(d.removed, ['https://ex.com/b']);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].delta, 5);
  assert.equal(d.bytesDelta, -10); // bytesB (15+5) − bytesA (10+20)
});

test('tokenBreakdown: rows ranked by total with shares', () => {
  const t = tokenBreakdown({
    calls: 10,
    inputTokens: 900,
    outputTokens: 100,
    byKind: {
      links: { calls: 6, inputTokens: 600, outputTokens: 60 },
      reveal: { calls: 4, inputTokens: 300, outputTokens: 40 },
    },
  });
  assert.equal(t.total.total, 1000);
  assert.deepEqual(t.rows.map((r) => r.kind), ['links', 'reveal']);
  assert.equal(t.rows[0].share, 0.66);
  assert.equal(normalizeText('  A\n\nB  '), 'a b');
});
