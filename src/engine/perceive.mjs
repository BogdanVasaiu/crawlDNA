// Behaviour-aware perception. Casts a wide net for anything in the MAIN CONTENT
// that could hide content (tabs/accordions/"load more"/JS widgets) — but ignores
// site chrome (nav/header/footer/menus) so the reveal budget is spent on content,
// not on flailing through global navigation. Also surfaces in-content links,
// route candidates mined from page scripts, and one-time consent dismissals.

import { createHash } from 'node:crypto';

export async function perceive(page, { maxText = 2500, maxRevealers = 150, maxLinks = 400 } = {}) {
  const data = await page.evaluate(
    ({ maxRevealers, maxLinks }) => {
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
      const INTERACTIVE_CLASS = /(tab|accordion|toggle|expand|collaps|dropdown|selector|switch|segment|pill|chip|disclosure|details|reveal)/i;
      // Article-toolbar actions that never reveal content (generic doc-UI verbs).
      const NON_CONTENT = /^(copy|copied|copy code|copy page|share|print|edit|edit this|report|feedback|send feedback|bookmark|explain|explain this|dark code|light code|theme|download|like|dislike|rate|thumb|subscribe|run in|try it|open in)\b/i;

      const candidateSel = [
        'button', 'summary', 'details', 'select',
        '[role=button]', '[role=tab]', '[role=menuitemradio]', '[role=switch]',
        '[role=option]', '[role=checkbox]', '[role=combobox]',
        '[aria-expanded]', '[aria-controls]', '[aria-selected]', '[aria-pressed]',
        '[onclick]', '[data-docdna-listener]',
        'a[href^="#"]', 'a:not([href])',
        '[class*=tab]', '[class*=accordion]', '[class*=toggle]', '[class*=expand]',
        '[class*=collaps]', '[class*=disclosure]', '[class*=segment]',
      ].join(',');

      const considered = new Set();
      const revealers = [];
      let rid = 0;

      // ---- consent / overlay dismissals (page-wide, one-time) -------------
      const consent = [];
      const CONSENT_RE = /\b(accept|agree|got it|i understand|okay|ok\b|allow all|consent|dismiss|continue|reject all|close)\b/i;
      for (const el of document.querySelectorAll('button, [role=button], a')) {
        if (consent.length >= 6) break;
        if (!isVisible(el)) continue;
        const label = labelOf(el);
        if (label && label.length < 40 && CONSENT_RE.test(label)) {
          el.setAttribute('data-docdna-id', String(rid));
          consent.push({ id: rid, label });
          rid++;
        }
      }

      // ---- revealers, scoped to the main content --------------------------
      for (const el of mainEl.querySelectorAll(candidateSel)) {
        if (revealers.length >= maxRevealers) break;
        if (considered.has(el)) continue;
        considered.add(el);
        if (!isVisible(el)) continue;
        if (isChrome(el)) continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || tag;
        const label = labelOf(el);
        const cls = el.getAttribute('class') || '';
        const style = getComputedStyle(el);
        const href = el.getAttribute('href') || '';

        // Any <a> with a real destination is a NAVIGATION candidate — it's
        // discovered as a link and the AI decides whether it's a real page.
        // It's never treated as an in-page revealer. Only href-less <a> and a
        // bare "#" stay as possible JS toggles. No URL-shape assumptions here.
        const hasNavHref = tag === 'a' && href && href !== '#' && !/^javascript:/i.test(href);
        if (hasNavHref) continue;

        const ariaExpanded = el.getAttribute('aria-expanded');
        const ariaControls = el.getAttribute('aria-controls') || '';
        const ariaSelected = el.getAttribute('aria-selected');
        const ariaPressed = el.getAttribute('aria-pressed');
        const hasListener = el.hasAttribute('data-docdna-listener') || el.hasAttribute('onclick');
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

        // Heuristic guess "this likely reveals content", used ONLY as the FALLBACK
        // when the AI triage (aiSelectRevealers) is unavailable. The AI is the
        // primary judge — it can approve a generic/unlabelled control hiding
        // content in an improbable place that this regex would miss, and reject a
        // live-demo widget (date-picker/slider/stepper) the regex can't tell apart.
        // So we now KEEP every interactive candidate and let the model decide.
        const DISCLOSURE_LABEL =
          /\b(show|view|see|load|read|expand)\b[^.]{0,20}\b(more|all|less|api|details?|code|example|source|reference)\b|toggle|inline api|reveal|full (?:api|list)/i;
        const heuristic = kind !== 'control' || DISCLOSURE_LABEL.test(label);

        const signature = `${role}|${label}|${ariaControls}|${kind}`;
        el.setAttribute('data-docdna-id', String(rid));
        revealers.push({ id: rid, kind, label, role, cls: cls.slice(0, 60), context: nearestHeading(el), heuristic, signature });
        rid++;
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

      // ---- hidden content present (for warnings) --------------------------
      let hiddenCount = 0;
      for (const el of mainEl.querySelectorAll('[hidden],[aria-hidden=true]')) {
        if ((el.textContent || '').trim().length > 40) hiddenCount++;
        if (hiddenCount > 999) break;
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
        consent,
        links,
        hiddenCount,
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
