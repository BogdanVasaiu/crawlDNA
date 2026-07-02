// The measurement primitives for step #12 of TODO.md — the "measurement harness".
//
// These turn the project's promises ("nothing hidden is missed", "the output is
// all-and-only what the task asked", "here is where the tokens go") into NUMBERS you
// can put side by side BEFORE and AFTER a change, instead of trusting an estimate.
//
// Every function here is PURE and DEPENDENCY-FREE (only the project's own url helper),
// so it is deterministic and verifiable offline — no model, no browser. The parts that
// actually run a crawl live in the runner (scripts/eval.mjs); THIS file only scores an
// output that already exists.
//
// The honest limits, kept front-of-mind (see TODO.md §"Previsioni oneste"):
//   - Absolute completeness is NOT provable from a single crawl (academic result). What
//     we CAN measure are PROXIES: did KNOWN hidden content survive (revealCoverage), and
//     how much of the sitemap did we keep (sitemapCoverage).
//   - "Task respect" is scored SWDE-style against a GOLDEN SET the user supplies: recall
//     = the expected things are present, precision = the known-irrelevant things are not.
//     It measures the crawl against a ground truth; it cannot invent one.

import { normalizeUrl } from '../lib/url.mjs';

/** Lowercase + collapse all whitespace to single spaces + trim — so a substring check
 *  ignores incidental formatting (line wraps, indentation, doubled spaces). */
export function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Canonical form of a URL for set comparison; falls back to a trimmed lowercase string
 *  when it cannot be parsed, so a comparison never silently drops an entry. */
function canonUrl(u) {
  return normalizeUrl(u) || String(u || '').trim().toLowerCase();
}

/** Round to `d` decimals for stable, readable ratios. */
function round(n, d = 3) {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
}

/**
 * (a)(i) REVEAL COMPLETENESS — did the interaction-hidden content survive into the
 * output? Each `expected` string is a snippet that a human confirmed is present on the
 * page ONLY after a click (a tab's body, an accordion's text, a "load more" item). If it
 * appears in the crawl output, the reveal engine did its job for that snippet.
 *
 * @param {string} outputText  the crawl's Markdown (the whole scan, concatenated)
 * @param {string[]} expected  snippets that must appear iff reveal worked
 * @returns {{ total:number, found:number, missing:string[], ratio:number }}
 */
export function revealCoverage(outputText, expected = []) {
  const hay = normalizeText(outputText);
  const list = (expected || []).map((s) => String(s || '')).filter((s) => s.trim());
  const missing = list.filter((s) => !hay.includes(normalizeText(s)));
  const found = list.length - missing.length;
  return { total: list.length, found, missing, ratio: list.length ? round(found / list.length) : 1 };
}

/**
 * (a)(ii) PAGE COMPLETENESS — sitemap-coverage proxy. Of the URLs the site advertises in
 * its sitemap, how many did the crawl keep? This is a PROXY (a crawl can legitimately
 * skip off-task sitemap URLs, and can legitimately find pages NOT in the sitemap), so
 * `missing` and `extra` are reported for inspection rather than as pass/fail.
 *
 * @param {string[]} keptUrls     URLs the crawl produced (scan.pages[].url)
 * @param {string[]} sitemapUrls  URLs from the site's sitemap(s)
 * @returns {{ total:number, covered:number, missing:string[], extra:string[], ratio:number }}
 */
export function sitemapCoverage(keptUrls = [], sitemapUrls = []) {
  const kept = new Set((keptUrls || []).map(canonUrl));
  const sm = [...new Set((sitemapUrls || []).map(canonUrl))];
  const smSet = new Set(sm);
  const missing = sm.filter((u) => !kept.has(u));
  const covered = sm.length - missing.length;
  const extra = [...kept].filter((u) => !smSet.has(u));
  return { total: sm.length, covered, missing, extra, ratio: sm.length ? round(covered / sm.length) : 1 };
}

/**
 * (b) TASK RESPECT — "all-and-only", scored SWDE-style against a golden set:
 *   - RECALL    = fraction of `mustInclude` snippets present  → did we keep everything
 *                 the task asked for? (a missing one = lost content).
 *   - PRECISION = fraction of `mustExclude` snippets ABSENT   → did we drop the
 *                 off-task/boilerplate the task did NOT ask for? (a present one = leaked
 *                 chrome). Precision here is a PROXY: it can only see the known-bad
 *                 markers the golden set lists, not every possible piece of junk.
 * F1 is reported only when both lists are non-empty.
 *
 * @param {string} outputText
 * @param {{ mustInclude?:string[], mustExclude?:string[] }} golden
 */
export function taskRespect(outputText, { mustInclude = [], mustExclude = [] } = {}) {
  const hay = normalizeText(outputText);
  const inc = (mustInclude || []).map((s) => String(s || '')).filter((s) => s.trim());
  const exc = (mustExclude || []).map((s) => String(s || '')).filter((s) => s.trim());

  const missing = inc.filter((s) => !hay.includes(normalizeText(s))); // asked-for but absent
  const leaked = exc.filter((s) => hay.includes(normalizeText(s))); // off-task but present

  const recall = inc.length ? round((inc.length - missing.length) / inc.length) : null;
  const precision = exc.length ? round((exc.length - leaked.length) / exc.length) : null;
  const f1 =
    recall != null && precision != null && recall + precision > 0
      ? round((2 * recall * precision) / (recall + precision))
      : null;

  return {
    recall,
    precision,
    f1,
    includeTotal: inc.length,
    includeFound: inc.length - missing.length,
    missing,
    excludeTotal: exc.length,
    leaked,
  };
}

/**
 * (a)(ii) RUN DIFF — compare two runs of the same site (e.g. before vs after a change,
 * or re-crawl freshness). Pages are matched by canonical URL; a page present in both with
 * a different byte size is "changed".
 *
 * @param {Array<{url:string, bytes?:number}>} a  the baseline run's pages
 * @param {Array<{url:string, bytes?:number}>} b  the new run's pages
 */
export function diffRuns(a = [], b = []) {
  const toMap = (pages) => {
    const m = new Map();
    for (const p of pages || []) {
      const u = canonUrl(p && p.url);
      if (!u) continue;
      m.set(u, Number((p && p.bytes) || 0));
    }
    return m;
  };
  const A = toMap(a);
  const B = toMap(b);

  const added = [...B.keys()].filter((u) => !A.has(u));
  const removed = [...A.keys()].filter((u) => !B.has(u));
  const changed = [];
  for (const [u, bytesA] of A) {
    if (!B.has(u)) continue;
    const bytesB = B.get(u);
    if (bytesA !== bytesB) changed.push({ url: u, fromBytes: bytesA, toBytes: bytesB, delta: bytesB - bytesA });
  }
  const sum = (m) => [...m.values()].reduce((n, v) => n + v, 0);
  return {
    added,
    removed,
    changed,
    pagesA: A.size,
    pagesB: B.size,
    bytesA: sum(A),
    bytesB: sum(B),
    bytesDelta: sum(B) - sum(A),
  };
}

/**
 * (c) TOKENS PER CALL TYPE — turn the metered `tokens.byKind` into a ranked table so you
 * can see WHERE the tokens actually go (reveal vs scope vs links vs nav-plan), not just
 * the grand total. Each row's `total` is input+output; `share` is its fraction of the
 * grand total. Rows are sorted biggest-first.
 *
 * @param {{ calls?:number, inputTokens?:number, outputTokens?:number, byKind?:object }} tokens
 */
export function tokenBreakdown(tokens = {}) {
  const byKind = (tokens && tokens.byKind) || {};
  const rows = Object.entries(byKind).map(([kind, k]) => {
    const input = Number(k.inputTokens || 0);
    const output = Number(k.outputTokens || 0);
    return {
      kind,
      calls: Number(k.calls || 0),
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: Number(k.cachedInputTokens || 0),
      total: input + output,
    };
  });
  const grand = rows.reduce((n, r) => n + r.total, 0);
  for (const r of rows) r.share = grand ? round(r.total / grand) : 0;
  rows.sort((x, y) => y.total - x.total);

  const totalInput = Number(tokens.inputTokens || 0);
  const totalOutput = Number(tokens.outputTokens || 0);
  const totalCached = Number(tokens.cachedInputTokens || 0);
  return {
    total: {
      calls: Number(tokens.calls || 0),
      inputTokens: totalInput,
      outputTokens: totalOutput,
      // #4: the slice of input served from the provider's prompt cache (~10× cheaper);
      // cachedShare is its fraction of ALL input — the number that should GROW after
      // the first calls of each kind when prefix caching is working.
      cachedInputTokens: totalCached,
      cachedShare: totalInput ? round(totalCached / totalInput) : 0,
      total: totalInput + totalOutput,
    },
    rows,
  };
}
