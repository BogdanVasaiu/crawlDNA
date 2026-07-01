// SimHash near-duplicate fingerprint (item #7) — the opt-in nearDupHamming gate rests
// on these properties: identical=0, small edit=small distance, unrelated=far.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simhash, hamming, isNearDup } from '../src/lib/simhash.mjs';

const base =
  'Getting started with the client library requires an account and an API key. ' +
  'First install the package from the registry, then initialise the client with your key. ' +
  'The client exposes methods for reading, writing and subscribing to updates. ' +
  'Errors are surfaced as typed exceptions with a machine readable code. ' +
  'For production use enable retries with exponential backoff and set a request timeout. ' +
  'See the reference section for the full list of configuration options.';
const nearDup = base.replace('an API key', 'a licence key').replace('the registry', 'npm');
const unrelated =
  'La pizzeria propone un menu stagionale con pizze classiche e speciali. ' +
  'La margherita ha pomodoro, mozzarella e basilico fresco. ' +
  'Le pizze bianche non hanno pomodoro e usano mozzarella di bufala. ' +
  'Il forno a legna raggiunge quattrocento gradi e cuoce ogni pizza in novanta secondi. ' +
  'Il locale apre tutte le sere tranne il martedì e accetta prenotazioni online.';

test('identical text → distance 0; deterministic across calls', () => {
  assert.equal(hamming(simhash(base), simhash(base)), 0);
  assert.deepEqual(simhash(base), simhash(base));
});

test('small edit stays near; unrelated text is far; near < unrelated', () => {
  const dNear = hamming(simhash(base), simhash(nearDup));
  const dFar = hamming(simhash(base), simhash(unrelated));
  assert.ok(dNear > 0 && dNear <= 8, `near-dup distance ${dNear} should be small (>0, ≤8)`);
  assert.ok(dFar >= 16, `unrelated distance ${dFar} should be large (≥16)`);
  assert.ok(dNear < dFar);
});

test('hamming is symmetric and bounded to 0..64', () => {
  const a = simhash(base);
  const b = simhash(unrelated);
  assert.equal(hamming(a, b), hamming(b, a));
  assert.ok(hamming(a, b) <= 64);
});

test('isNearDup applies the threshold', () => {
  const a = simhash(base);
  assert.equal(isNearDup(a, simhash(nearDup), 8), true);
  assert.equal(isNearDup(a, simhash(unrelated), 8), false);
});

test('short texts fall back to unigrams without throwing', () => {
  assert.equal(hamming(simhash('hello'), simhash('hello')), 0);
  assert.ok(hamming(simhash(''), simhash('x y')) >= 0);
});
