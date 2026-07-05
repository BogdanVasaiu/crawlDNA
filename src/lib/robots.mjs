// #14 — politeness, OPT-IN (the tool stays user-directed, like wget):
//   - a minimum per-HOST gap between requests (`delay`), reserved-slot style so
//     concurrent workers queue behind each other instead of bursting;
//   - robots.txt reading (`respectRobots`): Disallow/Allow with Google's
//     longest-match semantics plus Crawl-delay. Disallowed URLs are SKIPPED WITH
//     A WARNING — never silently (the warning is the contract).
// Both are off by default: existing behaviour is byte-identical until the user
// asks. Pure parsing lives here (offline-testable); fetching the file is the
// caller's job (one request per origin, cached for the run).

/**
 * Parse robots.txt and return the rule group that applies to `ua`.
 * Group selection follows the standard: the MOST SPECIFIC matching User-agent
 * token wins (longest token contained in our UA); `*` is the fallback.
 *
 * @param {string} text  the robots.txt body
 * @param {string} [ua]  our user-agent product token
 * @returns {{ rules: Array<{type:'allow'|'disallow', path:string}>, crawlDelay: number|null }}
 */
export function parseRobots(text, ua = 'crawldna') {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      // consecutive User-agent lines share one group; a rule line closes it
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], crawlDelay: null };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue; // rules before any User-agent line are invalid — ignored
    if (key === 'disallow' || key === 'allow') cur.rules.push({ type: key, path: value });
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) cur.crawlDelay = n;
    }
  }

  const uaLC = String(ua || '').toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === '*') {
        if (bestLen < 0) best = g; // fallback only when nothing specific matched
      } else if (uaLC.includes(a) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }
  return best ? { rules: best.rules, crawlDelay: best.crawlDelay } : { rules: [], crawlDelay: null };
}

/** Does a single robots path rule (with `*` wildcards and a `$` end anchor)
 *  match this URL path? An empty rule path matches nothing (per the spec,
 *  "Disallow:" with no value allows everything). */
function ruleMatches(rulePath, path) {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = body
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp('^' + re + (anchored ? '$' : '')).test(path);
}

/**
 * Is this URL path allowed by the parsed rules? Google semantics: the matching
 * rule with the LONGEST path wins; on a tie, Allow beats Disallow; no matching
 * rule = allowed.
 *
 * @param {Array<{type:string, path:string}>} rules  from parseRobots().rules
 * @param {string} path  the URL's pathname + search
 */
export function isAllowed(rules, path) {
  let best = null;
  for (const r of rules || []) {
    if (!r.path || !ruleMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow')) {
      best = r;
    }
  }
  return !best || best.type === 'allow';
}

/**
 * Per-host request pacer. `wait(url, delayMs)` resolves when this request may
 * start, reserving the NEXT slot `delayMs` later — so N concurrent workers
 * hitting one host space out at exactly one request per delay, while different
 * hosts never wait on each other. delayMs ≤ 0 = no-op (the default-off path
 * costs nothing).
 */
export function createHostGate() {
  const nextAt = new Map(); // host → earliest ms timestamp the next request may start
  return {
    async wait(url, delayMs) {
      if (!(delayMs > 0)) return;
      let host;
      try {
        host = new URL(url).host;
      } catch {
        return;
      }
      const now = Date.now();
      const at = Math.max(now, nextAt.get(host) || 0);
      nextAt.set(host, at + delayMs);
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
    },
  };
}
