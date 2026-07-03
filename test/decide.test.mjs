// The AI judgment layer, exercised end-to-end through the real transport (llm.mjs)
// against a local OpenAI-compatible stub — no model, no browser, no external network.
// Covers the completeness-bias contracts: what happens on a deliberate empty verdict,
// on garbage, on transport failure, and that no candidate is ever lost to a cap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { aiSelectLinks, aiScopeContent, aiSelectRevealers, aiPlanNavigation, aiReshape } from '../src/engine/decide.mjs';
import { decideFollow } from '../src/engine/crawl-page.mjs';

// --- local OpenAI-compatible stub -------------------------------------------
let handler = () => '{}'; // (prompt) => model reply content, or 'FAIL' → HTTP 500
let calls = 0;
let prompts = [];
let systems = [];
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    calls++;
    let prompt = '';
    try {
      const msgs = JSON.parse(data).messages;
      prompt = msgs.at(-1).content;
      systems.push(msgs[0].content);
    } catch {
      /* keep '' */
    }
    prompts.push(prompt);
    const out = handler(prompt);
    if (out === 'FAIL') {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: out } }], usage: {} }));
  });
});

let llm;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  llm = { provider: 'openai', model: 'stub', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'k' };
});
after(() => server.close());

const reset = (h) => {
  handler = h;
  calls = 0;
  prompts = [];
  systems = [];
};
const links = (n) => Array.from({ length: n }, (_, i) => ({ href: `https://s.it/p${i}`, label: `L${i}` }));
// reply that follows EVERY destination listed in the prompt
const echoAll = (prompt) => {
  const n = (prompt.match(/^\d+: /gm) || []).length;
  return JSON.stringify({ follow: Array.from({ length: n }, (_, i) => i) });
};

// --- aiSelectLinks -----------------------------------------------------------

test('aiSelectLinks honours a deliberate empty verdict (follow NOTHING)', async () => {
  reset(() => '{"follow":[]}');
  assert.deepEqual(await aiSelectLinks({ llm, task: 't', links: links(5) }), []);
});

test('aiSelectLinks returns exactly the selected hrefs', async () => {
  reset(() => '{"follow":[0,2]}');
  assert.deepEqual(await aiSelectLinks({ llm, task: 't', links: links(5) }), [
    'https://s.it/p0',
    'https://s.it/p2',
  ]);
});

test('aiSelectLinks: garbage indexes and transport failure both fall back to follow-all', async () => {
  reset(() => '{"follow":[999]}');
  assert.equal((await aiSelectLinks({ llm, task: 't', links: links(5) })).length, 5);
  reset(() => 'FAIL');
  assert.equal((await aiSelectLinks({ llm, task: 't', links: links(5) })).length, 5);
});

test('aiSelectLinks caps one call at 160 destinations', async () => {
  reset(() => '{"follow":[]}');
  await aiSelectLinks({ llm, task: 't', links: links(200) });
  assert.equal((prompts.at(-1).match(/^\d+: /gm) || []).length, 160);
});

// --- decideFollow (batching + per-scan cache + focused mode) -----------------

const mkCtx = (minRelevance = 0) => ({ currentScan: {}, options: { llm, minRelevance } });

test('decideFollow judges EVERY candidate in batches — none lost to the 160 cap', async () => {
  reset(echoAll);
  const ctx = mkCtx();
  const keep = await decideFollow(ctx, 'estrai la documentazione', links(200));
  assert.equal(keep.length, 200, 'every candidate must be judged and followed');
  assert.equal(calls, 2, '200 candidates = 2 batched model calls');
});

test('decideFollow caches verdicts per scan (a link is judged once)', async () => {
  reset(echoAll);
  const ctx = mkCtx();
  await decideFollow(ctx, 't', links(200));
  const callsAfterFirst = calls;
  const again = await decideFollow(ctx, 't', links(200));
  assert.equal(calls, callsAfterFirst, 'second pass over the same links must cost zero calls');
  assert.equal(again.length, 200);
});

test('decideFollow records an empty verdict for the WHOLE list, batches included', async () => {
  reset(() => '{"follow":[]}');
  const ctx = mkCtx();
  const keep = await decideFollow(ctx, 't', links(200));
  assert.deepEqual(keep, []);
  assert.equal(calls, 2, 'both batches must still be JUDGED (not silently dropped)');
});

test('focused mode (minRelevance) prunes off-task links before the model — only when the task discriminates', async () => {
  reset(echoAll);
  const cands = [
    { href: 'https://s.it/documentazione/intro', label: 'Documentazione' },
    { href: 'https://s.it/contatti', label: 'Contatti' },
  ];
  const keep = await decideFollow(mkCtx(0.5), 'estrai la documentazione', cands);
  assert.deepEqual(keep, ['https://s.it/documentazione/intro']);
  assert.equal(calls, 1);
  assert.ok(!prompts[0].includes('contatti'), 'the pruned link must never reach the model');

  // nothing reaches the threshold → prune NOTHING (a generic task is never over-cut)
  reset(echoAll);
  const keep2 = await decideFollow(mkCtx(0.9), 'estrai la documentazione', cands);
  assert.equal(keep2.length, 2);
  assert.ok(prompts[0].includes('contatti'), 'below-threshold page: all links still judged');
});

// --- aiScopeContent -----------------------------------------------------------

test('aiScopeContent: short and single-section pages are kept whole with NO model call', async () => {
  // llm:null would throw 'no model selected' if any call were attempted
  const short = await aiScopeContent({ llm: null, task: 't', title: '', markdown: 'short page' });
  assert.deepEqual(short, { markdown: 'short page', relevant: true });
  const blob = 'word '.repeat(300); // >1200 chars, no headings → single section
  const single = await aiScopeContent({ llm: null, task: 't', title: '', markdown: blob });
  assert.equal(single.markdown, blob);
  assert.equal(single.relevant, true);
});

const sectioned =
  `intro text before any heading\n\n# Alpha\n\n${'alpha content sentence. '.repeat(30)}\n\n# Beta\n\n${'beta content sentence. '.repeat(30)}`;

test('aiScopeContent keeps exactly the selected sections, verbatim', async () => {
  reset(() => '{"keep":[1]}');
  const r = await aiScopeContent({ llm, task: 'alpha only', title: 'T', markdown: sectioned });
  assert.ok(r.markdown.includes('# Alpha') && r.markdown.includes('alpha content'));
  assert.ok(!r.markdown.includes('# Beta') && !r.markdown.includes('intro text'));
  assert.equal(r.relevant, true);
});

test('aiScopeContent keep-bias: empty selection or garbage → the whole page survives', async () => {
  reset(() => '{"keep":[]}');
  assert.equal((await aiScopeContent({ llm, task: 't', title: '', markdown: sectioned })).markdown, sectioned);
  reset(() => 'not json at all');
  assert.equal((await aiScopeContent({ llm, task: 't', title: '', markdown: sectioned })).markdown, sectioned);
});

// --- prompt-cache contract (#4) ------------------------------------------------

test('system prompts are BYTE-IDENTICAL across calls of the same type (prompt-cache prefix)', async () => {
  // Per-call data must live in the USER message only — an interpolated system prompt
  // would silently kill provider-side prefix caching on thousands of crawl calls.
  reset(() => '{"follow":[]}');
  await aiSelectLinks({ llm, task: 'estrai il menu delle pizze', links: links(3) });
  await aiSelectLinks({ llm, task: 'a completely different documentation task', links: links(7) });
  assert.equal(typeof systems[0], 'string');
  assert.equal(systems[0], systems[1], 'aiSelectLinks system prompt must not vary per call');

  reset(() => '{"click":[]}');
  const cand = (l) => [{ signature: `x|${l}|`, kind: 'tab', label: l }];
  await aiSelectRevealers({ llm, task: 'task one', candidates: cand('A') });
  await aiSelectRevealers({ llm, task: 'task two', candidates: cand('B') });
  assert.equal(systems[0], systems[1], 'aiSelectRevealers system prompt must not vary per call');

  reset(() => '{"keep":[]}');
  await aiScopeContent({ llm, task: 'menu', title: 'T1', markdown: sectioned });
  await aiScopeContent({ llm, task: 'prezzi', title: 'T2', markdown: sectioned });
  assert.equal(systems[0], systems[1], 'aiScopeContent system prompt must not vary per call');

  reset(() => '{"direction":null,"target":null}');
  const ctrl = [{ signature: 's', kind: 'control', label: 'next' }];
  await aiPlanNavigation({ llm, task: 'settembre', current: { title: 'a' }, controls: ctrl });
  await aiPlanNavigation({ llm, task: 'ottobre', current: { title: 'b' }, controls: ctrl });
  assert.equal(systems[0], systems[1], 'aiPlanNavigation system prompt must not vary per call');
});

// --- aiReshape (file-block parsing robustness) --------------------------------

test('aiReshape strips doubled/nested FILE markers a local model leaks into a block', async () => {
  reset(
    () =>
      '===FILE: outer.md===\n' +
      '===FILE: inner.md===\n' +
      '# Real Content\n\nThe deliverable body.\n' +
      '===END\n' +
      '===END===',
  );
  const out = await aiReshape({
    llm,
    instruction: 'make the doc',
    documents: [{ filename: 'src.md', content: 'The deliverable body lives here.' }],
  });
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].filename, 'outer.md');
  assert.ok(out.files[0].content.startsWith('# Real Content'), 'nested FILE marker must be stripped');
  assert.ok(!out.files[0].content.includes('==='), 'no stray marker fragments in the content');
});

// --- aiSelectRevealers / aiPlanNavigation -------------------------------------

test('aiSelectRevealers maps chosen indexes to signatures; garbage signals fallback (null)', async () => {
  const cands = [
    { signature: 'tab|X|', kind: 'tab', label: 'X' },
    { signature: 'tab|Y|', kind: 'tab', label: 'Y' },
  ];
  reset(() => '{"click":[1]}');
  assert.deepEqual(await aiSelectRevealers({ llm, task: 't', candidates: cands }), new Set(['tab|Y|']));
  reset(() => 'garbage');
  assert.equal(await aiSelectRevealers({ llm, task: 't', candidates: cands }), null);
  reset(() => '{"click":[]}');
  assert.deepEqual(await aiSelectRevealers({ llm, task: 't', candidates: [] }), new Set());
  assert.equal(calls, 0, 'no candidates = no model call');
});

test('aiPlanNavigation validates the planned direction and target', async () => {
  const controls = [
    { signature: 's1', kind: 'control', label: 'precedente' },
    { signature: 's2', kind: 'control', label: 'successivo' },
  ];
  reset(() => '{"direction":1,"target":"AGOSTO"}');
  assert.deepEqual(await aiPlanNavigation({ llm, task: 'settembre', current: {}, controls }), {
    direction: 1,
    target: 'AGOSTO',
  });
  reset(() => '{"direction":99,"target":null}');
  assert.deepEqual(await aiPlanNavigation({ llm, task: 't', current: {}, controls }), {
    direction: null,
    target: null,
  });
  reset(() => 'garbage');
  assert.equal(await aiPlanNavigation({ llm, task: 't', current: {}, controls }), null);
  reset(() => '{}');
  assert.deepEqual(await aiPlanNavigation({ llm, task: 't', current: {}, controls: [] }), {
    direction: null,
    target: null,
  });
  assert.equal(calls, 0, 'no controls = no model call');
});

// --- no-AI mode (noAi → provider 'none') ---------------------------------------
// The deliberate zero-token mode: every phase-1 judgment must short-circuit to its
// completeness-bias fallback BEFORE the transport. Each stub handler below would
// produce the OPPOSITE result if a call slipped through, and `calls` must stay 0.

const none = { provider: 'none', model: '', baseUrl: '', apiKey: '' };

test('no-AI: every in-scope link is followed with ZERO model calls', async () => {
  reset(() => '{"follow":[]}'); // a leaked call would follow NOTHING
  const ctx = { currentScan: {}, options: { llm: none, minRelevance: 0 } };
  const keep = await decideFollow(ctx, 'estrai la documentazione', links(5));
  assert.equal(keep.length, 5, 'no link gate: all in-scope candidates are followed');
  assert.equal(calls, 0, 'no-AI mode must never touch the transport');
});

test('no-AI: pages kept whole, heuristic reveal, open-ended navigation — zero calls', async () => {
  reset(() => '{"keep":[]}');
  const scoped = await aiScopeContent({ llm: none, task: 't', title: 'T', markdown: sectioned });
  assert.deepEqual(scoped, { markdown: sectioned, relevant: true });

  const cands = [{ signature: 'tab|X|', kind: 'tab', label: 'X' }];
  assert.equal(await aiSelectRevealers({ llm: none, task: 't', candidates: cands }), null,
    'null = the caller falls back to the per-candidate DOM heuristic');

  const controls = [{ signature: 's2', kind: 'control', label: 'successivo' }];
  assert.deepEqual(await aiPlanNavigation({ llm: none, task: 'settembre', current: {}, controls }),
    { direction: null, target: null }, 'no targeted walk — explore everything');

  assert.equal(calls, 0, 'no-AI mode must never touch the transport');
});

test('no-AI: focused mode (minRelevance) still prunes deterministically, without a model', async () => {
  reset(echoAll);
  const cands = [
    { href: 'https://s.it/documentazione/intro', label: 'Documentazione' },
    { href: 'https://s.it/contatti', label: 'Contatti' },
  ];
  const ctx = { currentScan: {}, options: { llm: none, minRelevance: 0.5 } };
  const keep = await decideFollow(ctx, 'estrai la documentazione', cands);
  assert.deepEqual(keep, ['https://s.it/documentazione/intro']);
  assert.equal(calls, 0);
});
