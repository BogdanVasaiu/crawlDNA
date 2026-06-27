// The reveal engine: exhaustively exercise every control that could hide content
// (tabs, accordions, "load more", menus, JS widgets, paginators) and capture each
// revealed state until nothing NEW appears. Universal — it does not care how the
// site is built. AI (aiSelectRevealers) decides WHICH controls hide content; this
// loop decides HOW to traverse them, driven by a small map of explored state.
//
// Traversal model (map-driven, deterministic — no per-click LLM, no per-site code):
// every click is classified by its EFFECT, by comparing the controls (siblings)
// and the state fingerprint before vs after:
//   - IN-PLACE   the siblings stay (a tab swaps text, an accordion opens, a calendar
//                day shows its slots below the grid) → the control is a leaf, clicked
//                once, and we keep going in the same view.
//   - ADVANCING  the siblings are largely replaced by a NEW set with new content (a
//                "next month"/"next page" paginator, a wizard step) → we DON'T retire
//                it; we record which states it was applied from and re-apply it from
//                each new state, walking the whole sequence (June → July → August …)
//                until it stops yielding new states (saturation) or the budget runs
//                out. This is the load-more idea generalised to any view-advancing
//                control — the fix for stateful sequences a one-shot click missed.
//   - NAVIGATED  the click left the page (real URL) or replaced the view with a
//                dead/seen one → recorded as a link, or restoreBase() to recover the
//                siblings.
// A set of visited state fingerprints prevents cycles; the action budget and a
// per-control re-use cap guarantee termination.

import { perceive } from './perceive.mjs';
import { clickRevealer, scrollStep } from './actions.mjs';
import { extractMarkdown, BlockAccumulator } from '../extract.mjs';
import { aiSelectRevealers, aiPlanNavigation } from './decide.mjs';

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
  const decided = new Map(); // signature -> boolean: does this control hide content?
  const doneLeaf = new Set(); // signatures of leaf/in-place controls already clicked
  const advancing = new Map(); // signature -> { appliedFrom: Set<fp>, uses: number }
  const visited = new Set(); // state fingerprints already captured (cycle guard)
  const maxActions = Math.max(8, ctx.options.maxActions || 40);
  // Bound how many times a single view-advancing control may re-apply, so a
  // bidirectional paginator (prev/next) can't loop forever within the budget.
  const ADV_CAP = Math.max(12, maxActions);

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
            el.setAttribute('data-sagecrawl-hidden', '1');
            marked.push(el);
          }
        }
        const out = document.documentElement.outerHTML;
        for (const el of marked) el.removeAttribute('data-sagecrawl-hidden');
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

  // Reload the original page. Used to recover from a click that navigated the view
  // to a dead/already-seen sub-view (a true wizard branch). doneLeaf/advancing/
  // visited persist (signatures + fingerprints are content-based, stable across
  // reload), so the loop resumes with the next un-tried control.
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
  const allLinks = new Map(); // href -> label
  const allRoutes = new Set();
  let navPlan; // computed once: { directionSig, target } to walk toward a target, or null
  let actions = 0;
  let hitCap = false;
  let scrolledOut = false;
  let navStopped = false; // reached the target (or can't advance) — stop walking

  while (!ctx.shouldStop()) {
    if (actions >= maxActions) {
      hitCap = true;
      break;
    }

    const perception = await perceive(page);
    lastPerception = perception;
    title = title || perception.title;
    const fp = perception.fingerprint;
    visited.add(fp);
    for (const l of perception.links) if (!allLinks.has(l.href)) allLinks.set(l.href, l.label);
    for (const r of perception.routes) allRoutes.add(r);

    await triage(perception.revealers);
    const approved = perception.revealers.filter((r) => decided.get(r.signature));

    // Plan navigation ONCE (the crawl4ai-style split: AI plans, loop executes). The
    // model names the control that advances toward the task's target and a literal
    // marker for the target view; everything after is deterministic.
    if (navPlan === undefined && approved.length) {
      let plan = null;
      try {
        plan = await aiPlanNavigation({
          llm: ctx.options.llm,
          task,
          current: { title: perception.title, snippet: perception.mainText },
          controls: approved,
        });
      } catch {
        plan = null;
      }
      navPlan =
        plan && plan.direction != null
          ? { directionSig: approved[plan.direction].signature, target: plan.target }
          : null; // null = open-ended / no targeted navigation
    }

    const mainLC = (perception.mainText || '').toLowerCase();
    const targeting = !!(navPlan && navPlan.target);
    const onTarget = targeting && mainLC.includes(navPlan.target.toLowerCase());

    let next;
    let aiNav = false;

    // (A) TARGETED WALK: step toward the target with the planned control, SKIPPING
    // this (non-target) view's leaves so the budget isn't spent on views we don't want.
    if (targeting && !onTarget && !navStopped) {
      next = approved.find((r) => r.signature === navPlan.directionSig);
      aiNav = !!next;
      if (!next) navStopped = true; // can't advance — fall back to exploring here
    }

    // (B) EXPLORE THE CURRENT VIEW: click each un-clicked leaf (in-place reveal) and
    // classify controls. Runs for the target view (collect its content), open-ended
    // tasks (extract everything), or when a targeted walk can't proceed. The planned
    // direction paginator is excluded here so first-touch never overshoots the target
    // (it's only ever applied by the targeted walk in (A) or the open-ended sweep in (C)).
    if (!next) {
      next = approved.find(
        (r) => !doneLeaf.has(r.signature) && !advancing.has(r.signature) && !(navPlan && r.signature === navPlan.directionSig),
      );
    }

    // (C) No leaves left here.
    if (!next && !navStopped) {
      if (targeting && onTarget) {
        navStopped = true; // reached the target and exhausted it — don't wander past it
      } else if (!targeting) {
        // Open-ended: keep walking via any advancing control not yet tried from here.
        const navCands = approved.filter((r) => {
          const a = advancing.get(r.signature);
          return a && a.uses < ADV_CAP && !a.appliedFrom.has(fp);
        });
        next = navCands[0];
        aiNav = !!next;
      }
    }

    if (!next) {
      // Nothing actionable in this view. Pull in lazy content with a scroll once;
      // if that yields nothing either, we're done.
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

    // Approved controls other than `next` — used to detect whether the click
    // REPLACES the current view (they vanish) or reveals IN PLACE (they stay).
    const siblingsBefore = approved.filter((r) => r.signature !== next.signature).map((r) => r.signature);
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
      doneLeaf.add(next.signature);
      continue;
    }

    const res = await clickRevealer(page, next.id);
    if (res.navigatedTo) {
      navLinks.add(res.navigatedTo);
      doneLeaf.add(next.signature);
      ctx.emit({ type: 'action', url, action: 'follow', detail: next.label || res.navigatedTo });
      continue;
    }

    const label = next.kind === 'tab' ? next.label : undefined;
    const provenance = next.label ? `${next.kind}:${next.label}` : next.kind;
    const added = await capture(label, provenance);

    // Classify the effect by comparing siblings + state fingerprint before/after.
    const after = await perceive(page);
    const afterSigs = new Set(after.revealers.map((r) => r.signature));
    const retained = siblingsBefore.filter((s) => afterSigs.has(s)).length;
    const replaced = siblingsBefore.length >= 2 && retained <= siblingsBefore.length * 0.5;
    const newState = !visited.has(after.fingerprint);
    // Does the control we just clicked still exist in the new view? This is the
    // general discriminator between the two replace-the-view cases:
    //   - a PAGINATOR persists (a "next month" arrow is on every month) → keep
    //     re-applying it to walk the whole sequence;
    //   - a WIZARD OPTION disappears with its siblings (you picked one day; the day
    //     grid was swapped for that day's slots) → restore to try the next sibling.
    const selfPresent = afterSigs.has(next.signature);

    let kind = 'reveal';
    if (replaced && selfPresent) {
      // VIEW-ADVANCING paginator. Re-applied from each state it reaches (tracked by
      // appliedFrom), never globally retired — that is what walks June→July→August.
      let a = advancing.get(next.signature);
      if (!a) {
        a = { appliedFrom: new Set(), uses: 0 };
        advancing.set(next.signature, a);
      }
      a.appliedFrom.add(fp);
      a.uses++;
      kind = 'advance';
      if (newState) {
        visited.add(after.fingerprint);
        scrolledOut = false; // a fresh view may have its own lazy content
      }
      // Landed on an already-seen state: just move on. The appliedFrom guard stops
      // re-clicking it from this fp; uses < ADV_CAP bounds any prev/next cycle.
    } else if (replaced && !selfPresent) {
      // WIZARD BRANCH: the picked option and its siblings were swapped out. Restore
      // to recover the siblings and let the loop take the next un-clicked one.
      doneLeaf.add(next.signature);
      await restoreBase();
      scrolledOut = false;
      kind = 'branch';
    } else {
      // IN-PLACE reveal (tab/accordion/expander/slot panel): a leaf, done once.
      doneLeaf.add(next.signature);
      if (newState) visited.add(after.fingerprint);
    }

    ctx.emit({
      type: 'action',
      url,
      action: next.kind === 'tab' ? 'click' : next.kind === 'expander' ? 'expand' : 'click',
      detail: `${aiNav ? 'navigate' : kind === 'advance' ? 'advance' : next.kind}: ${next.label || '(unlabelled)'}${added ? ` (+${added})` : ''}`,
    });
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
