// Network layer: plain fetch, with optional escalation to a real browser when
// a page looks like a JS-rendered shell or the caller forces it.

import { isBrowserAvailable, newPage } from './browser.mjs';
import { settle } from './settle.mjs';

const DEFAULT_HEADERS = {
  'user-agent': 'sagecrawl/0.1 (+https://github.com/sagecrawl)',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  'accept-language': 'en-US,en;q=0.9',
};

/** Plain `fetch` returning text. Never throws — failures come back as `ok:false`. */
export async function fetchText(url, { headers, timeout = 30000, accept } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { ...DEFAULT_HEADERS, ...(accept ? { accept } : {}), ...headers },
    });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, contentType, finalUrl: res.url || url };
  } catch (err) {
    return { ok: false, status: 0, text: '', contentType: '', finalUrl: url, error: err };
  } finally {
    clearTimeout(timer);
  }
}

/** Rough "did this HTML arrive with real content?" heuristic. */
export function looksRendered(html) {
  if (!html) return false;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 800;
}

/**
 * Load a page's HTML, escalating to the browser when needed.
 *
 * `browserMode`:
 *   - 'never'  : plain fetch only.
 *   - 'auto'   : fetch first; render with the browser only if the page looks
 *                like an empty SPA shell (and Playwright is available).
 *   - 'always' : render with the browser (fall back to fetch if unavailable).
 *
 * Returns `{ html, finalUrl, status, rendered }`.
 */
export async function loadHtml(url, { browserMode = 'auto', ctx } = {}) {
  let staticRes = null;

  if (browserMode !== 'always') {
    staticRes = await fetchText(url);
    if (browserMode === 'never') {
      return { html: staticRes.text, finalUrl: staticRes.finalUrl, status: staticRes.status, rendered: false };
    }
    if (staticRes.ok && looksRendered(staticRes.text)) {
      return { html: staticRes.text, finalUrl: staticRes.finalUrl, status: staticRes.status, rendered: false };
    }
  }

  // We want (or need) the browser.
  if (await isBrowserAvailable()) {
    let release;
    try {
      const p = await newPage();
      release = p.release;
      const { page } = p;
      let status = 200;
      try {
        // domcontentloaded + response-quiet (#15), NOT waitUntil:'networkidle':
        // a site holding a websocket/long-poll open never reaches idle, which
        // made this goto burn its FULL 45s timeout before falling through.
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        status = resp ? resp.status() : 200;
        await settle(page, { maxMs: 8000 });
      } catch {
        // fall back to whatever rendered before the timeout
      }
      const html = await page.content();
      const finalUrl = page.url();
      return { html, finalUrl, status, rendered: true };
    } catch (err) {
      if (staticRes) {
        return { html: staticRes.text, finalUrl: staticRes.finalUrl, status: staticRes.status, rendered: false, error: err };
      }
      return { html: '', finalUrl: url, status: 0, rendered: false, error: err };
    } finally {
      if (release) await release(); // return the context to the pool (reuse its asset cache)
    }
  }

  // Browser wanted but unavailable.
  if (browserMode === 'always' && ctx?.emit) {
    ctx.emit({
      type: 'warn',
      url,
      reason: 'browser-missing',
      message:
        'Browser mode "always" was requested but Playwright is not installed. ' +
        'Run: npm install playwright && npx playwright install chromium. Using a plain fetch instead.',
    });
  }
  if (staticRes) {
    return { html: staticRes.text, finalUrl: staticRes.finalUrl, status: staticRes.status, rendered: false };
  }
  const res = await fetchText(url);
  return { html: res.text, finalUrl: res.finalUrl, status: res.status, rendered: false };
}
