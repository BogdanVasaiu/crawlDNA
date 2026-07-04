// The general per-page engine (§3): browser-first render -> exhaustive reveal of
// hidden/dynamic content -> task-scoped verbatim extraction -> link discovery.
// Universal: no per-site logic. Whether the AI gates links / scopes sections is
// decided by the EXPLICIT `mode` option (#20, see lib/task.mjs modeBehavior):
// 'complete' keeps pages whole and follows all in-scope links (zero gate/scope
// calls); 'targeted' judges both; 'auto' (legacy) derives it from the task text.

import { isBrowserAvailable, newPage, browserError } from '../lib/browser.mjs';
import { loadHtml } from '../lib/fetcher.mjs';
import { extractMarkdown, splitBlocks, contentWordLen } from '../extract.mjs';
import { revealAll } from './reveal.mjs';
import { aiScopeContent, aiSelectLinks } from './decide.mjs';
import { modeBehavior } from '../lib/task.mjs';
import { normalizeUrl, inScope, resolveUrl } from '../lib/url.mjs';
import { taskTerms, scoreLink } from '../lib/relevance.mjs';
import { createScorer } from '../lib/semantic.mjs';
import { detectChallenge, challengeBackoffMs } from '../lib/challenge.mjs';
import { settle } from '../lib/settle.mjs';

/**
 * #22 — the per-scan relevance scorer: semantic (embeddings, multilingual) when
 * the user configured an `embedModel`, the lexical floor otherwise. One instance
 * per scan (its vector cache and one-time failure warning live there), shared by
 * the link gate ordering, the minRelevance pruning and the route budget.
 */
function scorerFor(ctx, task) {
  const host = ctx.currentScan || ctx;
  if (!host._scorer) {
    host._scorer = createScorer({
      llm: ctx.options.llm,
      task,
      onWarn: (message) => ctx.emit({ type: 'warn', reason: 'embed', message }),
    });
  }
  return host._scorer;
}

const now = () => new Date().toISOString();
const bytesOf = (s) => Buffer.byteLength(s || '', 'utf8');

/**
 * Decide which candidate links to follow, using AI relevance gating with a
 * per-scan cache (a link is judged once) and a completeness bias: on any model
 * failure we follow everything rather than risk dropping a page. The cache lives
 * on the current scan, not the run, so a link rejected for one link's task is
 * not wrongly skipped for another link with a different task.
 * (Exported for the test suite; the crawl only reaches it via crawlPageWithEngine.)
 */
export async function decideFollow(ctx, task, candidateObjs) {
  const cacheHost = ctx.currentScan || ctx;
  if (!cacheHost._followCache) cacheHost._followCache = new Map();
  const cache = cacheHost._followCache;
  // Task topic terms, computed once per scan (the task is fixed for a scan).
  if (!cacheHost._taskTerms) cacheHost._taskTerms = taskTerms(task);
  const terms = cacheHost._taskTerms;

  // Universal, task-driven relevance score per candidate (URL + label). Used to crawl
  // the most on-task links FIRST, and — only when asked — to prune clearly off-task ones
  // before the model. No per-site/URL-shape rule is involved; the task is the query.
  // #22: semantic (embeddings) when configured — an Italian task ranks German links —
  // lexical floor otherwise; either way the same [0,1] scores feed everything below.
  const scoreOf = await scorerFor(ctx, task).scoreAll(candidateObjs);

  // #20 — in 'complete' mode there IS no link gate: the user asked for everything,
  // so keep/drop has no meaning and every batch call would be a token spent to hear
  // "follow it". The candidates below are followed as-is (minRelevance, an explicit
  // opt-in, still prunes; best-first ordering still applies). 'auto'/'targeted'
  // keep the gate. The AI stays where it earns its cost: reveal + nav-plan.
  const gate = modeBehavior(ctx.options.mode, task).linkGate;

  const keep = [];
  const unknown = [];
  for (const c of candidateObjs) {
    if (cache.has(c.href)) {
      if (cache.get(c.href)) keep.push(c.href);
    } else {
      unknown.push(c);
    }
  }

  // FOCUSED MODE (opt-in via `minRelevance` > 0): drop clearly off-task links before the
  // model ever sees them — but ONLY when the task actually discriminates among THIS
  // page's links (at least one reaches the threshold), so a generic task can never nuke
  // everything. DEFAULT is minRelevance = 0 → prune nothing: precision/completeness
  // first; scoring then only reorders, never drops.
  const minRel = Number(ctx.options.minRelevance) || 0;
  let toJudge = unknown;
  if (minRel > 0 && terms.length && unknown.some((c) => scoreOf.get(c.href) >= minRel)) {
    toJudge = [];
    for (const c of unknown) {
      if (scoreOf.get(c.href) >= minRel) toJudge.push(c);
      else cache.set(c.href, false); // pruned as off-task; not re-judged this scan
    }
  }

  if (toJudge.length && !gate) {
    // Gate off (mode 'complete'): follow every remaining candidate, zero model calls.
    // Cached like a gate verdict so re-seen hrefs stay O(1).
    for (const c of toJudge) {
      cache.set(c.href, true);
      keep.push(c.href);
    }
  } else if (toJudge.length) {
    // Rank by relevance so the MOST on-task links are judged first. Then judge EVERY
    // candidate in batches of aiSelectLinks' cap (160): a page can carry more links than
    // one call fits, and a candidate the model never saw must not be recorded as
    // rejected — that would silently drop its page for the whole scan (rule #1).
    const ranked = [...toJudge].sort((a, b) => scoreOf.get(b.href) - scoreOf.get(a.href));
    for (let i = 0; i < ranked.length; i += 160) {
      const batch = ranked.slice(i, i + 160);
      let chosen;
      try {
        chosen = await aiSelectLinks({ llm: ctx.options.llm, task, links: batch });
      } catch {
        chosen = batch.map((c) => c.href); // completeness bias on failure
      }
      const chosenSet = new Set(chosen);
      for (const c of batch) {
        const follow = chosenSet.has(c.href);
        cache.set(c.href, follow);
        if (follow) keep.push(c.href);
      }
    }
  }

  // Best-first: hand the frontier this page's chosen links most-on-task FIRST, so an
  // early Stop (or a maxPages cap) keeps what the task cares about most.
  keep.sort((a, b) => (scoreOf.get(b) || 0) - (scoreOf.get(a) || 0));
  return keep;
}

/**
 * #16 — budget the SPECULATIVE JS-mined routes that reach the AI link gate.
 * perceive() mines up to 800 same-site paths per page from script/JSON blobs:
 * real router manifests mixed with build/chunk noise. They all pass scope, so
 * they all used to be judged by the model in batches of 160 — up to 5 extra
 * calls per page spent mostly on `/static/chunk-…`. Rank them by task
 * relevance (scoreLink — universal, task-driven, no URL-shape rules) and keep
 * only the top `maxRoutes`.
 *
 * Conservative by construction (rule #1): the cut happens ONLY when the scores
 * actually discriminate among the routes (min < max). A generic task scores
 * everything 1 and an off-vocabulary task scores everything 0 — no variance,
 * no cut, today's behaviour. Ties keep mined order (deterministic). DOM links
 * are NEVER budgeted — this touches only the speculative source, and a cut
 * route stays reachable via real links / sitemap on any later page.
 * Pure; exported for the test suite.
 *
 * #22: an optional `scoreOf` map (href → score, from the per-scan scorer) lets
 * the semantic tier feed the ranking; any href it misses — and every call
 * without the map — falls back to the lexical scoreLink, so the guard's
 * variance semantics are unchanged.
 *
 * @returns {{ routes: string[], cut: number }}
 */
export function budgetRoutes(routes, terms, maxRoutes, scoreOf = null) {
  const budget = Math.max(0, Math.floor(Number(maxRoutes) || 0));
  if (!budget || routes.length <= budget) return { routes, cut: 0 };
  const scored = routes.map((href, i) => ({
    href,
    i,
    score: scoreOf && scoreOf.has(href) ? scoreOf.get(href) : scoreLink(terms, { href }).score,
  }));
  let min = Infinity;
  let max = -Infinity;
  for (const s of scored) {
    if (s.score < min) min = s.score;
    if (s.score > max) max = s.score;
  }
  if (!(min < max)) return { routes, cut: 0 }; // nothing discriminates → cut nothing
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return { routes: scored.slice(0, budget).map((s) => s.href), cut: routes.length - budget };
}

/** Dedupe + keep only in-scope http(s) URLs. */
function inScopeUnique(urls, baseUrl, options) {
  const out = new Map();
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (!n) continue;
    if (!inScope(n, baseUrl, options)) continue;
    if (!out.has(n)) out.set(n, n);
  }
  return [...out.values()];
}

export async function crawlPageWithEngine(target, ctx) {
  const { url, task } = target;
  const browserMode = ctx.options.browser;

  if (browserMode === 'never' || !(await isBrowserAvailable())) {
    if (browserMode !== 'never' && !ctx._browserWarned) {
      ctx._browserWarned = true;
      ctx.emit({
        type: 'warn',
        url,
        reason: 'browser-missing',
        message:
          (browserError() || 'The engine needs a browser to render and reveal dynamic content.') +
          ' Falling back to static HTML — interaction-hidden content is likely missing; completeness is not guaranteed.',
      });
    }
    return staticFallback(target, ctx);
  }

  let pageCtx;
  try {
    pageCtx = await newPage();
  } catch (err) {
    if (!ctx._browserWarned) {
      ctx._browserWarned = true;
      ctx.emit({
        type: 'warn',
        url,
        reason: 'browser-missing',
        message:
          (browserError() || 'Browser launch failed: ' + (err && err.message)) +
          ' Falling back to static HTML.',
      });
    }
    return staticFallback(target, ctx);
  }

  const { page, release } = pageCtx;
  const popups = new Set();
  page.on('popup', (p) => {
    try {
      popups.add(p.url());
    } catch {
      /* ignore */
    }
    p.close().catch(() => {});
  });

  let revealed;
  let status = 0;
  let headers = {};
  let navFailed = false; // navigation itself failed (timeout / network) — retryable
  try {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      status = resp ? resp.status() : 0;
      if (resp) headers = resp.headers();
    } catch {
      navFailed = true; // fall through to whatever rendered
    }
    // Give a client-rendered app a chance to paint real content before we look.
    await page
      .waitForFunction(
        () => {
          const m = document.querySelector('main,article,[role=main]') || document.body;
          return m && (m.innerText || '').trim().length > 150;
        },
        { timeout: 6000 },
      )
      .catch(() => {});
    // Then wait for the load to actually FINISH via the response-quiet signal
    // (#15): network quiet for a grace window AND the text no longer changing.
    // `networkidle` sat here before and was a FIXED 8s tax on any site holding a
    // connection open (analytics, websocket, long-poll) — the idle never fires.
    // settle() counts response EVENTS, not open connections, so those sites exit
    // after one grace window; a real late cascade is still waited out. The same
    // 8s bound keeps the worst case from ever regressing, and settle's final
    // quiet+stable exit subsumes the flat 400ms that used to follow.
    await settle(page, { maxMs: 8000 });
    if (status >= 400) {
      ctx.emit({
        type: 'warn',
        url,
        reason: 'http-' + status,
        message: `Page returned HTTP ${status}; it may not exist or have moved. Trying to recover via site navigation.`,
      });
    }
    // #14 — anti-bot guard, ALWAYS on (a precision guard, not a courtesy): a
    // bot-defense challenge ("checking your browser", CAPTCHA wall — often HTTP
    // 200) must NEVER enter the output as content. Policy: loud `anti-bot`
    // warning, ONE retry after a backoff (honouring Retry-After), then a
    // declared skip. Never bypassed — challenges stay out of scope forever
    // (ARCHITECTURE §14): we signal, we don't break through.
    const probeChallenge = async () => {
      const html = await page.content().catch(() => '');
      const text = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
      return detectChallenge({ status, headers, html, contentLen: text.replace(/\s+/g, ' ').trim().length });
    };
    let det = await probeChallenge();
    if (det.challenge) {
      ctx.emit({
        type: 'warn',
        url,
        reason: 'anti-bot',
        message: `Bot-defense challenge detected (${det.signal}); retrying once after a pause.`,
      });
      await new Promise((r) => setTimeout(r, challengeBackoffMs(headers)));
      try {
        const resp2 = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        status = resp2 ? resp2.status() : status;
        headers = resp2 ? resp2.headers() : {};
      } catch {
        /* keep whatever loaded — the re-probe decides */
      }
      await settle(page, { maxMs: 8000 });
      det = await probeChallenge();
      if (det.challenge) {
        ctx.emit({
          type: 'warn',
          url,
          reason: 'anti-bot',
          message: `Still challenged after the retry (${det.signal}) — page skipped; its interstitial is NOT in the output.`,
        });
        return { page: null, links: [] }; // never kept, never bypassed
      }
    }
    revealed = await revealAll(page, ctx, url, task);
  } catch (err) {
    ctx.emit({ type: 'error', url, message: 'render failed: ' + (err && err.message) });
    return staticFallback(target, ctx); // `release()` runs in finally before we return
  } finally {
    await release(); // close the page and return the context to the pool for reuse
  }

  if (revealed.hitCap) {
    ctx.emit({
      type: 'warn',
      url,
      reason: 'max-actions',
      message: `Reached the per-page reveal cap (${Math.max(8, ctx.options.maxActions || 40)}); some hidden content may remain. Raise --max-actions for full coverage.`,
    });
  }

  let markdown = revealed.markdown;
  let title = revealed.title;
  let relevant = true;
  // Raw { text, provenance } blocks from the reveal — the spine the layout router
  // addresses by metadata (provenance/section/ordinal). Null for the static path.
  let blocks = Array.isArray(revealed.blocks) ? revealed.blocks : null;

  // Assemble candidate links: in-content + nav (button-revealed) + popups + JS routes.
  // Real destinations (DOM links, revealed nav, popups) are never capped; the
  // speculative JS-mined routes go through the #16 relevance budget first, and
  // ones already present as real links don't consume it.
  const realLinks = inScopeUnique(
    [...revealed.links.map((l) => l.href), ...revealed.navLinks, ...popups],
    url,
    ctx.options,
  );
  const realSet = new Set(realLinks);
  let routes = inScopeUnique(revealed.routes, url, ctx.options).filter((r) => !realSet.has(r));
  if (routes.length) {
    const cacheHost = ctx.currentScan || ctx;
    if (!cacheHost._taskTerms) cacheHost._taskTerms = taskTerms(task);
    // #22: rank the speculative routes with the same per-scan scorer as the link
    // gate (semantic when configured); the lexical floor keeps the conservative
    // no-variance-no-cut guard exactly as before. Scored ONLY when the budget
    // would actually cut — under-budget pages must not pay for embeddings.
    const overBudget = ctx.options.maxRoutes > 0 && routes.length > ctx.options.maxRoutes;
    const routeScores = overBudget ? await scorerFor(ctx, task).scoreAll(routes.map((href) => ({ href }))) : null;
    const budgeted = budgetRoutes(routes, cacheHost._taskTerms, ctx.options.maxRoutes, routeScores);
    if (budgeted.cut > 0) {
      ctx.emit({
        type: 'action',
        action: 'route-budget',
        url,
        detail: `${budgeted.routes.length}/${routes.length} mined routes sent to the link gate (ranked by task relevance)`,
      });
    }
    routes = budgeted.routes;
  }
  const candidates = [...realLinks, ...routes];
  const candidateObjs = candidates.map((href) => {
    const found = revealed.links.find((l) => normalizeUrl(l.href) === href);
    return { href, label: found ? found.label : '' };
  });

  // The navigation never loaded anything AND the page yielded neither content nor
  // links: a transient failure (timeout, connection reset), not an empty page.
  // Signal it so the frontier can retry the URL once instead of silently losing it.
  if (navFailed && !markdown && candidates.length === 0) {
    return { page: null, links: [], failed: true };
  }

  // Crawl-time scoping keeps only task-relevant SECTIONS, VERBATIM. Whether it
  // runs is decided by the EXPLICIT mode (#20): 'complete' keeps pages whole;
  // 'targeted' always scopes; 'auto' (legacy) scopes for non-doc tasks only.
  // This is the "stay focused" step — it drops off-task chrome (landing/footer/
  // pricing) but NEVER transforms content. All task-driven filtering / reshaping /
  // regrouping ("only the available slots", "prices as a table") is Phase 2 — the
  // user asks for it AFTER the crawl, over the saved files, via aiReshape
  // (see src/reshape.mjs). The crawl stays verbatim.
  if (markdown && modeBehavior(ctx.options.mode, task).scopeSections) {
    const scoped = await aiScopeContent({ llm: ctx.options.llm, task, title, markdown }).catch(() => null);
    if (scoped) {
      // Keep blocks in sync with the scoped markdown so reveal PROVENANCE survives
      // scoping: drop the blocks whose verbatim text the scope step removed.
      if (blocks && scoped.markdown !== markdown) {
        const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const kept = new Set(splitBlocks(scoped.markdown).map(norm));
        blocks = blocks.filter((b) => kept.has(norm(b.text)));
      }
      markdown = scoped.markdown;
      relevant = scoped.relevant;
    }
  }

  // Which links to follow is ALWAYS an AI decision. That's the universal way to
  // catch non-obvious navigation — SPA fragment routes (#/contact), query routes
  // (?view=pricing), framework-specific pagination — without the algorithm
  // hard-coding any URL-shape rules. Per-run caching keeps it cheap: each href is
  // judged once, so homogeneous nav (a shared sidebar/footer) costs one call.
  const follow = await decideFollow(ctx, task, candidateObjs);

  // An HTTP error page (404/410/500 …) whose rendered content is thin is server
  // boilerplate ("page not found"), not content — keep its links (they drive the
  // recovery navigation) but never its body. The word-count floor protects the one
  // legitimate exception: a misconfigured SPA host that answers 404 while the app
  // renders a full, real page client-side.
  const errorPage = status >= 400 && contentWordLen(markdown) < 200;
  if (!markdown || !relevant || errorPage) return { page: null, links: follow };

  return {
    page: {
      url,
      task,
      title,
      markdown,
      blocks,
      // The faithful per-state record (BlockAccumulator.states()): every DISTINCT
      // reveal state, whole and verbatim. Attached ONLY when a reveal produced more
      // than one distinct state — a single-state page's one snapshot IS its
      // consolidated markdown (and chrome clicks that changed no content collapse
      // to it), so there is nothing extra to keep. Written to disk under states/.
      states: Array.isArray(revealed.states) && revealed.states.length > 1 ? revealed.states : undefined,
      // #21d — the reveal exit audit, per page and machine-readable: how many
      // characters of text were STILL hidden in the main content when the
      // reveal loop ended (0 = measured drain). Travels into the manifest and
      // scan stats so completeness is a number, not a hope.
      meta: { strategy: 'agent', fetchedAt: now(), bytes: bytesOf(markdown), revealResidualChars: revealed.hiddenResidualChars || 0 },
    },
    links: follow,
  };
}

/** No-browser path: plain fetch + static extraction (degraded; emits no reveal). */
async function staticFallback(target, ctx) {
  const { url, task } = target;
  let res = await loadHtml(url, { browserMode: ctx.options.browser, ctx });
  // status 0 = the fetch itself failed (network/timeout) — retryable, not "empty page".
  if (!res.html) return { page: null, links: [], failed: !res.status };

  let { title, markdown } = extractMarkdown(res.html, { baseUrl: res.finalUrl });

  // #14 — the same always-on anti-bot guard as the engine path: warn, one
  // backoff retry, then a declared skip. A challenge is never content.
  let det = detectChallenge({ status: res.status, headers: res.headers || {}, html: res.html, contentLen: contentWordLen(markdown) });
  if (det.challenge) {
    ctx.emit({
      type: 'warn',
      url,
      reason: 'anti-bot',
      message: `Bot-defense challenge detected (${det.signal}); retrying once after a pause.`,
    });
    await new Promise((r) => setTimeout(r, challengeBackoffMs(res.headers || {})));
    res = await loadHtml(url, { browserMode: ctx.options.browser, ctx });
    if (!res.html) return { page: null, links: [], failed: !res.status };
    ({ title, markdown } = extractMarkdown(res.html, { baseUrl: res.finalUrl }));
    det = detectChallenge({ status: res.status, headers: res.headers || {}, html: res.html, contentLen: contentWordLen(markdown) });
    if (det.challenge) {
      ctx.emit({
        type: 'warn',
        url,
        reason: 'anti-bot',
        message: `Still challenged after the retry (${det.signal}) — page skipped; its interstitial is NOT in the output.`,
      });
      return { page: null, links: [] }; // never kept, never bypassed
    }
  }
  const links = new Set();
  for (const m of res.html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const abs = resolveUrl(m[1], res.finalUrl);
    if (abs) links.add(abs);
  }

  // Same rule as the engine path: an HTTP error page with thin content is server
  // boilerplate — harvest its links, never keep its body.
  if (!markdown || (res.status >= 400 && contentWordLen(markdown) < 200)) {
    return { page: null, links: [...links] };
  }
  return {
    page: {
      url,
      task,
      title,
      markdown,
      meta: { strategy: 'agent', fetchedAt: now(), bytes: bytesOf(markdown) },
    },
    links: [...links],
  };
}
