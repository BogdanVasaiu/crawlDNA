// The render-wait signal (#15): response-quiet + stable text, bounded.
// settle() is pure JS over the Playwright page interface, so its semantics —
// the ones that replace `networkidle` at render time — are provable offline
// with a fake page. Timings use wide margins to stay CI-proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../src/lib/settle.mjs';

function fakePage({ text = () => 100 } = {}) {
  const listeners = new Set();
  return {
    on(ev, cb) {
      if (ev === 'response') listeners.add(cb);
    },
    off(ev, cb) {
      if (ev === 'response') listeners.delete(cb);
    },
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    evaluate: async () => text(),
    emitResponse() {
      for (const cb of listeners) cb();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

test('a quiet page — including one holding a websocket open — exits after one grace window, not at the cap', async () => {
  // THE #15 case: `networkidle` waits on open CONNECTIONS, so a held socket
  // burned the full timeout on every page. settle counts response EVENTS: a
  // page with no traffic (socket open or not) exits right after grace+stability.
  const page = fakePage();
  const start = Date.now();
  await settle(page, { maxMs: 2000, graceMs: 100, intervalMs: 20 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `exited in ${elapsed}ms — far below the 2000ms cap`);
  assert.equal(page.listenerCount, 0, 'the response listener is detached');
});

test('constant sub-grace heartbeats are BOUNDED by maxMs (never hang, never wait forever)', async () => {
  const page = fakePage();
  const beat = setInterval(() => page.emitResponse(), 30); // faster than grace
  try {
    const start = Date.now();
    await settle(page, { maxMs: 600, graceMs: 150, intervalMs: 20 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 500, `ran to the cap (${elapsed}ms) — quiet never arrived`);
    assert.ok(elapsed < 3000, 'and stopped there');
  } finally {
    clearInterval(beat);
  }
});

test('a load cascade is waited out: exits after the burst + grace, well before the cap', async () => {
  const page = fakePage();
  const start = Date.now();
  const burst = setInterval(() => page.emitResponse(), 20);
  setTimeout(() => clearInterval(burst), 200); // responses stream for ~200ms, then quiet
  await settle(page, { maxMs: 3000, graceMs: 120, intervalMs: 20 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 280, `waited through the cascade (${elapsed}ms ≥ burst+grace)`);
  assert.ok(elapsed <= 1500, `but exited long before the 3000ms cap (${elapsed}ms)`);
});

test('text still changing delays the exit until it stabilises', async () => {
  let calls = 0;
  const page = fakePage({ text: () => (calls < 8 ? ++calls * 10 : 999) }); // grows ~8 polls, then flat
  const start = Date.now();
  await settle(page, { maxMs: 3000, graceMs: 60, intervalMs: 20 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 140, `did not conclude while the text grew (${elapsed}ms)`);
  assert.ok(elapsed < 1500, `then exited promptly once stable (${elapsed}ms)`);
});

test('an evaluate failure (page navigated/closed under us) exits cleanly and detaches', async () => {
  const page = fakePage();
  page.evaluate = async () => {
    throw new Error('Execution context was destroyed');
  };
  await settle(page, { maxMs: 2000, graceMs: 100, intervalMs: 20 }); // must not throw
  assert.equal(page.listenerCount, 0);
});
