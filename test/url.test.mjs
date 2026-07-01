// URL normalisation, scoping and slugs — the dedup/frontier foundation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, resolveUrl, sameSite, inScope, toRegExp, slug, hostOf, originOf, pathOf } from '../src/lib/url.mjs';

test('normalizeUrl drops plain in-page anchors but keeps hash routes', () => {
  assert.equal(normalizeUrl('https://ex.com/docs/page#install'), 'https://ex.com/docs/page');
  assert.equal(normalizeUrl('https://ex.com/docs/page#step-3'), 'https://ex.com/docs/page');
  // page#a, page#b and page collapse to ONE url (the single biggest dedup win)
  assert.equal(normalizeUrl('https://ex.com/p#a'), normalizeUrl('https://ex.com/p#b'));
  // hash ROUTES are real pages in a hash-routed SPA — preserved
  assert.equal(normalizeUrl('https://ex.com/#/contact'), 'https://ex.com/#/contact');
  assert.equal(normalizeUrl('https://ex.com/#!/features'), 'https://ex.com/#!/features');
});

test('normalizeUrl strips tracking params but keeps content-selecting ones', () => {
  assert.equal(
    normalizeUrl('https://ex.com/p?utm_source=x&tab=cli&_ga_ABC123=1&fbclid=z&gclid=g'),
    'https://ex.com/p?tab=cli',
  );
  // dynamic tracker names are caught by prefix (_ga_XXXX, _gl, utm_*)
  assert.equal(normalizeUrl('https://ex.com/p?_gl=1*abc&version=2'), 'https://ex.com/p?version=2');
});

test('normalizeUrl lowercases host, trims trailing slash (except root)', () => {
  assert.equal(normalizeUrl('https://Ex.COM/Docs/Page/'), 'https://ex.com/Docs/Page');
  assert.equal(normalizeUrl('https://ex.com/'), 'https://ex.com/');
});

test('normalizeUrl rejects non-http(s) and unparsable input', () => {
  assert.equal(normalizeUrl('ftp://ex.com/file'), null);
  assert.equal(normalizeUrl('mailto:a@b.c'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('resolveUrl resolves relative hrefs against a base', () => {
  assert.equal(resolveUrl('../other', 'https://ex.com/docs/page'), 'https://ex.com/other');
  assert.equal(resolveUrl('/abs', 'https://ex.com/docs/page'), 'https://ex.com/abs');
});

test('sameSite accepts subdomains of the base, not the reverse', () => {
  assert.equal(sameSite('https://docs.ex.com/a', 'https://ex.com'), true);
  assert.equal(sameSite('https://ex.com/a', 'https://docs.ex.com'), false);
  assert.equal(sameSite('https://other.com/a', 'https://ex.com'), false);
});

test('inScope: exclude wins, include restricts, default is same-site', () => {
  const base = 'https://ex.com';
  assert.equal(inScope('https://ex.com/a', base, {}), true);
  assert.equal(inScope('https://other.com/a', base, {}), false);
  assert.equal(inScope('https://ex.com/admin', base, { exclude: 'admin' }), false);
  assert.equal(inScope('https://ex.com/a', base, { include: 'docs' }), false);
  assert.equal(inScope('https://ex.com/docs/a', base, { include: 'docs' }), true);
  // exclude beats include when both match
  assert.equal(inScope('https://ex.com/docs/a', base, { include: 'docs', exclude: 'docs' }), false);
});

test('toRegExp coerces strings, passes RegExp through, nulls invalid', () => {
  assert.ok(toRegExp('abc') instanceof RegExp);
  const re = /x/;
  assert.equal(toRegExp(re), re);
  assert.equal(toRegExp('('), null);
  assert.equal(toRegExp(''), null);
});

test('slug + url part helpers', () => {
  assert.equal(slug('Hello, World!'), 'hello-world');
  assert.equal(slug(''), 'section');
  assert.equal(hostOf('https://Ex.com/a'), 'ex.com');
  assert.equal(originOf('https://ex.com/a/b'), 'https://ex.com');
  assert.equal(pathOf('https://ex.com/a/b?q=1'), '/a/b');
});
