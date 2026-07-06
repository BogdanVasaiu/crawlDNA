// Tier 2 of the documentation profile: sitemap enumeration.
//
// Follows sitemap indexes recursively, collects every <loc>, and also reads
// Sitemap: directives from robots.txt. Filtering to the docs section is done by
// the caller (it knows the base path).

import { fetchText } from '../../lib/fetcher.mjs';
import { XMLParser } from 'fast-xml-parser';
import { originOf, normalizeUrl } from '../../lib/url.mjs';

function toArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Pull { url, lastmod } from a parsed <urlset> (fast-xml-parser output). Pure — no
 * network — so the #6 lastmod extraction is unit-testable. `lastmod` is '' when the
 * entry omits it.
 * @param {object} xml parsed sitemap XML
 * @returns {Array<{url:string,lastmod:string}>}
 */
export function sitemapEntriesFromXml(xml) {
  const out = [];
  for (const u of toArray(xml && xml.urlset && xml.urlset.url)) {
    if (u && u.loc) out.push({ url: String(u.loc).trim(), lastmod: u.lastmod != null ? String(u.lastmod).trim() : '' });
  }
  return out;
}

/**
 * Collect { url, lastmod } for every page reachable from a site's sitemaps.
 * Follows sitemap indexes recursively; the first lastmod seen for a URL wins.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {() => boolean} [opts.shouldStop]
 * @param {number} [opts.maxDepth] sitemap-index recursion depth
 * @returns {Promise<Array<{url:string,lastmod:string}>>}
 */
export async function collectSitemapEntries(baseUrl, { shouldStop, maxDepth = 4 } = {}) {
  const origin = originOf(baseUrl);
  if (!origin) return [];

  const candidates = [
    origin + '/sitemap.xml',
    origin + '/sitemap_index.xml',
    origin + '/sitemap-index.xml',
  ];

  // robots.txt may advertise sitemaps elsewhere.
  const robots = await fetchText(origin + '/robots.txt', { accept: 'text/plain, */*' });
  if (robots.ok && robots.text) {
    for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      candidates.push(m[1].trim());
    }
  }

  const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });
  const seen = new Set();
  const entries = new Map(); // url -> lastmod (first wins)

  async function walk(smUrl, depth) {
    if (depth > maxDepth || seen.has(smUrl)) return;
    if (shouldStop && shouldStop()) return;
    seen.add(smUrl);

    const res = await fetchText(smUrl, { accept: 'application/xml, text/xml, */*' });
    if (!res.ok || !res.text) return;

    let xml;
    try {
      xml = parser.parse(res.text);
    } catch {
      return;
    }

    if (xml.sitemapindex) {
      for (const sm of toArray(xml.sitemapindex.sitemap)) {
        if (sm && sm.loc) await walk(String(sm.loc).trim(), depth + 1);
      }
    } else if (xml.urlset) {
      for (const e of sitemapEntriesFromXml(xml)) {
        if (!entries.has(e.url)) entries.set(e.url, e.lastmod);
      }
    }
  }

  for (const c of [...new Set(candidates)]) {
    if (shouldStop && shouldStop()) break;
    await walk(c, 0);
  }

  return [...entries].map(([url, lastmod]) => ({ url, lastmod }));
}

/**
 * Collect all page URLs reachable from a site's sitemaps.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @returns {Promise<string[]>}
 */
export async function collectSitemapUrls(baseUrl, opts = {}) {
  return (await collectSitemapEntries(baseUrl, opts)).map((e) => e.url);
}

/**
 * #6 — a Map of normalizedUrl -> <lastmod> for a site's sitemap. Only URLs that
 * actually carry a lastmod are included (a blank one is no freshness evidence).
 * @param {string} baseUrl
 * @param {object} [opts]
 * @returns {Promise<Map<string,string>>}
 */
export async function sitemapLastmodMap(baseUrl, opts = {}) {
  const map = new Map();
  for (const e of await collectSitemapEntries(baseUrl, opts)) {
    if (e.lastmod) map.set(normalizeUrl(e.url) || e.url, e.lastmod);
  }
  return map;
}
