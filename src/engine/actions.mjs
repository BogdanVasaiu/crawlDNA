// Low-level page actuation via Playwright. Elements are targeted by the
// `data-docdna-id` attribute that perceive() stamped on the live DOM.

const SETTLE_MS = 350;

/**
 * Activate a revealer by id. Guards against navigation: if the click took us to
 * a new URL (the control was really a link), we record that URL and go back so
 * revealing continues on the original page.
 *
 * @returns {Promise<{ ok: boolean, navigatedTo?: string, note?: string }>}
 */
export async function clickRevealer(page, id) {
  const before = page.url();
  const loc = page.locator(`[data-docdna-id="${id}"]`).first();
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
    await loc.click({ timeout: 4000 });
  } catch (err) {
    return { ok: false, note: String(err && err.message).slice(0, 120) };
  }
  await page.waitForTimeout(SETTLE_MS);
  // Let async content triggered by the click settle before the caller captures.
  // Many widgets load on click (e.g. a booking calendar fetches a day's slot grid
  // via AJAX) — without this we'd snapshot a "loading…" placeholder and miss the
  // real content. Best-effort: networkidle is generic, no per-site assumptions.
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

  const after = page.url();
  if (after !== before) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    return { ok: true, navigatedTo: after };
  }
  return { ok: true };
}

/**
 * Scroll down one viewport to trigger lazy/infinite content.
 * @returns {Promise<boolean>} whether the document grew (more content loaded).
 */
export async function scrollStep(page) {
  try {
    const before = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => document.body.scrollHeight);
    return after > before + 4;
  } catch {
    return false;
  }
}
