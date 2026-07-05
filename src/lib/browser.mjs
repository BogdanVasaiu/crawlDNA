// Lazy Playwright loader. Playwright is an optional dependency: nothing here
// imports it until a crawl actually needs the browser as an actuator.

let _pw = null;
let _imported = null; // null = unknown
let _browser = null;
let _error = null; // clean, user-facing reason when unavailable

async function importPlaywright() {
  if (_imported !== null) return _imported;
  try {
    _pw = await import('playwright');
    _imported = true;
  } catch {
    _imported = false;
    _error = 'Playwright is not installed. Run: npm install playwright && npx playwright install chromium';
  }
  return _imported;
}

function cleanLaunchError(err) {
  const msg = String((err && err.message) || err || '');
  if (/Executable doesn'?t exist|playwright install|Looks like Playwright/i.test(msg)) {
    return 'Chromium is not fully installed. Run: npx playwright install chromium';
  }
  return 'Browser launch failed: ' + msg.split('\n')[0];
}

/** A clean, user-facing reason the browser is unavailable, or null. */
export function browserError() {
  return _error;
}

/** Launch (once) and return a shared headless Chromium browser. Clean errors. */
export async function getBrowser() {
  if (_browser) return _browser;
  if (!(await importPlaywright())) throw new Error(_error);
  try {
    _browser = await _pw.chromium.launch({ headless: true });
  } catch (err) {
    _error = cleanLaunchError(err);
    throw new Error(_error);
  }
  return _browser;
}

/**
 * True if the browser can actually launch — verified once by a real launch
 * (the launched browser is cached for reuse), not just a module import. A
 * missing/partial browser binary therefore degrades cleanly instead of throwing
 * on every page mid-crawl. Never throws.
 */
export async function isBrowserAvailable() {
  if (_browser) return true; // already launched and cached
  if (!(await importPlaywright())) return false;
  try {
    await getBrowser();
    return true;
  } catch {
    // Do NOT cache a failure: the browser may be installed between crawls (e.g.
    // a long-running `serve`). Re-probe next time rather than staying stuck.
    return false;
  }
}

// Runs before any page script. Monkey-patches addEventListener so that ANY
// element which registers a click-like listener — however it was built, even a
// plain <div> with a JS handler — is tagged. This is how we spot non-obvious
// interactivity universally, without per-site selectors.
const SNIFFER = `(() => {
  try {
    const proto = EventTarget.prototype;
    const orig = proto.addEventListener;
    const INTERESTING = { click: 1, mousedown: 1, pointerdown: 1, keydown: 1, change: 1 };
    proto.addEventListener = function (type, listener, opts) {
      try {
        if (INTERESTING[type] && this && this.nodeType === 1) {
          this.setAttribute('data-crawldna-listener', '1');
        }
      } catch (e) {}
      return orig.call(this, type, listener, opts);
    };
  } catch (e) {}
})();`;

const CONTEXT_OPTS = {
  userAgent: 'crawldna/0.1 (+https://crawldna.com)',
  viewport: { width: 1280, height: 900 },
};

// --- Browser-context pool (asset-cache reuse across pages) ------------------
// A brand-new context per page throws away the browser's HTTP cache, so the site's
// shared CSS/JS/fonts are re-downloaded on EVERY page — pure waste on a docs site with
// hundreds of same-styled pages. Instead we keep a small pool of contexts and REUSE
// them: within a context the HTTP cache is shared, so a page's static assets are fetched
// once and served from cache thereafter. Parallelism is preserved — the pool holds up to
// `_maxIdle` idle contexts (set to the crawl's concurrency), so N workers each keep their
// own context alive between pages.
//
// COMPLETENESS IS NOT AT RISK (the project's first rule). Reuse only shares the ASSET
// cache; it does not change what a page renders for us, because the engine (1) opens a
// FRESH page and navigates fresh for every URL, and (2) exhaustively clicks EVERY reveal
// control regardless of any remembered client state — so accumulated cookies/localStorage
// can't hide content from extraction (a "remembered" tab is still clicked; a first-visit
// tour is chrome, not content). Contexts are recycled after `_maxUses` pages as plain
// hygiene against a pathological page corrupting one. Consent is still dismissed per page
// by the reveal engine, so a carried-over consent cookie only ever helps.
const _idleContexts = [];
let _maxIdle = 8; // set from concurrency by configureContextPool
const _maxUses = 100; // recycle a context after this many pages

/** Size the idle pool to the crawl's concurrency so each worker keeps its own context. */
export function configureContextPool(concurrency) {
  _maxIdle = Math.max(1, Number(concurrency) || 1);
}

async function makeContext() {
  const browser = await getBrowser();
  const context = await browser.newContext(CONTEXT_OPTS);
  await context.addInitScript(SNIFFER); // once per context, not per page
  context.__uses = 0;
  return context;
}

/** Return a context to the pool for reuse, or close it once it's served enough pages
 *  (or the idle pool is already full). Never throws. */
async function releaseContext(context) {
  if (!context) return;
  context.__uses = (context.__uses || 0) + 1;
  if (context.__uses >= _maxUses || _idleContexts.length >= _maxIdle) {
    await context.close().catch(() => {});
    return;
  }
  _idleContexts.push(context);
}

/**
 * A fresh page for one URL, drawn from a REUSED browser context (shared asset cache),
 * plus a `release()` to return the context to the pool when the page is done.
 * The sniffer is already installed on the context. Callers MUST call `release()` (not
 * `context.close()`) to get the caching benefit — closing the context still works but
 * forfeits reuse.
 *
 * @returns {Promise<{ page, context, release: () => Promise<void> }>}
 */
export async function newPage() {
  // Reuse an idle context if one is available; a stale/broken one is dropped and a
  // fresh context made, so a bad context can never wedge the crawl.
  let context = _idleContexts.pop();
  let page;
  if (context) {
    try {
      page = await context.newPage();
    } catch {
      await context.close().catch(() => {});
      context = null;
    }
  }
  if (!context) {
    context = await makeContext();
    page = await context.newPage();
  }

  let released = false;
  const release = async () => {
    if (released) return; // idempotent: safe to call from both catch and finally
    released = true;
    try {
      await page.close();
    } catch {
      /* ignore */
    }
    await releaseContext(context);
  };
  return { page, context, release };
}

/** Close the shared browser, if any, and drop the pooled contexts. Safe to call
 *  multiple times (e.g. once per run — the browser relaunches lazily next run). */
export async function closeBrowser() {
  _idleContexts.length = 0; // the contexts are closed with the browser below
  if (_browser) {
    try {
      await _browser.close();
    } catch {
      /* ignore */
    }
    _browser = null;
  }
}

// --- run-scoped ownership of the shared browser ------------------------------
// The browser is ONE process shared by every crawl in this Node process. A run
// that closed it unconditionally when it finished would pull it out from under a
// run still using it — exactly what happened when the UI stopped a crawl and
// immediately started the next one (the old run's cleanup killed the new run's
// pages). So runs RETAIN the browser for their lifetime and only the LAST release
// actually closes it.
let _retainers = 0;

/** Mark a run as using the shared browser. Pair with releaseBrowser(). */
export function retainBrowser() {
  _retainers++;
}

/** Release a run's hold; closes the browser once no run holds it. */
export async function releaseBrowser() {
  _retainers = Math.max(0, _retainers - 1);
  if (_retainers === 0) await closeBrowser();
}

let _installTried = false;

/**
 * Make sure the browser can launch, installing Chromium once if it is missing.
 * Returns true when the browser is ready. Used at `serve` startup so the user
 * never hits a mid-crawl "browser not installed" error.
 */
export async function ensureBrowser({ log = () => {} } = {}) {
  if (await isBrowserAvailable()) return true;
  if (_installTried) return false;
  _installTried = true;

  log('Chromium not found — installing it once (this is a one-time ~150MB download)…');
  const { spawn } = await import('node:child_process');
  const ok = await new Promise((resolve) => {
    try {
      const child = spawn('npx', ['playwright', 'install', 'chromium', 'chromium-headless-shell'], {
        stdio: 'inherit',
        shell: true,
      });
      child.on('exit', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
  if (!ok) return false;
  return isBrowserAvailable();
}
