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

  const capture = async (label) => {
    const html = await page.content();
    const { markdown } = extractMarkdown(html, { baseUrl: page.url() });
    return acc.add(markdown, { label });
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
      chosen = await aiSelectRevealers({ model: ctx.options.model, task, candidates: undecided, host: ctx.options.ollamaHost });
    } catch {
      chosen = null;
    }
    for (const c of undecided) decided.set(c.signature, chosen ? chosen.has(c.signature) : !!c.heuristic);
  };

  // Dismiss cookie/consent overlays once so they don't block content.
  const consentSeen = new Set();
  const first = await perceive(page);
  for (const c of first.consent || []) {
    if (ctx.shouldStop()) break;
    const sig = c.label.toLowerCase();
    if (consentSeen.has(sig)) continue;
    consentSeen.add(sig);
    const res = await clickRevealer(page, c.id);
    if (!res.navigatedTo) await capture();
  }

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
      // No un-actioned controls left: try to pull in lazy content, else stop.
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
        const added = await capture();
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
    const added = await capture(label);
    const actionName = next.kind === 'tab' ? 'click' : next.kind === 'expander' ? 'expand' : 'click';
    ctx.emit({
      type: 'action',
      url,
      action: actionName,
      detail: `${next.kind}: ${next.label || '(unlabelled)'}${added ? ` (+${added})` : ''}`,
    });
    // Termination is guaranteed by the `actioned` set: every approved control is
    // clicked at most once, and the budget caps total actions.
  }

  // Final sweep of links/routes from the last state.
  for (const l of lastPerception.links) if (!allLinks.has(l.href)) allLinks.set(l.href, l.label);
  for (const r of lastPerception.routes) allRoutes.add(r);

  const links = [...allLinks.entries()].map(([href, label]) => ({ href, label }));
  return {
    markdown: acc.toMarkdown(),
    title,
    links,
    navLinks: [...navLinks],
    routes: [...allRoutes],
    hitCap,
  };
}
