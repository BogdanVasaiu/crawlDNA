// The public library surface: option defaults and target normalisation.
// (crawlDocs itself needs a browser + model — covered by the live eval harness, #12.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, normalizeTargets } from '../src/index.mjs';

test('DEFAULT_OPTIONS: library-safe, precision-first defaults', () => {
  assert.equal(DEFAULT_OPTIONS.provider, 'ollama');
  assert.equal(DEFAULT_OPTIONS.model, '', 'no fake default model');
  assert.equal(DEFAULT_OPTIONS.browser, 'auto');
  assert.equal(DEFAULT_OPTIONS.save, false, 'a library writes NOTHING unless asked');
  assert.equal(DEFAULT_OPTIONS.perDocument, false);
  assert.equal(DEFAULT_OPTIONS.minRelevance, 0, 'focused mode is opt-in');
  assert.equal(DEFAULT_OPTIONS.nearDupHamming, 0, 'near-dup collapse is opt-in');
  assert.equal(DEFAULT_OPTIONS.maxPages, 0, 'unlimited by default');
});

test('normalizeTargets accepts every documented shape', () => {
  assert.deepEqual(normalizeTargets('https://a.it', 'T'), [{ url: 'https://a.it', task: 'T' }]);
  assert.deepEqual(normalizeTargets(['https://a.it', 'https://b.it'], 'T'), [
    { url: 'https://a.it', task: 'T' },
    { url: 'https://b.it', task: 'T' },
  ]);
  assert.deepEqual(normalizeTargets({ url: 'https://a.it', task: 'X' }, 'T'), [
    { url: 'https://a.it', task: 'X' },
  ]);
  // mixed array: per-target task wins, default fills the gaps
  assert.deepEqual(normalizeTargets([{ url: 'https://a.it', task: 'X' }, 'https://b.it'], 'T'), [
    { url: 'https://a.it', task: 'X' },
    { url: 'https://b.it', task: 'T' },
  ]);
});

test('normalizeTargets filters invalid entries instead of throwing', () => {
  assert.deepEqual(normalizeTargets([null, {}, { url: 'https://a.it' }], 'T'), [
    { url: 'https://a.it', task: 'T' },
  ]);
});
