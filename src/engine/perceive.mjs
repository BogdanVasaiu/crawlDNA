// Behaviour-aware perception. Casts a wide net for anything that could hide
// content (tabs/accordions/"load more"/JS widgets). It scans the MAIN CONTENT
// first, then the site chrome (nav/header/footer) for its JS view-switchers — an
// SPA nav or app rail that swaps the view WITHOUT a URL — so no clickable that
// surfaces content is ever missed; the main content still gets the budget first
// (a chrome penalty in revealPriority). Plain <a href> nav stays a LINK (crawled
// as its own page), never an in-page revealer. Also surfaces in-content links,
// route candidates mined from page scripts, and one-time consent dismissals.

import { createHash } from 'node:crypto';

export async function perceive(page, { maxText = 2500, maxRevealers = 150, maxLinks = 400 } = {}) {
  const data = await page.evaluate(
    ({ maxRevealers, maxLinks }) => {
      // Clear the markers left by PREVIOUS perceive passes first. Ids restart from 0
      // on every pass; without this, an element stamped in an earlier pass keeps its
      // stale id while a different element gets the same number this pass — and the
      // actuator's [data-sagecrawl-id="N"] locator (.first()) can then click the
      // WRONG element. One wrong click corrupts the whole reveal walk.
      for (const el of document.querySelectorAll('[data-sagecrawl-id]')) {
        el.removeAttribute('data-sagecrawl-id');
      }
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const labelOf = (el) =>
        (
          el.getAttribute('aria-label') ||
          (el.innerText || '').trim() ||
          el.value ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('data-title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100);

      // Nearest preceding heading — gives the AI human-like context for judging a
      // control ("this button sits under 'Installation'"). Bounded walk.
      const nearestHeading = (el) => {
        let n = el;
        for (let hops = 0; n && hops < 6; hops++, n = n.parentElement) {
          let p = n.previousElementSibling;
          let scans = 0;
          while (p && scans++ < 10) {
            if (/^H[1-6]$/.test(p.tagName)) return (p.innerText || '').trim().slice(0, 80);
            const h = p.querySelector && p.querySelector('h1,h2,h3,h4,h5,h6');
            if (h) return (h.innerText || '').trim().slice(0, 80);
            p = p.previousElementSibling;
          }
        }
        return '';
      };

      // ---- pick the main content container (densest text) ------------------
      const CONTENT_CANDIDATES = [
        'main article', 'article', 'main', '[role=main]',
        '.devsite-article-body', '.markdown', '.markdown-body', '.content',
        '.doc-content', '#content', '.article-body',
      ];
      let mainEl = document.body;
      let bestLen = (document.body.innerText || '').length * 0.4; // bias toward a real container
      for (const sel of CONTENT_CANDIDATES) {
        for (const el of document.querySelectorAll(sel)) {
          const len = (el.innerText || '').length;
          if (len > bestLen) {
            bestLen = len;
            mainEl = el;
          }
        }
      }

      // "Site chrome" (global nav/header/footer) is detected from SEMANTIC LANDMARKS
      // only — the <nav>/<header>/<footer>/<aside> tags and ARIA landmark roles —
      // because those are universal, spec-defined signals. We deliberately do NOT
      // classify chrome from class-name SUBSTRINGS: a generic word like "header",
      // "toolbar", "menu" or "tab" routinely appears inside a CONTENT widget's
      // markup (e.g. a calendar's prev/next arrows live in `.monthly-header`, an
      // editor has a `.toolbar`), and a substring filter there silently hides real,
      // clickable content controls from the AI before it can judge them. Only a few
      // unambiguous, never-in-content chrome words are matched on class as a final
      // backstop. Everything else is surfaced and the AI decides (it already rejects
      // plain navigation). This keeps perception universal — no structure guessing.
      const CHROME_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
      const CHROME_RE = /(^|\s|[-_])(navbar|sidebar|breadcrumb|masthead|cookie|consent)(\s|[-_]|$)/i;
      const isChrome = (el) => {
        let n = el;
        while (n && n !== document.body) {
          if (CHROME_TAGS.has(n.tagName)) return true;
          const role = n.getAttribute && n.getAttribute('role');
          if (role && /navigation|banner|contentinfo/.test(role)) return true;
          const cls = (n.getAttribute && n.getAttribute('class')) || '';
          if (CHROME_RE.test(cls)) return true;
          n = n.parentElement;
        }
        return false;
      };

      const LOADMORE = /load\s*more|show\s*more|view\s*more|see\s*more|load\s*all|show\s*all|view\s*all|read\s*more|see\s*all|expand all/i;
      // `tab(?!le)` on purpose: a bare /tab/ also matches "table"/"tables" (Bootstrap's
      // `.table`, `.table-responsive`, data grids …), flooding the candidate list with
      // every styled table on the page — and the list is CAPPED (maxRevealers), so the
      // noise can crowd real tabs/accordions out of the AI triage entirely.
      const INTERACTIVE_CLASS = /(tab(?!le)|accordion|toggle|expand|collaps|dropdown|selector|switch|segment|pill|chip|disclosure|details|reveal)/i;
      // Article-toolbar actions that never reveal content (generic doc-UI verbs).
      const NON_CONTENT = /^(copy|copied|copy code|copy page|share|print|edit|edit this|report|feedback|send feedback|bookmark|explain|explain this|dark code|light code|theme|download|like|dislike|rate|thumb|subscribe|run in|try it|open in)\b/i;

      const candidateSel = [
        'button', 'summary', 'details', 'select',
        '[role=button]', '[role=tab]', '[role=menuitemradio]', '[role=switch]',
        '[role=option]', '[role=checkbox]', '[role=combobox]',
        '[aria-expanded]', '[aria-controls]', '[aria-selected]', '[aria-pressed]',
        '[onclick]', '[data-sagecrawl-listener]',
        'a[href^="#"]', 'a:not([href])',
        '[class*=tab]', '[class*=accordion]', '[class*=toggle]', '[class*=expand]',
        '[class*=collaps]', '[class*=disclosure]', '[class*=segment]',
      ].join(',');

      const considered = new Set();
      const revealers = [];
      let rid = 0;

      // ---- consent / overlay dismissals (page-wide, one-time) -------------
      // #21a — this block only MEASURES; the decision (which button to click,
      // reject-first, multilingual lexicon, primary-by-geometry) lives in
      // engine/consent.mjs where it is pure and unit-tested. A candidate must
      // live in a real OVERLAY (position:fixed/sticky, a dialog role, or
      // aria-modal): generic labels ("Continue", "OK", "Close") also caption
      // wizard steps and forms in the page flow, and clicking those BEFORE the
      // baseline capture mutates the very state the reveal pass is about to
      // explore. Banners are essentially always fixed or modal, so the overlay
      // test is the universal signal that separates them from content controls.
      const overlayRootOf = (el) => {
        let n = el;
        while (n && n !== document.documentElement) {
          const role = (n.getAttribute && n.getAttribute('role')) || '';
          if (/^(dialog|alertdialog)$/i.test(role)) return n;
          if (n.getAttribute && n.getAttribute('aria-modal') === 'true') return n;
          const pos = getComputedStyle(n).position;
          if (pos === 'fixed' || pos === 'sticky') return n;
          n = n.parentElement;
        }
        return null;
      };
      const consentCandidates = [];
      const overlayTexts = new Map(); // overlay element -> its text sample (computed once)
      for (const el of document.querySelectorAll('button, [role=button], input[type=button], input[type=submit], a')) {
        if (consentCandidates.length >= 24) break;
        if (!isVisible(el)) continue;
        const label = labelOf(el);
        if (!label || label.length >= 60) continue;
        const overlay = overlayRootOf(el);
        if (!overlay) continue;
        let overlayText = overlayTexts.get(overlay);
        if (overlayText === undefined) {
          overlayText = ((overlay.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 400);
          overlayTexts.set(overlay, overlayText);
        }
        const r = el.getBoundingClientRect();
        el.setAttribute('data-sagecrawl-id', String(rid));
        consentCandidates.push({
          id: rid,
          label,
          area: Math.round(r.width * r.height),
          overlayText,
          href: el.tagName === 'A' ? el.getAttribute('href') || '' : '',
        });
        rid++;
      }

      // ---- revealers: main content FIRST, then the rest of the page -------
      // Two lists over the SAME gauntlet, concatenated main-first. Pass 1 (main)
      // therefore wins the candidate cap (maxRevealers) and — via the chrome
      // penalty in revealPriority — the ACTION budget. Pass 2 (the whole body)
      // sweeps site chrome (nav/header/footer) for its JS view-switchers: an SPA
      // top-nav or app rail whose buttons swap the main view without a URL used to
      // be dropped entirely (it lives outside `mainEl` AND trips isChrome), so
      // every non-default view was silently lost (rule #1 — "prima mancava il
      // nav"). `considered` dedups the overlap, so main is processed once, first.
      const realMain = mainEl !== document.body;
      const candidates = realMain
        ? [...mainEl.querySelectorAll(candidateSel), ...document.body.querySelectorAll(candidateSel)]
        : [...document.body.querySelectorAll(candidateSel)];
      for (const el of candidates) {
        if (revealers.length >= maxRevealers) break;
        if (considered.has(el)) continue;
        considered.add(el);
        if (!isVisible(el)) continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || tag;
        const label = labelOf(el);
        const cls = el.getAttribute('class') || '';
        const style = getComputedStyle(el);
        const href = el.getAttribute('href') || '';
        const hasListener = el.hasAttribute('data-sagecrawl-listener') || el.hasAttribute('onclick');
        const ariaExpanded = el.getAttribute('aria-expanded');
        const ariaControls = el.getAttribute('aria-controls') || '';
        const ariaSelected = el.getAttribute('aria-selected');
        const ariaPressed = el.getAttribute('aria-pressed');

        // A JS CONTROL: a sniffed listener or an interactive tag/role — never a
        // plain <a> (that stays a link for the frontier gate). This is what may
        // survive the chrome check below, wherever on the page it lives.
        const jsControl =
          tag !== 'a' &&
          (hasListener ||
            ['button', 'summary', 'select', 'details'].includes(tag) ||
            ['button', 'tab', 'switch', 'option', 'checkbox', 'combobox', 'menuitemradio'].includes(role));

        // SITE CHROME. isChrome walks to <body>; an element NESTED in a REAL main
        // container sits under a landmark that is really app content (an embedded
        // app's own rail — #25), NOT site chrome. TRUE site chrome is what lies
        // OUTSIDE the real main (or the whole page under the <body> fallback). We
        // no longer drop it wholesale: a JS control (an SPA top-nav / app rail that
        // swaps the view — "prima mancava il nav") or a MEASURED disclosure (a
        // footer <details> FAQ) is kept and tagged `chrome`, so revealPriority
        // spends the action budget on content first while nothing clickable that
        // surfaces content is missed. main-internal keeps its exact #25 rule (a JS
        // control only). Works with no model at all — the closed-loop guards
        // (shape-muting, measured ordering) bound any chrome noise.
        const nestedInMain = realMain && mainEl.contains(el);
        const chrome = isChrome(el) && !nestedInMain;
        if (isChrome(el)) {
          const keep = nestedInMain ? jsControl : jsControl || ariaExpanded != null || !!ariaControls;
          if (!keep) continue;
        }

        // Skip DISABLED controls — clicking them reveals nothing, so they only burn
        // the action budget (e.g. a calendar's non-selectable days, a greyed-out
        // "next" at the last page). Universal UX signals only — not site structure:
        // the disabled property, aria-disabled, a disabled/inactive/not-selectable
        // class token, or a not-allowed cursor / pointer-events:none on the element.
        const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const classDisabled = /(^|[\s_-])(disabled|inactive|not[-_]?selectable)([\s_-]|$)/i.test(cls);
        if (el.disabled === true || ariaDisabled || classDisabled || style.cursor === 'not-allowed' || style.pointerEvents === 'none') {
          continue;
        }

        // Any <a> with a real destination is a NAVIGATION candidate — it's
        // discovered as a link and the AI decides whether it's a real page.
        // It's never treated as an in-page revealer. Only href-less <a> and a
        // bare "#" stay as possible JS toggles. No URL-shape assumptions here.
        const hasNavHref = tag === 'a' && href && href !== '#' && !/^javascript:/i.test(href);
        if (hasNavHref) continue;

        const pointer = style.cursor === 'pointer';
        const interactiveClass = INTERACTIVE_CLASS.test(cls);

        const interactive =
          ['button', 'summary', 'details', 'select'].includes(tag) ||
          ['button', 'tab', 'switch', 'option', 'checkbox', 'combobox', 'menuitemradio'].includes(role) ||
          ariaExpanded != null || ariaControls || ariaSelected != null || ariaPressed != null ||
          hasListener || pointer || interactiveClass;
        if (!interactive) continue;
        if (!label && !ariaControls && tag !== 'details' && tag !== 'summary') continue;

        let kind = 'control';
        if (LOADMORE.test(label)) kind = 'loadmore';
        else if (tag === 'select' || role === 'combobox' || role === 'listbox' || /(^|\s|[-_])(dropdown|combobox|listbox|select)(\s|[-_]|$)/i.test(cls)) kind = 'dropdown';
        else if (role === 'tab' || ariaSelected != null || ariaPressed != null || /(^|\s|-)tab(\s|-|$)/i.test(cls)) kind = 'tab';
        else if (ariaExpanded != null || ariaControls || tag === 'summary' || tag === 'details' || /accordion|collaps|expand|disclosure/i.test(cls)) kind = 'expander';

        // Pure UI actions (copy/share/print/feedback/…) never reveal content —
        // drop them deterministically so neither the AI nor the fallback wastes a
        // click. This is universal (not per-site), so it stays a hard filter.
        if (NON_CONTENT.test(label)) continue;

        // Heuristic guess "this likely reveals content" — since #21b no longer a
        // gate (no-AI approves every candidate), only an ORDERING hint plus extra
        // context for the model. English-biased by nature, which is exactly why
        // it stopped being load-bearing.
        const DISCLOSURE_LABEL =
          /\b(show|view|see|load|read|expand)\b[^.]{0,20}\b(more|all|less|api|details?|code|example|source|reference)\b|toggle|inline api|reveal|full (?:api|list)/i;
        const heuristic = kind !== 'control' || DISCLOSURE_LABEL.test(label);

        // #21b — MEASURE the hidden payload behind this control instead of
        // guessing from words: the text mass of its aria-controls target when
        // that target is currently invisible, else of a hidden sibling panel
        // (accordion body next to its header), else the unopened remainder of a
        // <details>. A measured payload is mechanical proof the control hides
        // content — it later overrides a wrong "no" from any judge (AI or
        // heuristic), and ranks candidates when there is no judge at all.
        let hiddenPayload = 0;
        if (ariaControls) {
          for (const tid of ariaControls.split(/\s+/)) {
            const t = document.getElementById(tid);
            if (t && !isVisible(t)) hiddenPayload += ((t.textContent || '').replace(/\s+/g, ' ').trim()).length;
          }
        }
        if (!hiddenPayload) {
          const sib = el.nextElementSibling;
          if (sib && !isVisible(sib)) hiddenPayload += ((sib.textContent || '').replace(/\s+/g, ' ').trim()).length;
        }
        if (!hiddenPayload && tag === 'summary' && el.parentElement && el.parentElement.tagName === 'DETAILS' && !el.parentElement.open) {
          const whole = ((el.parentElement.textContent || '').replace(/\s+/g, ' ').trim()).length;
          const own = ((el.textContent || '').replace(/\s+/g, ' ').trim()).length;
          hiddenPayload += Math.max(0, whole - own);
        }
        const expanded = ariaExpanded; // raw aria-expanded value ('false' = closed disclosure)

        const signature = `${role}|${label}|${ariaControls}|${kind}`;
        // REUSE an id already stamped by the consent block above. Now that pass 2
        // scans the whole page, a sticky-header / banner button can be BOTH a
        // consentCandidate and a revealer; overwriting its id with a fresh rid
        // would strand the consentCandidate reference and break dismissal. Consent
        // ids [0,k) and revealer ids [k,…) share one counter and never collide, so
        // a reused id stays unique. Unmarked → take (and stamp) the next fresh id.
        const marked = el.getAttribute('data-sagecrawl-id');
        const cid = marked != null ? Number(marked) : rid++;
        if (marked == null) el.setAttribute('data-sagecrawl-id', String(cid));
        // #27 — the control's ABSOLUTE vertical position in the page. It orders the
        // reveal states in the output by REPRESENTATION (proximity to the base): an
        // app's nav rail runs Dashboard→Analytics→Chat→Settings top-to-bottom, so
        // the view each item opens lands in that order — not in the order the engine
        // happened to click them. Horizontal tab strips share a `top`, so they keep
        // their left-to-right discovery order (stable). Read once, here.
        const rct = el.getBoundingClientRect();
        const top = Math.round(rct.top + (window.scrollY || window.pageYOffset || 0));
        revealers.push({ id: cid, kind, label, role, cls: cls.slice(0, 60), context: nearestHeading(el), heuristic, signature, hiddenPayload, expanded, top, chrome });
      }

      // ---- links: every destination on the page (nav/footer/app-bar included)
      // Surface ALL of them with labels — real URLs, fragment routes (#/contact),
      // query routes (?view=pricing), same-page anchors, anything. The algorithm
      // makes NO judgement about URL shape; the frontier scopes them and the AI
      // gate decides which are real pages worth following (vs same-page anchors
      // or off-task links). This is what lets non-obvious / framework-specific
      // navigation be caught without per-case rules. Only mailto/tel/javascript
      // and a bare "#" are dropped (never pages).
      const links = [];
      const seenHref = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        if (links.length >= maxLinks) break;
        const href = a.getAttribute('href');
        if (!href || href === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
        let abs;
        try {
          abs = new URL(href, location.href).toString();
        } catch (e) {
          continue;
        }
        if (seenHref.has(abs)) continue;
        seenHref.add(abs);
        links.push({ label: labelOf(a), href: abs });
      }

      // ---- #21d: audit of the STILL-HIDDEN text in the main content -------
      // The closed loop's measure: how many characters of real text remain
      // invisible right now? Counted on the TOPMOST hidden element only (a
      // hidden subtree is one payload, not N), skipping <template>/<script>/
      // <style> and aria-hidden=true (decorative/duplicated boilerplate by
      // contract) and ignoring crumbs. Revealing content makes this number
      // FALL — so "residual ≈ 0" is a measured completeness statement, not a
      // judgment. It travels to page.meta / stats / a warning in the caller.
      let hiddenResidualChars = 0;
      {
        const skip = (el) =>
          el.tagName === 'TEMPLATE' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' ||
          el.getAttribute('aria-hidden') === 'true';
        const stack = [...mainEl.children];
        let visits = 0;
        while (stack.length && visits++ < 20000) {
          const el = stack.pop();
          if (skip(el)) continue;
          if (!isVisible(el)) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length > 40) hiddenResidualChars += t.length;
            continue; // topmost hidden only — never double-count its children
          }
          for (const c of el.children) stack.push(c);
        }
      }

      // ---- routes mined from scripts/JSON ---------------------------------
      const routes = new Set();
      const origin = location.origin;
      let blob = '';
      for (const s of document.querySelectorAll('script[type="application/json"], script[id="__NEXT_DATA__"]')) {
        blob += '\n' + (s.textContent || '');
      }
      let inlineBudget = 200000;
      for (const s of document.querySelectorAll('script:not([src])')) {
        if (inlineBudget <= 0) break;
        const t = s.textContent || '';
        blob += '\n' + t.slice(0, inlineBudget);
        inlineBudget -= t.length;
      }
      const pathRe = /["'`](\/[A-Za-z0-9._~\-/]+)["'`]/g;
      let mm;
      while ((mm = pathRe.exec(blob)) && routes.size < 800) {
        const p = mm[1];
        if (/\.(js|css|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|map|json|mjs)$/i.test(p)) continue;
        if (p.length < 2 || p.startsWith('//')) continue;
        try {
          routes.add(new URL(p, origin).toString());
        } catch (e) {}
      }

      const mainText = ((mainEl && mainEl.innerText) || document.body.innerText || '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      return {
        url: location.href,
        title: document.title,
        mainText,
        revealers,
        consentCandidates,
        links,
        hiddenResidualChars,
        routes: [...routes],
        scrollHeight: document.body.scrollHeight,
      };
    },
    { maxRevealers, maxLinks },
  );

  data.mainText = data.mainText.slice(0, maxText);
  data.fingerprint = fingerprintOf(data);
  return data;
}

// #26 — mark VISUAL headings: elements the page styles AS titles (a short
// standalone line whose font JUMPS vs the local body text) without using <h*>.
// Apps mark titles visually, not semantically — Turndown only trusts <h1>–<h6>,
// so every card/section title painted with a bigger font flattens to anonymous
// text and the page loses its skeleton. Runs IN THE BROWSER (getComputedStyle):
// self-contained ON PURPOSE — reveal's captureHtml inlines it via .toString()
// into its evaluate, atomically with the data-sagecrawl-hidden pass (mark →
// serialize → unmark), so no marker ever leaks into the live DOM of the next
// state. The signal is a RATIO, never a class name (rule #2): fontSize ≥ 1.15×
// the LOCAL body font, or bold (≥600) at ≥ body size. The level maps from the
// jump vs the PAGE body font (≥1.8→h2, ≥1.35→h3, else h4) — never h1, and real
// <h*>/[role=heading] are never touched or re-levelled: their semantics win, we
// only ADD structure the page painted (rule #1: nothing removed or rewritten).
// extract.mjs converts the marker to ##/###/#### and has a Node twin of this
// heuristic for inline styles (static path) — keep the two in sync.
export function markVisualHeadings() {
  const marked = [];
  if (!document.body) return marked;
  // Clear stale markers first (same defensive pattern as data-sagecrawl-id).
  for (const el of document.querySelectorAll('[data-sagecrawl-heading]')) {
    el.removeAttribute('data-sagecrawl-heading');
  }
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const styleCache = new Map();
  const styleOf = (el) => {
    let s = styleCache.get(el);
    if (!s) {
      const cs = getComputedStyle(el);
      s = {
        size: parseFloat(cs.fontSize) || 0,
        weight: parseInt(cs.fontWeight, 10) || 400,
        display: cs.display,
      };
      styleCache.set(el, s);
    }
    return s;
  };
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1 };
  // Text metrics of a subtree (optionally excluding one branch): VISIBLE text
  // only, char-weighted size histogram + extremes. Budgeted — titles are tiny,
  // and the ancestor scans below break as soon as they have enough chars.
  const statsOf = (root, excl) => {
    const st = { chars: 0, bySize: new Map(), maxSize: 0, minSize: Infinity, maxWeight: 0 };
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    let visits = 0;
    while ((n = w.nextNode()) && visits++ < 400) {
      const el = n.parentElement;
      if (!el || SKIP_TAGS[el.tagName]) continue;
      if (excl && excl.contains(n)) continue;
      const t = norm(n.nodeValue);
      if (!t) continue;
      if (!el.getClientRects().length) continue; // display:none text doesn't vote
      const s = styleOf(el);
      if (!s.size) continue;
      const key = Math.round(s.size * 2) / 2;
      st.chars += t.length;
      st.bySize.set(key, (st.bySize.get(key) || 0) + t.length);
      if (key > st.maxSize) st.maxSize = key;
      if (key < st.minSize) st.minSize = key;
      if (s.weight > st.maxWeight) st.maxWeight = s.weight;
    }
    return st;
  };
  const dominant = (bySize, fallback) => {
    let best = fallback;
    let chars = 0;
    for (const e of bySize) {
      if (e[1] > chars) {
        chars = e[1];
        best = e[0];
      }
    }
    return best;
  };

  // ONE pass over the page's text: the char-weighted font histogram (its mode
  // is the page BODY font) and, per text line, the block that owns it (the
  // candidate set — nearest non-inline ancestor, so a big <span> inside a
  // wrapper <div> still surfaces the wrapper as the title block).
  const pageSizes = new Map();
  const blocks = [];
  const seenBlocks = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  let visits = 0;
  while ((node = walker.nextNode()) && visits++ < 20000) {
    const el = node.parentElement;
    if (!el || SKIP_TAGS[el.tagName]) continue;
    const t = norm(node.nodeValue);
    if (t.length < 2) continue;
    if (!el.getClientRects().length) continue;
    const s = styleOf(el);
    if (!s.size) continue;
    const key = Math.round(s.size * 2) / 2;
    pageSizes.set(key, (pageSizes.get(key) || 0) + t.length);
    let b = el;
    while (b && b !== document.body && styleOf(b).display === 'inline') b = b.parentElement;
    if (b && b !== document.body && !seenBlocks.has(b)) {
      seenBlocks.add(b);
      blocks.push(b); // document order — outer titles mark before inner dupes
    }
  }
  const body = dominant(pageSizes, 16);

  // Never a heading: interactive/label surfaces, cells, list items (#25), code,
  // real headings — and anything under an already-marked title (no nesting).
  const BANNED =
    'a,button,h1,h2,h3,h4,h5,h6,table,th,td,li,ul,ol,dl,pre,code,kbd,samp,label,select,option,textarea,input,summary,figcaption,blockquote,nav,aside,footer,[role=heading],[role=button],[role=tab],[role=list],[role=listitem],[data-sagecrawl-heading]';
  const STRUCTURAL = 'h1,h2,h3,h4,h5,h6,table,ul,ol,pre,blockquote,button,a,input,select,textarea';
  for (const el of blocks) {
    const text = norm(el.textContent);
    if (text.length < 2 || text.length > 60) continue; // a title is one short line
    if (!/\p{L}/u.test(text)) continue; // bare numbers/prices are data, not titles
    if (el.closest(BANNED)) continue;
    if (el.querySelector(STRUCTURAL)) continue;
    // A title INSIDE a repeated row that #25 flattens to a bullet must not be
    // marked (the marker would collapse into the bullet as a stray `- #### …`).
    // The candidate is often a title-wrapper NESTED in the card, so test
    // ANCESTORS, not just the element's own siblings: the 8 gallery tiles, the
    // 4 stat cards and the colour swatches all sit one level up. Same shape
    // signal as extract's shapedRowItem (tag + first class token, ≥3 siblings,
    // short, no block content). Summary/Transactions/Recent Orders survive:
    // their cards carry a table/list or have <3 same-shape siblings.
    const firstCls = (n) => ((n.getAttribute && n.getAttribute('class')) || '').split(/\s+/)[0] || '';
    const isFlattenedRow = (a) => {
      if (!a || a === document.body) return false;
      if ((a.getAttribute && a.getAttribute('role')) === 'listitem') return true;
      if (a.tagName !== 'DIV') return false;
      const c0 = firstCls(a);
      if (!c0) return false;
      const t = norm(a.textContent);
      if (!t || t.length > 200) return false;
      if (a.querySelector && a.querySelector('h1,h2,h3,h4,h5,h6,table,pre,ul,ol')) return false;
      const par = a.parentElement;
      if (!par) return false;
      let alike = 0;
      for (const sib of par.children) if (sib.tagName === a.tagName && firstCls(sib) === c0) alike++;
      return alike >= 3;
    };
    let inRow = false;
    for (let a = el, hops = 0; a && a !== document.body && hops < 6; a = a.parentElement, hops++) {
      if (isFlattenedRow(a)) {
        inRow = true;
        break;
      }
    }
    if (inRow) continue;
    const st = statsOf(el);
    if (!st.chars || st.maxSize < body) continue; // never smaller than the page body font
    if (st.minSize < 0.75 * st.maxSize) continue; // mixed sizes = composite (stat value + caption), not a title
    // LOCAL body font: the dominant size of the SURROUNDING text (nearest
    // ancestor with enough of it) — a block that is ALL large text (a hero)
    // must not promote its own lines.
    let local = body;
    let anc = el.parentElement;
    for (let hops = 0; anc && anc !== document.documentElement && hops < 6; hops++, anc = anc.parentElement) {
      const around = statsOf(anc, el);
      if (around.chars >= 40) {
        local = dominant(around.bySize, body);
        break;
      }
    }
    const jump = st.maxSize >= 1.15 * local || (st.maxWeight >= 600 && st.maxSize >= local);
    if (!jump) continue;
    const ratio = st.maxSize / body;
    const level = ratio >= 1.8 ? 2 : ratio >= 1.35 ? 3 : 4;
    el.setAttribute('data-sagecrawl-heading', String(level));
    marked.push(el);
  }
  return marked;
}

function fingerprintOf(data) {
  const basis = [
    Math.round((data.mainText.length || 0) / 40),
    data.revealers.length,
    Math.round((data.scrollHeight || 0) / 200),
    data.revealers.map((r) => r.signature).join('§'),
    data.mainText.slice(0, 400),
  ].join('#');
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}
