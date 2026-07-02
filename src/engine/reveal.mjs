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
import { settle } from '../lib/settle.mjs';
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

  // Per-SCAN reveal-verdict cache (survives ACROSS pages, unlike `decided` which is
  // per-page). A docs site repeats the same tabs/accordions/expanders on every page;
  // without this the AI re-judges them on all N pages. This is the link-gate cache
  // idea (decideFollow's _followCache) applied to reveal — the single biggest crawl
  // token saving. Keyed by the control's stable HUMAN identity (role|label|kind),
  // which is the same across pages (it excludes the per-page DOM id and the often
  // auto-generated aria-controls that the full traversal `signature` carries).
  const revealHost = ctx.currentScan || ctx;
  const revealCache = revealHost._revealCache || (revealHost._revealCache = new Map());
  // Unlabelled controls get NO cross-page key (judged per page) so distinct generic
  // controls are never collapsed onto one shared verdict.
  const revealKey = (c) => (c.label && c.label.trim().length >= 2 ? `${c.role}|${c.label.trim()}|${c.kind}` : null);

  const doneLeaf = new Set(); // signatures of leaf/in-place controls already clicked
  const advancing = new Map(); // signature -> { appliedFrom: Set<fp>, uses: number }
  const visited = new Set(); // state fingerprints already captured (cycle guard)
  const maxActions = Math.max(8, ctx.options.maxActions || 40);
  // Bound how many times a single view-advancing control may re-apply, so a
  // bidirectional paginator (prev/next) can't loop forever within the budget.
  const ADV_CAP = Math.max(12, maxActions);
  // Bound the TARGETED WALK: how many times the AI-planned direction control may be
  // clicked toward a target before giving up. Without this, a mis-planned direction
  // (a control whose target marker never appears — e.g. a modal-opener) re-clicks
  // forever and eats the whole action budget. Kept well below maxActions so a single
  // control can never monopolise the crawl.
  const NAV_CAP = Math.max(12, Math.ceil(maxActions / 3));

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
    // First resolve from the cross-page cache (no model call), and collect only the
    // genuinely-new controls for the AI. On the 2nd+ page of a uniform docs site this
    // empties the list, so most pages cost ZERO reveal-triage tokens.
    const undecided = [];
    for (const c of candidates) {
      if (decided.has(c.signature)) continue;
      const key = revealKey(c);
      if (key && revealCache.has(key)) decided.set(c.signature, revealCache.get(key));
      else undecided.push(c);
    }
    if (!undecided.length) return;
    // Judge EVERY undecided candidate, in batches of the model call's cap. A single
    // truncated batch used to leave candidates past #100 unjudged — and if the loop
    // then found nothing actionable and exited, they were never triaged at all
    // (silent missed content on control-dense pages, against rule #1).
    for (let i = 0; i < undecided.length; i += 100) {
      if (ctx.shouldStop()) break;
      const batch = undecided.slice(i, i + 100);
      let chosen = null;
      try {
        chosen = await aiSelectRevealers({ llm: ctx.options.llm, task, candidates: batch });
      } catch {
        chosen = null;
      }
      for (const c of batch) {
        const verdict = chosen ? chosen.has(c.signature) : !!c.heuristic;
        decided.set(c.signature, verdict);
        // Persist only a MODEL verdict (not the page-local heuristic fallback) and only
        // for labelled controls, so the cache carries real cross-page judgments.
        const key = revealKey(c);
        if (key && chosen) revealCache.set(key, verdict);
      }
    }
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
      // Response-quiet instead of networkidle (#15): a held-open socket kept the
      // idle signal from EVER firing, taxing every restore its full 5s timeout.
      await settle(page, { maxMs: 5000 });
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
  let navUses = 0; // times the targeted-walk direction control has been applied
  let navStall = 0; // consecutive targeted-walk clicks that made no progress

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
      // STICKY-SELECTION RESTORE. Some views make a pick "stick": selecting one item
      // changes the view's state and then the SIBLINGS stop responding until the view
      // is re-rendered (this calendar — once day 2's slots open, clicking day 3/6/7…
      // does nothing, so only day 2 would ever be captured). When a click both reveals
      // content AND moves the state, and its group still has un-clicked members,
      // restore the base view so the next sibling is selected on a fresh render; the
      // loop re-navigates back and takes it. The group test masks digits, so it only
      // fires for NUMBERED groups (calendar days, "Page 1/2/3", numbered items) that
      // are prone to this — tabs/accordions with distinct names share no pattern and
      // are left fast and reload-free.
      const groupKey = (r) => `${r.role}|${r.kind}|${String(r.label || '').replace(/\d+/g, '#')}`;
      const want = groupKey(next);
      const groupHasMore = perception.revealers.some(
        (r) => r.signature !== next.signature && decided.get(r.signature) && !doneLeaf.has(r.signature) && groupKey(r) === want,
      );
      if (added && after.fingerprint !== fp && groupHasMore) {
        await restoreBase();
        scrolledOut = false;
      }
    }

    // SIBLING SWEEP — a control that revealed content proves its whole repeated
    // GROUP is content: a calendar's days, a list of expanders, "Page 1 / 2 / 3"…
    // The AI triage typically approves only a few representative items of such a
    // group, so the rest are never captured. Read the group from the PRE-click
    // perception (a branch's click REPLACES the group with the revealed view, so it
    // is gone from `after`) and auto-approve every same-pattern sibling (same
    // role+kind, label identical once its digits are masked). The loop then sweeps
    // the ENTIRE group — works for in-place reveals AND wizard branches (each click
    // restores, then the next approved sibling is taken). A general DOM/label-shape
    // signal, no per-site rules; gated on real content and bounded by maxActions.
    if (added) {
      const groupKey = (r) => `${r.role}|${r.kind}|${String(r.label || '').replace(/\d+/g, '#')}`;
      const want = groupKey(next);
      for (const r of perception.revealers) {
        if (groupKey(r) === want && !decided.get(r.signature)) decided.set(r.signature, true);
      }
    }

    // Terminate the TARGETED WALK so the planned direction control can't be clicked
    // forever. A real walk makes progress every step (each next-month is a NEW state),
    // so progress resets the stall; a mis-planned direction that just re-opens the
    // same view (or never reaches its target) makes no progress and is stopped fast,
    // and NAV_CAP is a hard backstop regardless. This is what kept "Apri servizi" from
    // burning all 60 actions on the booking page.
    if (aiNav && navPlan && next.signature === navPlan.directionSig) {
      navUses++;
      navStall = newState || added ? 0 : navStall + 1;
      if (navUses >= NAV_CAP || navStall >= 2) navStopped = true;
    } else if (added) {
      // A productive non-navigation click (e.g. a calendar day's slots captured):
      // the reveal is still bearing fruit, so reset the targeted walk's give-up
      // counters. Some views bounce you off the grid when you pick an item (the day
      // grid is swapped for that day's slots), forcing a re-navigation back to it;
      // that return revisits a SEEN state and must NOT be mistaken for a stall, or
      // the sweep abandons the remaining items (days 8,9,10 …). The runaway guard
      // still fires when navigation yields neither new state nor new content.
      navStall = 0;
      navUses = 0;
    }

    ctx.emit({
      type: 'action',
      url,
      action: next.kind === 'tab' ? 'click' : next.kind === 'expander' ? 'expand' : 'click',
      detail: `${aiNav ? 'navigate' : kind === 'advance' ? 'advance' : next.kind}: ${next.label || '(unlabelled)'}${added ? ` (+${added})` : ''}`,
      // The STATE this action lands on (perception fingerprint). The UI keys
      // view nodes by this, so the same control reaching different states
      // (next-page → p1, p2 …; next-month → July, August) yields distinct nodes,
      // while re-reaching a state collapses onto its existing node.
      state: after.fingerprint,
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
