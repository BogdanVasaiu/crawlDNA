// Faithfulness verification for reshape output (#11). The reshape step is the ONLY
// place the AI may reformat content — and therefore the only place it could ALTER or
// INVENT a value. The prompt already demands "value-faithful", but a prompt is a
// request, not a guarantee (observed live: asked for v-alert props past the context
// budget, the model fabricated a plausible props table from its own memory — e.g. a
// `'Close'` default where the crawled docs say `'$vuetify.close'` — with no warning).
//
// This module is the deterministic enforcement: extract the VALUE-LIKE atoms from a
// produced file (numbers, URLs, inline code, quoted literals, code lines — the things
// the reshape contract says must be copied exactly) and check that each one exists in
// the crawled sources. Anything that doesn't is reported so the caller can FLAG it
// instead of serving it silently. RAGAS-faithfulness, done dependency-free at home.
//
// Honest limits: matching is by normalised substring, deliberately GENEROUS — a value
// that appears anywhere in the sources passes, so common words pass trivially and a
// lucky guess can pass too. What it reliably catches is the dangerous case: specific
// values (defaults, prices, URLs, code) that exist nowhere in the extraction.

/** Lowercase + collapse whitespace: matching must not fail on wrapping/indentation. */
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
const CODESPAN_RE = /`([^`\n]+)`/g;
const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;
const SINGLE_QUOTED_RE = /'([^'\n]{2,80})'/g;
const DOUBLE_QUOTED_RE = /"([^"\n]{2,80})"/g;
// currency/percent/decimal numbers, or integers of 2+ digits (a lone "3" is noise)
const NUM_RE = /[€$£]\s?\d[\d.,]*|\d[\d.,]*\s?%|\b\d+(?:[.,]\d+)+\b|\b\d{2,}\b/g;

const wordsIn = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/**
 * Extract the verifiable, value-like atoms of a Markdown document:
 *   - `code-line` — each substantive line of a fenced code block (invented examples
 *     are caught line by line);
 *   - `code`      — inline code spans (prop names, defaults, commands);
 *   - `url`       — absolute links;
 *   - `string`    — short quoted literals ('$vuetify.close', "elevated");
 *   - `number`    — prices/percentages/decimals/multi-digit integers.
 * Prose is deliberately NOT extracted: the reshape contract allows rephrasing layout,
 * only VALUES must survive verbatim.
 *
 * @returns {Array<{ value:string, kind:string }>} deduplicated by normalised value
 */
export function extractAtoms(markdown) {
  let text = String(markdown || '');
  const atoms = [];
  const push = (value, kind) => atoms.push({ value: value.trim(), kind });

  // fenced code first (then removed, so its content isn't re-matched as prose)
  text = text.replace(FENCE_RE, (_m, body) => {
    for (const line of String(body).split('\n')) {
      const t = line.trim();
      if (t.length >= 10 && /[a-z0-9]/i.test(t)) push(t, 'code-line');
    }
    return ' ';
  });
  text = text.replace(CODESPAN_RE, (_m, body) => {
    if (body.trim().length >= 2 && body.length <= 120) push(body, 'code');
    return ' ';
  });
  text = text.replace(URL_RE, (m) => {
    push(m.replace(/[.,;:!?]+$/, ''), 'url');
    return ' ';
  });
  for (const re of [SINGLE_QUOTED_RE, DOUBLE_QUOTED_RE]) {
    text = text.replace(re, (_m, body) => {
      if (wordsIn(body) <= 4) push(body, 'string');
      return ' ';
    });
  }
  // strip residual markdown structure so list markers/tables don't fabricate numbers
  text = text.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]/gm, ' ').replace(/^[ \t]*\|[\s:|-]*\|?[ \t]*$/gm, ' ');
  for (const m of text.match(NUM_RE) || []) push(m, 'number');

  const seen = new Set();
  return atoms.filter((a) => {
    const k = norm(a.value);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A value that IS a number, however it was extracted — a `1,299` in a code span or
 *  table cell deserves the same separator-insensitive matching as a bare number. */
const isNumericish = (atom, n) => atom.kind === 'number' || /^[€$£]?\s?\d[\d.,]*\s?%?$/.test(n);

/** Matching variants for an atom: normalised form; a Markdown-unescaped form (a model
 *  writing a table escapes pipes — `string \| number` must match the source's
 *  `string | number`); separator-insensitive digit forms for numbers ("1,299" must
 *  match "1299" and vice versa). Generous by design. */
function variantsOf(atom) {
  const n = norm(atom.value);
  const v = [n];
  const unescaped = n.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1');
  if (unescaped !== n) v.push(unescaped);
  if (isNumericish(atom, n)) {
    const digits = n.replace(/[^\d]/g, '');
    if (digits && digits !== n) v.push(digits);
  }
  return v;
}

/**
 * Verify a produced document's value-like atoms against the crawled sources.
 *
 * @param {string} markdown          the produced file's content
 * @param {string[]} sources         FULL source documents (not the model's context —
 *                                   a value anywhere in the extraction is faithful)
 * @param {{ allow?: string }} [o]   extra acceptable text: the user's own instruction
 *                                   (values THEY typed — a date, a filename — are not
 *                                   inventions even when absent from the sources)
 * @returns {{ total:number, verified:number, unverified:string[], ratio:number }}
 */
export function verifyValues(markdown, sources, { allow = '' } = {}) {
  const atoms = extractAtoms(markdown);
  if (!atoms.length) return { total: 0, verified: 0, unverified: [], ratio: 1 };

  const hay = norm((sources || []).join('\n'));
  const hayDigits = hay.replace(/[^\da-z]/g, ''); // separator-insensitive number lane
  const allowN = norm(allow);

  const unverified = [];
  let verified = 0;
  for (const atom of atoms) {
    const numeric = isNumericish(atom, norm(atom.value));
    const ok = variantsOf(atom).some(
      (v) => hay.includes(v) || (allowN && allowN.includes(v)) || (numeric && hayDigits.includes(v.replace(/[^\d]/g, ''))),
    );
    if (ok) verified++;
    else unverified.push(atom.value);
  }
  return { total: atoms.length, verified, unverified, ratio: verified / atoms.length };
}

/**
 * The warning block prepended to a produced file that failed verification — clearly
 * tool-generated (blockquote, named), so it can't be mistaken for model output and
 * can be stripped mechanically (see FIDELITY_BANNER_RE).
 */
export function fidelityBanner(f) {
  const shown = f.unverified
    .slice(0, 10)
    .map((v) => '`' + String(v).replace(/`/g, '´') + '`')
    .join(', ');
  const more = f.unverified.length > 10 ? ` (+${f.unverified.length - 10} more)` : '';
  const head =
    f.total > 0 && f.verified / f.total < 0.5
      ? `most of this file (${f.unverified.length} of ${f.total} checked values) could NOT be found in the crawled sources`
      : `${f.unverified.length} of ${f.total} checked value(s) were not found in the crawled sources`;
  return (
    `> ⚠️ **Fidelity check (crawldna):** ${head} — the model may have invented them: ${shown}${more}.\n` +
    `> Do not trust these values without checking the original extraction.`
  );
}

/** Matches a fidelity banner at the start of a file (through its trailing blank line). */
export const FIDELITY_BANNER_RE = /^> ⚠️ \*\*Fidelity check \(crawldna\):\*\*[^\n]*\n> [^\n]*\n\n/;

/** Remove a leading fidelity banner, e.g. before re-feeding a produced file to the
 *  model as context (the warning is for the USER, not content to iterate on). */
export function stripFidelityBanner(text) {
  return String(text || '').replace(FIDELITY_BANNER_RE, '');
}
