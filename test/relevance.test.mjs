// Task→link relevance scoring (item #1) — ordering/pruning signal for the frontier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, urlTokens, taskTerms, scoreLink } from '../src/lib/relevance.mjs';

test('tokenize: camelCase split, stopwords (en+it) and numbers dropped', () => {
  assert.deepEqual(
    tokenize('Estrai la documentazione web JavaScript di Firebase'),
    ['documentazione', 'web', 'java', 'script', 'firebase'],
  );
  assert.deepEqual(tokenize('Extract the complete documentation.'), ['documentation']);
  assert.deepEqual(tokenize('page 42 of 7'), ['page']);
});

test('urlTokens mines path + query, ignores the host', () => {
  const toks = urlTokens('https://ex.com/docs/web/setup?version=9');
  assert.ok(toks.includes('docs') && toks.includes('web') && toks.includes('setup'));
  assert.ok(!toks.includes('ex')); // host carries no discriminating signal
});

test('taskTerms deduplicates topic terms', () => {
  assert.deepEqual(taskTerms('menu menu del menu'), ['menu']);
});

test('scoreLink: generic task (no terms) never discriminates', () => {
  assert.deepEqual(scoreLink([], { href: 'https://ex.com/x' }), { score: 1, matched: 0 });
});

test('scoreLink on realistic docs task: on-task > off-task', () => {
  const terms = taskTerms('Estrai la documentazione web JavaScript');
  const web = scoreLink(terms, { href: 'https://firebase.google.com/docs/web/setup', label: 'Web setup' });
  const ios = scoreLink(terms, { href: 'https://firebase.google.com/docs/ios/setup', label: 'iOS' });
  const pricing = scoreLink(terms, { href: 'https://firebase.google.com/pricing', label: 'Pricing' });
  assert.equal(web.score, 0.5);
  assert.equal(ios.score, 0);
  assert.equal(pricing.score, 0);
});

test('scoreLink saturates at two matches', () => {
  const terms = taskTerms('estrai la documentazione web');
  const both = scoreLink(terms, { href: 'https://s.it/documentazione/web/intro', label: '' });
  assert.equal(both.score, 1);
  assert.ok(both.matched >= 2);
});

test('prefix stemming connects word families across languages', () => {
  // "document" ~ "documentazione", "price" ~ "prices" — no per-language rules
  assert.equal(scoreLink(['document'], { href: 'https://s.it/documentazione/' }).matched, 1);
  assert.equal(scoreLink(['price'], { href: 'https://s.it/prices' }).matched, 1);
  // short tokens require exact match (no 3-letter prefix false positives)
  assert.equal(scoreLink(['api'], { href: 'https://s.it/apartment' }).matched, 0);
});
