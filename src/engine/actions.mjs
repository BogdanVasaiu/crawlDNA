// Low-level page actuation via Playwright. Elements are targeted by the
// `data-crawldna-id` attribute that perceive() stamped on the live DOM.
// The "wait until the click's effects landed" signal lives in lib/settle.mjs
// (#15) — shared with the initial render and the browser-escalation fetch.

import { settle } from '../lib/settle.mjs';

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
  const loc = page.locator(`[data-crawldna-id="${id}"]`).first();
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
    await loc.click({ timeout: 4000 });
  } catch (err) {
    return { ok: false, note: String(err && err.message).slice(0, 120) };
  }
  // Wait for the click's async content (AJAX panels + any first-touch lazy-load
  // cascade) to finish before the caller captures. This is what reliably gets a
  // slow first reveal — e.g. the day-2 slot grid — that a single immediate
  // snapshot, or networkidle alone, can miss.
  await settle(page);

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
