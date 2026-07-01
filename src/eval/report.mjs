// Assemble the individual metrics (metrics.mjs) into ONE report for a crawl result,
// and render it as a readable before/after table. Pure: it scores a result + a golden
// spec that already exist; the runner (scripts/eval.mjs) is what produces them.
//
// A "golden spec" is the ground truth for one site, supplied by the user (see
// eval/README.md):
//   { name, url, task,
//     expect: { revealContent?: string[], mustInclude?: string[],
//               mustExclude?: string[], sitemapUrls?: string[] } }

import { revealCoverage, sitemapCoverage, taskRespect, diffRuns, tokenBreakdown } from './metrics.mjs';

/** Concatenate a scan's output into one text blob to score against. Prefers the
 *  consolidated output files; falls back to the raw page Markdown. */
function scanText(scan) {
  const files = (scan.files || []).map((f) => f.markdown || '').filter(Boolean);
  if (files.length) return files.join('\n\n');
  return (scan.pages || []).map((p) => p.markdown || '').filter(Boolean).join('\n\n');
}

/** Every kept page across all scans, as { url, bytes } — for coverage + diff. */
function keptPages(result) {
  const out = [];
  for (const scan of result.scans || []) {
    for (const p of scan.pages || []) {
      out.push({ url: p.url, bytes: (p.meta && p.meta.bytes) || 0 });
    }
  }
  return out;
}

/**
 * Score a finished crawl against a golden spec.
 *
 * @param {object} a
 * @param {import('../index.mjs').Result|any} a.result  the crawlDocs result
 * @param {object} a.spec                    the golden spec ({ name, url, task, expect })
 * @param {string[]} [a.sitemapUrls]         sitemap URLs (from the spec or fetched live)
 * @param {Array<{url,bytes}>} [a.baselinePages]  a previous run's pages, for a diff
 * @returns {object} a structured report (feed to formatReport)
 */
export function evaluate({ result, spec = {}, sitemapUrls = null, baselinePages = null }) {
  const expect = spec.expect || {};
  const text = (result.scans || []).map(scanText).filter(Boolean).join('\n\n');
  const pages = keptPages(result);
  const sm = Array.isArray(sitemapUrls) ? sitemapUrls : Array.isArray(expect.sitemapUrls) ? expect.sitemapUrls : null;

  const report = {
    name: spec.name || spec.url || '(unnamed)',
    url: spec.url || '',
    task: spec.task || '',
    pages: pages.length,
    durationMs: (result.stats && result.stats.durationMs) || 0,
    reveal: expect.revealContent && expect.revealContent.length ? revealCoverage(text, expect.revealContent) : null,
    task_respect:
      (expect.mustInclude && expect.mustInclude.length) || (expect.mustExclude && expect.mustExclude.length)
        ? taskRespect(text, expect)
        : null,
    sitemap: sm ? sitemapCoverage(pages.map((p) => p.url), sm) : null,
    diff: baselinePages ? diffRuns(baselinePages, pages) : null,
    tokens: tokenBreakdown((result.stats && result.stats.tokens) || {}),
    warnings: (result.warnings || []).length,
  };
  return report;
}

const pct = (r) => (r == null ? ' n/a' : `${(r * 100).toFixed(1)}%`);
const bar = (r) => {
  if (r == null) return '';
  const n = Math.round(Math.max(0, Math.min(1, r)) * 20);
  return '[' + '#'.repeat(n) + '-'.repeat(20 - n) + ']';
};

/** Render a report (from {@link evaluate}) as a readable text block. */
export function formatReport(report) {
  const L = [];
  L.push(`━━ ${report.name} ━━`);
  L.push(`  task:   ${report.task}`);
  L.push(`  url:    ${report.url}`);
  L.push(`  pages:  ${report.pages} kept · ${report.durationMs} ms · ${report.warnings} warning(s)`);
  L.push('');

  // (a)(i) reveal completeness
  if (report.reveal) {
    const r = report.reveal;
    L.push(`(a) reveal completeness   ${bar(r.ratio)} ${pct(r.ratio)}  (${r.found}/${r.total} hidden snippets present)`);
    if (r.missing.length) for (const m of r.missing) L.push(`      MISSING: ${JSON.stringify(m.slice(0, 80))}`);
  }

  // (a)(ii) sitemap coverage
  if (report.sitemap) {
    const s = report.sitemap;
    L.push(`(a) sitemap coverage      ${bar(s.ratio)} ${pct(s.ratio)}  (${s.covered}/${s.total} sitemap URLs kept · ${s.extra.length} beyond sitemap)`);
    if (s.missing.length) L.push(`      ${s.missing.length} sitemap URL(s) not kept (proxy — some may be legitimately off-task)`);
  }

  // (b) task respect
  if (report.task_respect) {
    const t = report.task_respect;
    if (t.recall != null) {
      L.push(`(b) task recall           ${bar(t.recall)} ${pct(t.recall)}  (${t.includeFound}/${t.includeTotal} expected present)`);
      for (const m of t.missing) L.push(`      MISSING: ${JSON.stringify(m.slice(0, 80))}`);
    }
    if (t.precision != null) {
      L.push(`(b) task precision        ${bar(t.precision)} ${pct(t.precision)}  (${t.excludeTotal - t.leaked.length}/${t.excludeTotal} off-task absent)`);
      for (const m of t.leaked) L.push(`      LEAKED:  ${JSON.stringify(m.slice(0, 80))}`);
    }
    if (t.f1 != null) L.push(`(b) task F1               ${bar(t.f1)} ${pct(t.f1)}`);
  }

  // run diff
  if (report.diff) {
    const d = report.diff;
    L.push(
      `    run diff vs baseline  +${d.added.length} added · -${d.removed.length} removed · ~${d.changed.length} changed · ` +
        `${d.bytesDelta >= 0 ? '+' : ''}${d.bytesDelta} bytes`,
    );
  }

  // (c) tokens per call type
  L.push('');
  const tk = report.tokens;
  L.push(`(c) tokens: ${tk.total.total.toLocaleString()} total (${tk.total.inputTokens.toLocaleString()} in · ${tk.total.outputTokens.toLocaleString()} out · ${tk.total.calls} calls)`);
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  L.push(`      ${pad('kind', 10)} ${padL('calls', 6)} ${padL('in', 9)} ${padL('out', 9)} ${padL('total', 10)} ${padL('share', 7)}`);
  for (const r of tk.rows) {
    L.push(
      `      ${pad(r.kind, 10)} ${padL(r.calls, 6)} ${padL(r.inputTokens.toLocaleString(), 9)} ` +
        `${padL(r.outputTokens.toLocaleString(), 9)} ${padL(r.total.toLocaleString(), 10)} ${padL(pct(r.share), 7)}`,
    );
  }
  return L.join('\n');
}
