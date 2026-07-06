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

import { perceive, markVisualHeadings } from './perceive.mjs';
import { pickConsent } from './consent.mjs';
import { clickRevealer, scrollStep } from './actions.mjs';
import { settle } from '../lib/settle.mjs';
import { extractMarkdown, BlockAccumulator } from '../extract.mjs';
import { aiSelectRevealers, aiPlanNavigation } from './decide.mjs';

// #21b — the measurement thresholds of the closed loop. PAYLOAD_MIN: a control
// with at least this many characters of MEASURED hidden text behind it (its
// aria-controls target, a hidden sibling panel, an unopened <details>) is
// revealed even when a judge said no — ~30 words is real content, above
// menu-crumb noise, and the cost of a wrong override is one click (~1s) while
// the cost of a wrong "no" is lost content (rule #1). RESIDUAL_WARN_CHARS: the
// exit audit warns when at least this much text is still hidden at the end.
export const PAYLOAD_MIN = 200;
export const RESIDUAL_WARN_CHARS = 1200;

/**
 * #9 — the TRUTHFUL residual: the raw hidden-char count MINUS any hidden block whose
 * text is already in the captured markdown. A mutually-exclusive panel (tab B once
 * tab C is active) is hidden in the final state yet WAS captured when it was open —
 * the exit audit's known false-positive. Conservative (rule #1 — never mask a real
 * gap): only a strong verbatim match (≥60 chars) counts as captured, and text past
 * the inspected sample cap stays counted. Pure; exported for the tests and reused by
 * the a11y fallback's re-check.
 */
export function truthfulResidual(rawResidual, hiddenTexts, markdown) {
  if (!hiddenTexts || !hiddenTexts.length) return rawResidual;
  const capturedNorm = String(markdown || '').replace(/\s+/g, ' ').toLowerCase();
  const inspected = hiddenTexts.reduce((a, h) => a + (h.n || 0), 0);
  let uncaptured = 0;
  for (const h of hiddenTexts) {
    const sample = String(h.s || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
    if (sample.length >= 60 && capturedNorm.includes(sample)) continue; // captured in an earlier state
    uncaptured += h.n || 0;
  }
  return uncaptured + Math.max(0, rawResidual - inspected); // uninspected chars stay counted
}

/**
 * #21b — rank approved controls by MEASURED signals, so the action budget goes
 * to provable content first: a closed disclosure (aria-expanded="false") is
 * mechanical proof there is something to open; a measured hidden payload
 * likewise (weighted by size); a specific kind (tab/expander/dropdown/loadmore)
 * beats the generic 'control'; the label heuristic is only a last-place hint
 * (English-biased, no longer load-bearing). A `chrome` control — a JS switcher in
 * the site nav/header/footer, now surfaced so nothing clickable is missed —
 * carries a penalty so the MAIN CONTENT always gets the budget first; chrome only
 * leapfrogs it on HARD measured proof (a real payload / closed disclosure), never
 * on a kind/label hint alone. Pure; exported for the tests.
 */
export function revealPriority(c) {
  return (
    (c.expanded === 'false' ? 4 : 0) +
    ((c.hiddenPayload || 0) > 0 ? 2 + Math.min(1, (c.hiddenPayload || 0) / 2000) : 0) +
    (c.kind && c.kind !== 'control' ? 1 : 0) +
    (c.heuristic ? 0.5 : 0) -
    (c.chrome ? 1 : 0)
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {object} ctx  crawl context (emit, shouldStop, options)
 * @param {string} url  the page URL (for events)
 * @param {string} [task]  the crawl task (context for the AI reveal triage)
 * @returns {Promise<{ markdown, title, links, navLinks, routes, hitCap, hiddenResidualChars }>}
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

  // Cross-page CHROME futility (measured · universal · re-verifying). The per-page
  // shape-muting below RESETS each page, so the site's shared chrome (theme toggle,
  // nav tabs, search) is re-clicked on EVERY page only to re-measure that it reveals
  // nothing — on a large site that is ~88% of all clicks, each costing a settle wait.
  // Carry a per-SCAN, MEASURED tally: a CHROME control (structurally OUTSIDE the main
  // content, #28 — so never content itself) that added ZERO content on the last
  // INERT_PAGES pages is SAMPLED DOWN — clicked once every RECHECK pages instead of on
  // every page. It is re-verified on that cadence and RE-ARMED FOREVER the instant it
  // EVER adds a block, so no content can be lost (anything that reveals content is
  // never sampled) and it adapts to any site. Content controls, already-productive
  // controls and unlabelled chrome (no cross-page key) are never sampled → precision
  // stays identical; only proven waste is trimmed. The signal is CONTENT (added>0),
  // NOT state change: a theme swap moves the fingerprint but adds no content, so it is
  // correctly treated as inert. Keyed by revealKey (role|label|kind), stable per site.
  const inert = revealHost._revealInert || (revealHost._revealInert = new Map());
  const pageOrdinal = (revealHost._revealPageNo = (revealHost._revealPageNo || 0) + 1);
  const INERT_PAGES = 4; // measured-inert pages required before sampling begins
  const RECHECK = 5; // re-verify a proven-inert chrome control every Nth page
  const sampledOut = (r) => {
    if (!r.chrome) return false;
    const k = revealKey(r);
    if (!k) return false;
    const rec = inert.get(k);
    if (!rec || rec.productive || rec.streak < INERT_PAGES) return false;
    return pageOrdinal % RECHECK !== 0; // outside the re-verify cadence → skip this page
  };

  const doneLeaf = new Set(); // signatures of leaf/in-place controls already clicked
  const advancing = new Map(); // signature -> { appliedFrom: Set<fp>, uses: number }
  const visited = new Set(); // state fingerprints already captured (cycle guard)

  // MEASURED FUTILITY GUARD. Interactive apps attach click handlers to plain DATA
  // rows (stat cards, table rows, chips — ripple frameworks do this by default),
  // and no-AI mode approves every candidate, so the action budget can drain on
  // dozens of identical-looking rows that reveal nothing — starving the controls
  // that DO (an embedded app's Analytics/Chat views). Controls sharing a visual
  // SHAPE (role|kind|class) are probed a few times; once SHAPE_DEAD consecutive
  // members click to no effect (no new blocks, no state change, no navigation)
  // the remaining look-alikes are muted for this page. One member with a real
  // effect re-arms its shape (calendar days stay alive: the first day already
  // reveals its slots). Measured, not judged — and bounded: a fruitless shape
  // costs at most SHAPE_DEAD clicks instead of one per member.
  const SHAPE_DEAD = 3;
  const shapeKey = (r) => `${r.role}|${r.kind}|${r.cls || ''}`;
  const shapeFails = new Map(); // shapeKey -> consecutive no-effect clicks
  const shapeMuted = (r) => (shapeFails.get(shapeKey(r)) || 0) >= SHAPE_DEAD;
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
  // #26 — the same atomic pass also stamps data-crawldna-heading on VISUAL
  // headings (short lines whose font jumps vs the local body text): computed
  // styles only exist here in the browser, and extract.mjs turns the marker
  // into ##/###/####, giving the .md the skeleton the page painted. The
  // function lives in perceive.mjs and is inlined via toString() — a string
  // evaluate, not a nested eval, so page CSP never blocks it.
  const captureHtml = async () => {
    try {
      return await page.evaluate(`(() => {
        let headingMarked = [];
        try {
          headingMarked = (${markVisualHeadings.toString()})() || [];
        } catch (e) {
          headingMarked = document.querySelectorAll('[data-crawldna-heading]');
        }
        const isHidden = (el) => {
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true;
          const r = el.getBoundingClientRect();
          return r.width <= 1 && r.height <= 1;
        };
        const marked = [];
        for (const el of document.body.querySelectorAll('*')) {
          if (isHidden(el)) {
            el.setAttribute('data-crawldna-hidden', '1');
            marked.push(el);
          }
        }
        const out = document.documentElement.outerHTML;
        for (const el of marked) el.removeAttribute('data-crawldna-hidden');
        for (const el of headingMarked) el.removeAttribute('data-crawldna-heading');
        return out;
      })()`);
    } catch {
      return page.content();
    }
  };

  // `label` is the tab-variant marker (toMarkdown); `provenance` is the richer
  // reveal source carried to the layout router so tasks like "the dropdown
  // results → dropdown.md" can route by HOW a block was surfaced.
  // `order` (#27) is the revealing control's vertical position in the page — it
  // sorts mutually-exclusive reveal states into REPRESENTATION order in the
  // output (the app's nav rail order), instead of the order they were clicked.
  // Baseline and lazy-scroll captures pass 0 (the skeleton comes first).
  const capture = async (label, provenance = 'baseline', order = 0) => {
    const html = await captureHtml();
    const { markdown } = extractMarkdown(html, { baseUrl: page.url() });
    return acc.add(markdown, { label, provenance, order });
  };

  // AI-driven discovery: let the model read the candidate controls and decide
  // which actually hide content (catching non-obvious ones, rejecting demos),
  // caching the verdict per signature so each control is judged once. #21b: the
  // model's "no" is overridden by a MEASURED hidden payload, and with no model
  // at all (no-AI, outage) every candidate is approved with the measured
  // ordering deciding who gets the budget — so coverage never depends on any
  // lexicon. New candidates that only appear AFTER a reveal are triaged in the
  // next loop pass (a few batched calls per page, never a per-click model loop).
  const triage = async (candidates) => {
    // First resolve from the cross-page cache (no model call), and collect only the
    // genuinely-new controls for the AI. On the 2nd+ page of a uniform docs site this
    // empties the list, so most pages cost ZERO reveal-triage tokens.
    const undecided = [];
    for (const c of candidates) {
      if (decided.has(c.signature)) continue;
      const key = revealKey(c);
      if (key && revealCache.has(key)) {
        // #21b: even a cached "no" yields to THIS page's measured payload — the
        // cache carries the model's judgment, the measurement is per-page.
        decided.set(c.signature, revealCache.get(key) || (c.hiddenPayload || 0) >= PAYLOAD_MIN);
      } else undecided.push(c);
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
        const modelSays = chosen ? chosen.has(c.signature) : null;
        // #21b — MEASUREMENT ARBITRATES THE JUDGE. An AI "no" on a control with
        // real measured hidden payload is overridden: the judge's error becomes
        // harmless (one extra click at worst, never lost content). And with no
        // judge at all (no-AI mode, model outage) EVERY candidate is approved —
        // each already survived perceive's mechanical gauntlet (interactive,
        // visible, enabled, not a copy/share action); a wasted click costs ~1s,
        // missed content is irrecoverable (rule #1). The measured ORDERING
        // (revealPriority) decides who gets the budget first, so approving all
        // never starves the provable payloads. This retires the English
        // DISCLOSURE_LABEL heuristic as a gate — no more lexicon gaps in no-AI.
        const verdict = chosen ? modelSays || (c.hiddenPayload || 0) >= PAYLOAD_MIN : true;
        decided.set(c.signature, verdict);
        // Persist only the RAW MODEL verdict for labelled controls — the payload
        // override is a per-page measurement and must not leak across pages.
        const key = revealKey(c);
        if (key && chosen) revealCache.set(key, modelSays);
      }
    }
  };

  // Dismiss cookie/consent overlays once so they don't block content. perceive
  // MEASURES the overlay buttons; pickConsent (#21a) DECIDES — multilingual
  // micro-lexicon read off the banner itself, reject preferred over accept,
  // primary-by-geometry only for consent banners with exotic wording.
  const consentSeen = new Set();
  const dismissConsent = async () => {
    const p = await perceive(page);
    for (const c of pickConsent(p.consentCandidates)) {
      if (ctx.shouldStop()) break;
      const sig = c.label.toLowerCase();
      if (consentSeen.has(sig)) continue;
      consentSeen.add(sig);
      const r = await clickRevealer(page, c.id);
      ctx.emit({ type: 'action', url, action: 'click', detail: `dismiss overlay: ${c.label}` });
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
    // #21b — measured signals order the work: provable payloads first, so a tight
    // action budget is never spent on generic controls while a closed disclosure
    // with real text behind it waits. Stable sort: ties keep perception order.
    const approved = perception.revealers
      .filter((r) => decided.get(r.signature))
      .sort((a, b) => revealPriority(b) - revealPriority(a));

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
      // A plan needs BOTH halves: the direction control AND the target marker.
      // A direction without a target can never be walked toward (the targeted
      // walk (A) requires `navPlan.target`), yet it would still be EXCLUDED
      // from the explore branch (B) — a control reserved for a walk that never
      // runs is a control never clicked, i.e. silently lost content (rule #1).
      navPlan =
        plan && plan.direction != null && plan.target
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
        (r) =>
          !doneLeaf.has(r.signature) &&
          !advancing.has(r.signature) &&
          !(navPlan && r.signature === navPlan.directionSig) &&
          !shapeMuted(r) &&
          !sampledOut(r),
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
        const added = await capture(undefined, 'loadmore', next.top || 0);
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

    // The visible variant marker's label. Tabs always carry it; a generic control
    // or dropdown carries it too when its label is short (an app's view switcher —
    // "Analytics", "90D" — not a data row's whole text): if the click adds blocks,
    // the reader must see WHICH state produced them. Expanders/load-more stay
    // unlabelled — their revealed content follows its own heading in the document.
    const label =
      ['tab', 'control', 'dropdown'].includes(next.kind) && next.label && next.label.length <= 32
        ? next.label
        : undefined;
    const provenance = next.label ? `${next.kind}:${next.label}` : next.kind;
    const added = await capture(label, provenance, next.top || 0);

    // Cross-page chrome futility tally (CONTENT-only — a state change like a theme
    // swap doesn't count): added>0 marks the control PRODUCTIVE forever (never sampled
    // again, precision preserved); an inert chrome click grows its streak toward
    // sampling. Announced once, when a control first crosses into "sampled site-wide".
    if (next.chrome) {
      const ck = revealKey(next);
      if (ck) {
        const rec = inert.get(ck) || { streak: 0, productive: false, announced: false };
        if (added > 0) {
          rec.productive = true;
          rec.streak = 0;
        } else if (!rec.productive) {
          rec.streak++;
          if (rec.streak === INERT_PAGES && !rec.announced) {
            rec.announced = true;
            ctx.emit({
              type: 'action',
              url,
              action: 'skip',
              detail: `sampling chrome control site-wide — added no content on ${INERT_PAGES} pages (${next.label || '(unlabelled)'})`,
            });
          }
        }
        inert.set(ck, rec);
      }
    }

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
      // Futility bookkeeping: a click with NO effect at all (no new blocks AND
      // the state fingerprint did not move) counts against its shape; any real
      // effect re-arms the whole shape.
      if (!added && after.fingerprint === fp) {
        const sk = shapeKey(next);
        const fails = (shapeFails.get(sk) || 0) + 1;
        shapeFails.set(sk, fails);
        if (fails === SHAPE_DEAD) {
          const muted = perception.revealers.filter((r) => !doneLeaf.has(r.signature) && decided.get(r.signature) && shapeKey(r) === sk).length;
          if (muted > 0) {
            ctx.emit({
              type: 'action',
              url,
              action: 'skip',
              detail: `muting ${muted} look-alike control(s) — ${SHAPE_DEAD} identical clicks had no effect (e.g. ${next.label || '(unlabelled)'})`,
            });
          }
        }
      } else {
        shapeFails.set(shapeKey(next), 0);
      }
      // #21c — BEHAVIOURAL load-more: a control that just ADDED content, still
      // exists, and GREW the page (append — a tab swap keeps the height) behaves
      // like "load more" whatever language its label is in. Keep re-clicking it
      // until it stops yielding: the BlockAccumulator dedup makes re-shown
      // content add 0 blocks, so an open/close toggle (accordion) stops after
      // one probe click — the accepted ~1s price for never missing an
      // incremental loader with a non-English label. Bounded by the action
      // budget. The English LOADMORE label survives only as the fast path
      // (kind 'loadmore' exhausts immediately, no growth evidence needed).
      if (added && selfPresent && (after.scrollHeight || 0) > (perception.scrollHeight || 0) + 120) {
        let tries = 0;
        while (tries++ < 40 && actions < maxActions && !ctx.shouldStop()) {
          const fresh = await perceive(page);
          const same = fresh.revealers.find((r) => r.signature === next.signature);
          if (!same) break;
          const res2 = await clickRevealer(page, same.id);
          actions++;
          if (res2.navigatedTo) {
            navLinks.add(res2.navigatedTo);
            break;
          }
          const more = await capture(label, provenance, next.top || 0);
          if (!more) break;
          ctx.emit({ type: 'action', url, action: 'click', detail: `load more (measured): ${next.label || '(unlabelled)'} (+${more})` });
        }
      }
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

  // #21d — THE EXIT AUDIT. How much text is still hidden in the main content
  // when the loop ends? residual ≈ 0 is a MEASURED completeness statement for
  // this page's DOM (content that only exists after an un-clicked AJAX call is
  // invisible to any static measure — that is what the click walk above is
  // for). A large residual becomes a per-page, machine-readable number in
  // page.meta / scan stats plus this warning — advisory, never blocking:
  // skeleton/placeholder boilerplate can false-positive, and a warning that
  // stopped the crawl would be worse than the gap it reports.
  // #9 — TRUTHFUL residual (truthfulResidual): the audit counts every element hidden
  // in the FINAL state, but a mutually-exclusive panel captured when it was open is a
  // known false-positive, so blocks whose text is already in the output are subtracted.
  let markdown = acc.toMarkdown();
  let hiddenResidualChars = truthfulResidual(
    lastPerception.hiddenResidualChars || 0,
    lastPerception.hiddenTexts || [],
    markdown,
  );

  // #9 Phase 1 — A11Y FALLBACK on a HIGH REAL residual. The strict perception drops
  // interactive elements with no label and no aria-controls (a bare role=tab, a
  // listener-only div, a hover-triggered toggle). On the RARE page where real text is
  // still hidden after the loop (residual high AFTER subtracting captured states) AND
  // the action budget was NOT the limit (hitCap ⇒ a --max-actions problem, not a
  // detection one), those unlabelled controls are the prime suspect. Re-perceive with
  // the label gate relaxed (a11y role / listener as a second element source — no vision
  // call), triage + click each NEW candidate once, and re-capture. Deterministic and
  // no-AI-safe (triage approves every mechanical candidate with no model), ADDITIVE
  // (rule #1 — it can only add content), bounded by RELAX_CAP and the budget. Runs only
  // here, so normal pages (low residual) never pay for it. Honest limit: it treats
  // these as in-place reveals (their usual shape) — a relaxed paginator is not walked;
  // that stays the vision half of #9, deliberately deferred (tiny, rare target).
  const RELAX_CAP = 8;
  if (!hitCap && actions < maxActions && !ctx.shouldStop() && hiddenResidualChars >= RESIDUAL_WARN_CHARS) {
    let clicked = 0;
    for (let tries = 0; tries < RELAX_CAP && actions < maxActions && !ctx.shouldStop() && hiddenResidualChars >= RESIDUAL_WARN_CHARS; tries++) {
      const relaxedPerception = await perceive(page, { relaxLabels: true });
      lastPerception = relaxedPerception; // the final residual/warning reflects this state
      const fresh = relaxedPerception.revealers.filter((r) => r.relaxed);
      if (!fresh.length) break;
      await triage(fresh);
      const next = fresh
        .filter((r) => decided.get(r.signature) && !doneLeaf.has(r.signature) && !shapeMuted(r))
        .sort((a, b) => revealPriority(b) - revealPriority(a))[0];
      if (!next) break;
      actions++;
      const res = await clickRevealer(page, next.id);
      doneLeaf.add(next.signature);
      if (res.navigatedTo) {
        navLinks.add(res.navigatedTo); // a nav-away is a link, captured by the frontier
        break;
      }
      const label = next.label && next.label.length <= 32 ? next.label : undefined;
      const added = await capture(label, `${next.kind}:${next.label || 'a11y'}`, next.top || 0);
      if (added) {
        clicked++;
        shapeFails.set(shapeKey(next), 0);
      } else {
        shapeFails.set(shapeKey(next), (shapeFails.get(shapeKey(next)) || 0) + 1);
      }
      markdown = acc.toMarkdown();
      hiddenResidualChars = truthfulResidual(
        relaxedPerception.hiddenResidualChars || 0,
        relaxedPerception.hiddenTexts || [],
        markdown,
      );
    }
    if (clicked) {
      ctx.emit({
        type: 'action',
        url,
        action: 'reveal',
        detail: `a11y fallback: revealed ${clicked} control(s) behind unlabelled triggers (high residual)`,
      });
    }
  }

  if (hiddenResidualChars >= RESIDUAL_WARN_CHARS) {
    const words = Math.round(hiddenResidualChars / 6);
    ctx.emit({
      type: 'warn',
      url,
      reason: 'reveal-residual',
      message:
        `~${words} words of text remain hidden ` +
        (hitCap
          ? 'behind controls the action budget did not reach — raise --max-actions for full coverage.'
          : 'behind elements no detected control reveals (measured, not judged).'),
    });
  }

  const links = [...allLinks.entries()].map(([href, label]) => ({ href, label }));
  return {
    markdown,
    blocks: acc.toBlocks(), // raw { text, provenance } in capture order, for layout
    // The FAITHFUL per-state record: every DISTINCT captured state, whole and
    // verbatim (byte-identical repeats — a chrome click that changed no content —
    // collapsed by states()). The consolidated markdown is compact (shared frame
    // once); this keeps each state's full co-occurrence recoverable, so a partial
    // change never loses its structure.
    states: acc.states(),
    title,
    links,
    navLinks: [...navLinks],
    routes: [...allRoutes],
    hitCap,
    hiddenResidualChars,
  };
}
