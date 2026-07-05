// Fidelity verification (#11): value-like atoms of a produced file must exist in the
// crawled sources; inventions are reported, prose rephrasing is not policed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAtoms, verifyValues, fidelityBanner, stripFidelityBanner } from '../src/lib/faithful.mjs';

const SOURCE =
  '# Alerts\n\n' +
  "The close-label prop defaults to `'$vuetify.close'` and can be customised.\n" +
  'A pizza margherita costs €12,50. Details at https://ex.com/docs/alerts.\n' +
  '`elevation` accepts numbers. The build is 1299 bytes.\n\n' +
  '```sh\nnpm install vuetify\n```\n';

test('extractAtoms finds the value-like atoms only (no prose)', () => {
  const atoms = extractAtoms(
    'Some prose that could be rephrased freely.\n\n' +
      "Default is `'$vuetify.close'`, price €12,50, see https://ex.com/x.\n\n" +
      '```js\nconst a = someFunction(42);\n```\n',
  );
  const kinds = new Set(atoms.map((a) => a.kind));
  assert.ok(kinds.has('code') && kinds.has('number') && kinds.has('url') && kinds.has('code-line'));
  assert.ok(!atoms.some((a) => a.value.includes('rephrased')), 'prose is not extracted');
});

test('faithful output verifies clean (0 unverified)', () => {
  const out =
    '| Prop | Default |\n| --- | --- |\n' +
    "| `close-label` | `'$vuetify.close'` |\n\n" +
    'Costs €12,50 — see https://ex.com/docs/alerts.\n\n```sh\nnpm install vuetify\n```\n';
  const r = verifyValues(out, [SOURCE]);
  assert.deepEqual(r.unverified, []);
  assert.equal(r.ratio, 1);
});

test("invented values are flagged (the live 'Close' vs '$vuetify.close' case)", () => {
  const out =
    "| `close-label` | `'Close'` |\n| `variant` | `'elevated'` |\n\n" +
    'See https://fake.example/alerts. Weighs 9999 bytes.\n\n' +
    '```js\nimport { VAlert } from "vuetify/components"\n```\n';
  const r = verifyValues(out, [SOURCE]);
  assert.ok(r.unverified.includes("'Close'"), 'the invented default must be flagged');
  assert.ok(r.unverified.includes('https://fake.example/alerts'));
  assert.ok(r.unverified.includes('9999'));
  assert.ok(r.unverified.some((v) => v.includes('import { VAlert }')), 'invented code lines are flagged');
  assert.ok(r.verified >= 1, '`close-label` itself exists in the source');
});

test('values the USER typed are not inventions (allow = the instruction)', () => {
  const out = 'Events filtered for settembre 2026: none found in the sources.';
  const r = verifyValues(out, [SOURCE], { allow: 'estrai gli eventi di settembre 2026' });
  assert.deepEqual(r.unverified, []);
});

test('markdown-escaped values match their plain source form (the live `\\|` case)', () => {
  // a model writing a table escapes pipes: `string \| number` must match "string | number"
  const out = "| `border` | `string \\| number \\| boolean` | `'default' \\| 'compact'` |";
  const r = verifyValues(out, ["border accepts string | number | boolean, density 'default' | 'compact'"]);
  assert.deepEqual(r.unverified, []);
});

test('number matching is separator-insensitive both ways', () => {
  assert.equal(verifyValues('Size: `1,299`', [SOURCE]).unverified.length, 0, '1,299 matches source 1299');
  assert.equal(verifyValues('Price €12,50', ['costs 1250 cents… no euro sign anywhere 12,50']).unverified.length, 0);
});

test('prose-only output checks nothing and passes', () => {
  const r = verifyValues('A short conversational answer with no values at all.', [SOURCE]);
  assert.equal(r.total, 0);
  assert.equal(r.ratio, 1);
});

test('banner renders and strips mechanically', () => {
  const v = verifyValues("`'Close'` and 9999", [SOURCE]);
  const banner = fidelityBanner(v);
  assert.ok(banner.startsWith('> ⚠️ **Fidelity check (crawldna):**'));
  const flagged = banner + '\n\n' + 'real content';
  assert.equal(stripFidelityBanner(flagged), 'real content');
  assert.equal(stripFidelityBanner('no banner here'), 'no banner here');
});
