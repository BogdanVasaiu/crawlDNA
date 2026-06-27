// The reveal engine: deterministically exercise EVERY control that could hide
// content (tabs, accordions, "load more", menus, JS widgets), capturing each
// revealed state, until nothing new appears. Model-free and universal — it does
// not care how the site is built. Recall first; AI does precision afterwards.

import { perceive } from './perceive.mjs';
import { clickRevealer, scrollStep } from './actions.mjs';
import { extractMarkdown, BlockAccumulator } from '../extract.mjs';
import { aiSelectRevealers } from './decide.mjs';

/**
 * @param {import('playwright').Page} page
 * @param {object} ctx  crawl context (emit, shouldStop, options)
 * @param {string} url  the page URL (for events)
 * @param {string} [task]  the crawl task (context for the AI reveal triage)
 * @returns {Promise<{ markdown, title, links, navLinks, routes, hitCap }>}
 */
export async function revealAll(page, ctx, url, task) {
  const acc = new BlockAccumulator();
  const navLinks = new Set();
  const actioned = new Set();
  const decided = new Map(); // signature -> boolean: is this control worth clicking?
  const maxActions = Math.max(8, ctx.options.maxActions || 40);

  // Capture only the VISIBLE DOM of the current state. Interactive apps pre-render
  // many hidden panels (modals, on-screen keyboards, loading/success placeholders);
  // `page.content()` serializes them all and extractMarkdown can't see CSS
  // visibility in Node, so it would dump them into the output. We mark non-visible
  // elements in-browser (atomically: mark → serialize → unmark) and drop them in
  // extract. This is exactly the reveal model: content surfaced by a click IS
  // visible at capture time; mutually-exclusive tab variants are each visible when
  // active (so all still accumulate); chrome never revealed stays out. Generic —
  // no per-site logic. If reveal misses a control, raise --max-actions (the right
  // knob), rather than leaking every hidden panel.
  const captureHtml = async () => {
    try {
      return await page.evaluate(() => {
        const isHidden = (el) => {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true;
          const r = el.getBoundingClientRect();
          return r.width <= 1 && r.height <= 1;
        };
        const marked = [];
        for (const el of document.body.querySelectorAll('*')) {
          if (isHidden(el)) {
            el.setAttribute('data-docdna-hidden', '1');
            marked.push(el);
          }
        }
        const out = document.documentElement.outerHTML;
        for (const el of marked) el.removeAttribute('data-docdna-hidden');
        return out;
      });
    } catch {
      return page.content();
    }
  };

  // `label` is the tab-variant marker (toMarkdown); `provenance` is the richer
  // reveal source carried to the layout router so tasks like "the dropdown
  // results → dropdown.md" can route by HOW a block was surfaced.
  const capture = async (label, provenance = 'baseline') => {
    const html = await captureHtml();
    const { markdown } = extractMarkdown(html, { baseUrl: page.url() });
    return acc.add(markdown, { label, provenance });
  };

  // AI-driven discovery: let the model read the candidate controls and decide
  // which actually hide content (catching non-obvious ones, rejecting demos),
  // caching the verdict per signature so each control is judged once. Falls back
  // to the per-candidate heuristic when the model is unavailable — so coverage
  // never drops below the old deterministic behaviour. New candidates that only
  // appear AFTER a reveal are triaged in the next loop pass (a few batched calls
  // per page, never a per-click model loop).
  const triage = async (candidates) => {
    const undecided = candidates.filter((c) => !decided.has(c.signature)).slice(0, 100);
    if (!undecided.length) return;
    let chosen = null;
    try {
      chosen = await aiSelectRevealers({ llm: ctx.options.llm, task, candidates: undecided });
    } catch {
      chosen = null;
    }
    for (const c of undecided) decided.set(c.signature, chosen ? chosen.has(c.signature) : !!c.heuristic);
  };

  // Dismiss cookie/consent overlays once so they don't block content.
  const consentSeen = new Set();
  const dismissConsent = async () => {
    const p = await perceive(page);
    for (const c of p.consent || []) {
      if (ctx.shouldStop()) break;
      const sig = c.label.toLowerCase();
      if (consentSeen.has(sig)) continue;
      consentSeen.add(sig);
      const r = await clickRevealer(page, c.id);
      if (!r.navigatedTo) await capture();
    }
  };

  // Restore the BASE page so sibling controls that a view-changing click swapped
  // away (e.g. picking a calendar day replaces the month grid with that day's
  // slots) become reachable again. Reload + re-dismiss consent; the actioned /
  // decided sets persist (signatures are content-based, stable across reload), so
  // the loop then takes the NEXT un-actioned sibling. This is what lets a stateful
  // WIZARD be explored one branch at a time — generally, with no per-site logic.
  const restoreBase = async () => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
    } catch {
      return;
    }
    await dismissConsent();
  };

  await dismissConsent();

  // Baseline (default state).
  await capture();

  let lastPerception = await perceive(page);
  let title = lastPerception.title;
  let allLinks = new Map(); // href -> label
  let allRoutes = new Set();
  let actions = 0;
  let hitCap = false;
  let scrolledOut = false;

  while (!ctx.shouldStop()) {
    if (actions >= maxActions) {
      hitCap = true;
      break;
    }

    const perception = await perceive(page);
    lastPerception = perception;
    title = title || perception.title;
    for (const l of perception.links) if (!allLinks.has(l.href)) allLinks.set(l.href, l.label);
    for (const r of perception.routes) allRoutes.add(r);

    // AI decides which candidates reveal content; pick the first approved one not
    // yet actioned.
    await triage(perception.revealers);
    const next = perception.revealers.find((r) => decided.get(r.signature) && !actioned.has(r.signature));

    if (!next) {
      // No un-actioned controls left in THIS view. If a previous click navigated us
      // into a sub-view, the remaining siblings live back at base — restore and
      // retry before giving up. (scrolledOut guards against looping forever.)
      if (!scrolledOut) {
        const grew = await scrollStep(page);
        const added = await capture();
        if (grew || added) {
          if (!grew) scrolledOut = false;
          continue;
        }
        scrolledOut = true;
        continue;
      }
      break;
    }

    // Sibling controls we still need to reach (approved + un-actioned, this view) —
    // used to detect whether the upcoming click NAVIGATES the view away from them.
    const siblingsBefore = perception.revealers
      .filter((r) => decided.get(r.signature) && !actioned.has(r.signature) && r.signature !== next.signature)
      .map((r) => r.signature);

    actioned.add(next.signature);
    actions++;

    if (next.kind === 'loadmore') {
      // Exhaust: keep clicking the same control until it stops yielding content.
      let tries = 0;
      while (tries++ < 40 && actions < maxActions && !ctx.shouldStop()) {
        const fresh = await perceive(page);
        const same = fresh.revealers.find((r) => r.signature === next.signature);
        if (!same) break;
        const res = await clickRevealer(page, same.id);
        actions++;
        if (res.navigatedTo) {
          navLinks.add(res.navigatedTo);
          break;
        }
        const added = await capture(undefined, 'loadmore');
        ctx.emit({ type: 'action', url, action: 'click', detail: `load more — ${next.label}` });
        if (!added) break;
      }
      continue;
    }

    const res = await clickRevealer(page, next.id);
    if (res.navigatedTo) {
      navLinks.add(res.navigatedTo);
      ctx.emit({ type: 'action', url, action: 'follow', detail: next.label || res.navigatedTo });
      continue;
    }

    const label = next.kind === 'tab' ? next.label : undefined;
    const provenance = next.label ? `${next.kind}:${next.label}` : next.kind;
    const added = await capture(label, provenance);
    const actionName = next.kind === 'tab' ? 'click' : next.kind === 'expander' ? 'expand' : 'click';
    ctx.emit({
      type: 'action',
      url,
      action: actionName,
      detail: `${next.kind}: ${next.label || '(unlabelled)'}${added ? ` (+${added})` : ''}`,
    });

    // If this click NAVIGATED the view (its siblings vanished) instead of revealing
    // in place, restore the base so the remaining siblings stay reachable — the
    // stateful-wizard case (pick a day → that day's slots replace the calendar). An
    // in-place reveal keeps its siblings (other tabs/accordions still present), so
    // this is skipped and those stay fast. Only meaningful with ≥2 siblings.
    if (siblingsBefore.length >= 2 && !ctx.shouldStop()) {
      const afterSigs = new Set((await perceive(page)).revealers.map((r) => r.signature));
      const remaining = siblingsBefore.filter((s) => afterSigs.has(s)).length;
      if (remaining <= siblingsBefore.length * 0.5) {
        await restoreBase();
        scrolledOut = false; // fresh base: allow lazy-scroll discovery again
      }
    }
    // Termination is guaranteed by the `actioned` set: every approved control is
    // clicked at most once, and the budget caps total actions.
  }

  // Final sweep of links/routes from the last state.
  for (const l of lastPerception.links) if (!allLinks.has(l.href)) allLinks.set(l.href, l.label);
  for (const r of lastPerception.routes) allRoutes.add(r);

  const links = [...allLinks.entries()].map(([href, label]) => ({ href, label }));
  return {
    markdown: acc.toMarkdown(),
    blocks: acc.toBlocks(), // raw { text, provenance } in capture order, for layout
    title,
    links,
    navLinks: [...navLinks],
    routes: [...allRoutes],
    hitCap,
  };
}
