// The render-wait signal (#15): "response-quiet + stable text", bounded.
// Shared by the initial page render (engine/crawl-page.mjs), the reveal loop's
// post-click wait and base restore (engine/actions.mjs, engine/reveal.mjs), and
// the browser-escalation fetch (lib/fetcher.mjs). Pure JS over the Playwright
// page interface — no Playwright import, so it unit-tests with a fake page.

/**
 * Wait for a page's async activity to FULLY land before the caller captures,
 * WITHOUT over-waiting when nothing is happening.
 *
 * The hard case that shaped it (post-click): a widget whose FIRST interaction
 * triggers a one-time cascade of lazy-loaded scripts (a booking calendar pulls
 * in pikaday / jquery-ui / sweetalert / recaptcha the first time a day is
 * picked) that delays the real content — the day's slot grid — by ~1s, during
 * which the visible TEXT sits on a flat plateau. A DOM-stability poll is fooled
 * by that plateau and snapshots the page without the slots; `networkidle` with
 * a fixed timeout either under- or over-waits and, when it over-waits,
 * desynchronises the click→reveal→restore rhythm so per-day panels are lost.
 *
 * The reliable signal is the RESPONSE STREAM: real content arrives on a network
 * response, so wait until a response has come back AND the network has then
 * been quiet for a short grace window, with the DOM text no longer changing.
 * An action that fetches waits exactly as long as its cascade runs; one that
 * fetches NOTHING sees no response and falls through after the same short
 * grace — so no-ops stay cheap. Bounded by maxMs so recaptcha/ads heartbeats
 * can't stall the crawl. Generic — no per-site assumptions.
 *
 * Crucially for the initial render (#15), quietness counts response EVENTS —
 * not open connections like `networkidle` does — so a site holding a
 * websocket / SSE / long-poll connection open (where the idle signal NEVER
 * fires and a networkidle wait burned its full timeout on every page) exits
 * after one grace window like any quiet page.
 *
 * @param {import('playwright').Page} page  anything with on/off('response'),
 *   waitForTimeout(ms) and evaluate(fn) — duck-typed for testability
 */
export async function settle(page, { maxMs = 4500, graceMs = 650, intervalMs = 120 } = {}) {
  const start = Date.now();
  let sawResponse = false;
  let lastResponse = start;
  const onResponse = () => {
    sawResponse = true;
    lastResponse = Date.now();
  };
  page.on('response', onResponse);
  try {
    let prevLen = -1;
    while (Date.now() - start < maxMs) {
      await page.waitForTimeout(intervalMs);
      let len;
      try {
        len = await page.evaluate(() => document.body.innerText.length);
      } catch {
        return;
      }
      // "Quiet" = the grace window has passed since the last response (or, if no
      // response ever came, since the start). Settled once it is quiet AND the
      // text has stopped changing — so a late render that trails the final
      // response still gets one more poll before we conclude.
      const since = sawResponse ? Date.now() - lastResponse : Date.now() - start;
      if (since >= graceMs && len === prevLen) return;
      prevLen = len;
    }
  } finally {
    page.off('response', onResponse);
  }
}
