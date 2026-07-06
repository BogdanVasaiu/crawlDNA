// #6 — incremental re-crawl: decide which baseline pages are still FRESH.
//
// The crawl itself is unchanged; this module only partitions a prior run's pages
// into "reuse as-is" vs "re-crawl", using the site's CURRENT sitemap <lastmod>.
// It is deliberately pure (no I/O) so the safety-critical decision is unit-tested.

import { normalizeUrl } from './url.mjs';

/**
 * Partition baseline pages by freshness against the current sitemap lastmods.
 *
 * CONSERVATIVE BY CONSTRUCTION (rule #1 — never lose content): a page is REUSED
 * only on positive evidence that it is unchanged — the stored lastmod and the
 * current lastmod are BOTH present and EQUAL. Every uncertain case (either side
 * missing/blank, or the URL absent from the current sitemap) goes to `recrawl`,
 * so a page that actually changed can never be skipped.
 *
 * @param {Array<{page:object, links?:string[]}>} baselineRecords journal records from the baseline run
 * @param {Map<string,string>} currentLastmod normalizedUrl -> current <lastmod>
 * @returns {{ reuse: Array, recrawl: Array }}
 */
export function planIncremental(baselineRecords, currentLastmod) {
  const map = currentLastmod instanceof Map ? currentLastmod : new Map();
  const reuse = [];
  const recrawl = [];
  for (const rec of baselineRecords || []) {
    const page = rec && rec.page;
    if (!page || !page.url) continue;
    const stored = page.meta && page.meta.lastmod;
    const current = map.get(normalizeUrl(page.url) || page.url);
    if (stored && current && String(stored) === String(current)) reuse.push(rec);
    else recrawl.push(rec);
  }
  return { reuse, recrawl };
}
