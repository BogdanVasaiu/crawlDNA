// #21 b/c/d — the closed-loop reveal, offline: revealAll driven by a FAKE page
// (settle/perceive/actions are all duck-typed over the page interface, so a
// scripted state machine stands in for Playwright — no browser, no model, no
// network beyond a local stub). What is proven here:
//   (b) no-AI approves EVERY candidate, with the MEASURED ordering deciding who
//       gets the budget first — the English DISCLOSURE_LABEL lexicon is no
//       longer a gate (the "Servizi" bug: a listener-only control with a
//       non-English label used to be skipped entirely);
//   (b) a model "no" is overridden by a measured hidden payload — the judge's
//       error becomes one extra click, never lost content;
//   (c) a control that ADDS content and persists is re-clicked to saturation
//       whatever its label's language — behaviour, not words;
//   (d) the exit audit: the residual hidden text is returned, and a large one
//       produces the advisory `reveal-residual` warning.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { revealAll, revealPriority, PAYLOAD_MIN } from '../src/engine/reveal.mjs';

// --- the fake page ------------------------------------------------------------
// Dispatches page.evaluate by what the evaluated function needs: perceive passes
// args, captureHtml serializes outerHTML, settle polls innerText.length (made to
// throw — settle treats a dead evaluate as "settled", its own tested fast path),
// scrollStep reads scrollHeight.
function makePage(model) {
  return {
    url: () => 'https://fake.site/page',
    on() {},
    off() {},
    async waitForTimeout() {},
    async goBack() {},
    async goto() {},
    locator: (sel) => {
      const m = sel.match(/data-crawldna-id="(\d+)"/);
      const id = m ? Number(m[1]) : -1;
      return {
        first: () => ({
          scrollIntoViewIfNeeded: async () => {},
          click: async () => model.click(id),
        }),
      };
    },
    async evaluate(fn, args) {
      const src = fn.toString();
      if (args && typeof args === 'object' && 'maxRevealers' in args) return model.perceive();
      if (src.includes('outerHTML')) return model.html();
      if (src.includes('innerText.length')) throw new Error('no DOM here');
      if (src.includes('scrollBy')) return undefined;
      if (src.includes('scrollHeight')) return model.scrollHeight();
      return undefined;
    },
  };
}

const baseCtx = (llm, events) => ({
  currentScan: {},
  options: { llm, maxActions: 25 },
  emit: (ev) => events.push(ev),
  shouldStop: () => false,
});

const NONE = { provider: 'none', model: '', baseUrl: '', apiKey: '' };

const rev = (id, over = {}) => ({
  id,
  kind: 'control',
  label: `c${id}`,
  role: 'button',
  cls: '',
  context: '',
  heuristic: false,
  signature: `sig-${id}`,
  hiddenPayload: 0,
  expanded: null,
  ...over,
});

const pagePerception = (model, revealers) => ({
  url: 'https://fake.site/page',
  title: 'Fake',
  mainText: model.paragraphs.join(' '),
  revealers,
  consentCandidates: [],
  links: [],
  hiddenResidualChars: model.residual || 0,
  routes: [],
  scrollHeight: model.scrollHeight(),
});

const htmlOf = (model) =>
  `<html><head><title>Fake</title></head><body><main><h1>Fake</h1>${model.paragraphs
    .map((p) => `<p>${p}</p>`)
    .join('')}</main></body></html>`;

// --- (b) unit: the measured ordering ------------------------------------------

test('revealPriority: closed disclosure > measured payload > specific kind > label heuristic', () => {
  const closed = rev(0, { expanded: 'false' });
  const payload = rev(1, { hiddenPayload: 1900 });
  const tab = rev(2, { kind: 'tab' });
  const hinted = rev(3, { heuristic: true });
  const generic = rev(4);
  const order = [generic, hinted, tab, payload, closed].sort((a, b) => revealPriority(b) - revealPriority(a));
  assert.deepEqual(order.map((c) => c.id), [0, 1, 2, 3, 4]);
});

test('revealPriority: a chrome control ranks below its content twin, but hard measured proof still wins', () => {
  // A site-nav switcher (chrome) must not leapfrog main content on a kind hint alone.
  const contentTab = rev(0, { kind: 'tab' });
  const chromeTab = rev(1, { kind: 'tab', chrome: true });
  const order = [chromeTab, contentTab].sort((a, b) => revealPriority(b) - revealPriority(a));
  assert.deepEqual(order.map((c) => c.id), [0, 1], 'the content tab outranks the identical chrome tab');
  // …but a chrome control with a real MEASURED payload still earns the budget over
  // a bare content control — coverage is never sacrificed to the content-first rule.
  const chromePayload = rev(2, { chrome: true, hiddenPayload: 1900 });
  const contentPlain = rev(3);
  assert.ok(revealPriority(chromePayload) > revealPriority(contentPlain), 'measured chrome payload beats a bare content control');
});

// --- (c) behavioural load-more: language-free saturation ----------------------

test('a control that ADDS content and persists is re-clicked to saturation — no English label needed', async () => {
  const items = ['Alpha entry: the very first list row with enough text to stand as a block.'];
  const MORE = [
    'Bravo entry: the second row, revealed only by the first click on the loader.',
    'Charlie entry: the third row, revealed by the second click on the loader.',
    'Delta entry: the fourth and final row, after which the loader yields nothing.',
  ];
  let clicks = 0;
  const model = {
    paragraphs: items,
    residual: 0,
    scrollHeight: () => 800 + items.length * 400, // each row grows the page (append, not swap)
    perceive() {
      // 'Mehr anzeigen': kind stays 'control' (the English LOADMORE regex does
      // not match), heuristic false — the OLD engine would never even click it.
      return pagePerception(model, [rev(0, { label: 'Mehr anzeigen' })]);
    },
    html: () => htmlOf(model),
    click(id) {
      if (id !== 0) return;
      clicks++;
      if (MORE.length) items.push(MORE.shift());
    },
  };
  const events = [];
  const out = await revealAll(makePage(model), baseCtx(NONE, events), 'https://fake.site/page', 'estrai tutto');

  for (const text of ['Alpha entry', 'Bravo entry', 'Charlie entry', 'Delta entry']) {
    assert.ok(out.markdown.includes(text), `captured: ${text}`);
  }
  assert.ok(clicks >= 3, 'the loader was exhausted, not clicked once');
  assert.ok(
    events.some((e) => e.type === 'action' && /load more \(measured\)/.test(e.detail || '')),
    'the behavioural repeat is announced as measured, not label-guessed',
  );
});

// --- (b) no-AI: approve all, measured order decides the budget ----------------

test('no-AI clicks a listener-only control with measured payload FIRST (the "Servizi" case)', async () => {
  const model = {
    paragraphs: ['Home intro: la pagina di partenza con il testo di benvenuto del comune.'],
    residual: 0,
    scrollHeight: () => 1000,
    perceive() {
      const list = [];
      // A generic labelled div with a listener, no ARIA, no English disclosure
      // words — but 900 chars measured behind it. Old no-AI verdict: skipped.
      if (!model.serviziOpen) list.push(rev(1, { label: 'Servizi', hiddenPayload: 900 }));
      list.push(rev(2, { label: 'Filtri' })); // plausible but nothing measured
      return pagePerception(model, list);
    },
    html: () => htmlOf(model),
    click(id) {
      model.clicked = model.clicked || [];
      model.clicked.push(id);
      if (id === 1 && !model.serviziOpen) {
        model.serviziOpen = true;
        model.paragraphs.push('Servizi comunali: anagrafe, tributi, edilizia — il contenuto rivelato dal click.');
      }
    },
  };
  const events = [];
  const out = await revealAll(makePage(model), baseCtx(NONE, events), 'https://fake.site/page', 'estrai i servizi');

  assert.ok(out.markdown.includes('Servizi comunali'), 'the payload behind the listener-only control is captured');
  assert.equal(model.clicked[0], 1, 'the measured payload outranks the generic sibling for the budget');
  assert.ok(model.clicked.includes(2), 'no-AI approves every mechanical candidate (a wasted click beats lost content)');
});

// --- (b) no-AI: a chrome view-switcher is covered, content still goes first ----

test('no-AI covers a chrome view-switcher too, but clicks the content control first', async () => {
  const model = {
    paragraphs: ['Base intro: the visible starting text of this fake page, nothing hidden yet.'],
    clicked: [],
    residual: 0,
    scrollHeight: () => 1000,
    perceive() {
      // A content control and a site-nav (chrome) switcher, both plain 'control'
      // with no measured payload — so ONLY the chrome penalty separates them.
      return pagePerception(model, [
        rev(1, { label: 'Contenuto principale' }),
        rev(2, { label: 'Voce di nav', chrome: true }),
      ]);
    },
    html: () => htmlOf(model),
    click(id) {
      model.clicked.push(id);
      if (id === 1) model.paragraphs.push('Contenuto rivelato: testo reale del corpo della pagina.');
      if (id === 2) model.paragraphs.push('Vista di nav: una sezione aperta da un controllo nella chrome.');
    },
  };
  const events = [];
  const out = await revealAll(makePage(model), baseCtx(NONE, events), 'https://fake.site/page', 'estrai tutto');

  assert.equal(model.clicked[0], 1, 'the content control gets the budget before the chrome one');
  assert.ok(model.clicked.includes(2), 'the chrome view-switcher is still covered — nothing clickable is missed');
  assert.ok(out.markdown.includes('Contenuto rivelato'), 'the content reveal is captured');
  assert.ok(out.markdown.includes('Vista di nav'), 'the chrome reveal is captured');
});

// --- speed: cross-page chrome futility (measured, universal, re-verifying) -----

test('cross-page: an inert CHROME control is sampled down site-wide; a productive one and content controls are not', async () => {
  const scan = {}; // the per-SCAN host, SHARED across pages (like ctx.currentScan)
  const clicks = { chromeInert: 0, chromeProd: 0, contentInert: 0 };
  const events = [];
  const ctx = { currentScan: scan, options: { llm: NONE, maxActions: 25 }, emit: (e) => events.push(e), shouldStop: () => false };

  const runPage = async () => {
    const model = {
      paragraphs: ['Base page intro: enough visible body text to stand as a content block here.'],
      residual: 0,
      scrollHeight: () => 1000,
      perceive() {
        return pagePerception(model, [
          rev(1, { label: 'Tema', chrome: true }), // chrome, ALWAYS inert (a theme toggle)
          rev(2, { label: 'Novita', chrome: true }), // chrome, but reveals content every page
          rev(3, { label: 'Sezione', chrome: false }), // CONTENT control, inert
        ]);
      },
      html: () => htmlOf(model),
      click(id) {
        if (id === 1) clicks.chromeInert++; // adds nothing
        if (id === 2) {
          clicks.chromeProd++;
          model.paragraphs.push('Revealed body block from the productive control on this page.');
        }
        if (id === 3) clicks.contentInert++; // adds nothing
      },
    };
    await revealAll(makePage(model), ctx, 'https://fake.site/page', 'estrai tutto');
  };

  for (let i = 0; i < 10; i++) await runPage();

  // Inert chrome: measured on the first pages, then clicked only on the re-verify
  // cadence — far fewer than 10, but never zero (it is always re-checked).
  assert.ok(clicks.chromeInert >= 4, `measured before sampling (was ${clicks.chromeInert})`);
  assert.ok(clicks.chromeInert < 10, `inert chrome sampled down site-wide (was ${clicks.chromeInert}/10)`);
  // Productive chrome: adds content every page ⇒ marked productive ⇒ NEVER sampled.
  assert.equal(clicks.chromeProd, 10, 'a chrome control that reveals content is never sampled — no content lost');
  // Content controls are outside the mechanism entirely ⇒ precision untouched.
  assert.equal(clicks.contentInert, 10, 'a non-chrome control is never sampled');
  assert.ok(events.some((e) => /sampling chrome control site-wide/.test(e.detail || '')), 'sampling is announced');
});

test('single page never samples (the guard needs cross-page evidence)', async () => {
  const clicks = [];
  const model = {
    paragraphs: ['One page only: nothing hidden, a lone chrome control that reveals nothing.'],
    residual: 0,
    scrollHeight: () => 1000,
    perceive: () => pagePerception(model, [rev(1, { label: 'Tema', chrome: true })]),
    html: () => htmlOf(model),
    click: (id) => clicks.push(id),
  };
  const events = [];
  await revealAll(makePage(model), baseCtx(NONE, events), 'https://fake.site/page', 'estrai tutto');
  assert.deepEqual(clicks, [1], 'a chrome control is always clicked on a fresh scan — sampling needs evidence first');
});

// --- (b) AI mode: measurement arbitrates the judge ----------------------------

let stubServer;
let llm;
before(async () => {
  stubServer = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const prompt = (() => {
        try {
          return JSON.parse(data).messages.at(-1).content;
        } catch {
          return '';
        }
      })();
      // nav-plan asks for {"direction"...}; the reveal triage asks for {"click":[...]}.
      const out = /"direction"/.test(prompt) ? '{"direction":null,"target":null}' : '{"click":[]}';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: out } }], usage: {} }));
    });
  });
  await new Promise((r) => stubServer.listen(0, '127.0.0.1', r));
  llm = { provider: 'openai', model: 'stub', baseUrl: `http://127.0.0.1:${stubServer.address().port}/v1`, apiKey: 'k' };
});
after(() => stubServer.close());

test('an AI "no" is overridden by measured hidden payload; a payload-free "no" is honoured', async () => {
  const model = {
    paragraphs: ['Prodotti: il catalogo con la descrizione generale della gamma disponibile.'],
    residual: 0,
    scrollHeight: () => 1000,
    perceive() {
      const list = [];
      if (!model.detOpen) list.push(rev(1, { label: 'Dettagli tecnici', hiddenPayload: PAYLOAD_MIN + 300 }));
      list.push(rev(2, { label: 'Apri chat' })); // the model says no, nothing measured → stays rejected
      return pagePerception(model, list);
    },
    html: () => htmlOf(model),
    click(id) {
      model.clicked = model.clicked || [];
      model.clicked.push(id);
      if (id === 1 && !model.detOpen) {
        model.detOpen = true;
        model.paragraphs.push('Scheda tecnica completa: dimensioni, peso, materiali e certificazioni.');
      }
    },
  };
  const events = [];
  const out = await revealAll(makePage(model), baseCtx(llm, events), 'https://fake.site/page', 'estrai i prodotti');

  assert.ok(out.markdown.includes('Scheda tecnica completa'), 'the measured payload was revealed despite the AI "no"');
  assert.deepEqual(model.clicked, [1], 'the payload-free rejected control was never clicked — the judge still counts');
});

// --- (d) the exit audit --------------------------------------------------------

test('a large hidden residual at exit is returned and warned about — advisory, never blocking', async () => {
  const model = {
    paragraphs: ['Visible intro text: the only thing any control can reach on this page.'],
    residual: 3000, // ~500 words the reveal provably did NOT surface
    scrollHeight: () => 1000,
    perceive: () => pagePerception(model, []),
    html: () => htmlOf(model),
    click() {},
  };
  const events = [];
  const out = await revealAll(makePage(model), baseCtx(NONE, events), 'https://fake.site/page', 'estrai tutto');

  assert.equal(out.hiddenResidualChars, 3000, 'the audit number is machine-readable on the result');
  const warn = events.find((e) => e.type === 'warn' && e.reason === 'reveal-residual');
  assert.ok(warn, 'the residual produces the advisory warning');
  assert.match(warn.message, /~500 words/, 'the warning carries the measured number');
  assert.ok(out.markdown.includes('Visible intro text'), 'the page is still captured — advisory means advisory');
});

test('residual 0 stays silent — the measured all-clear', async () => {
  const model = {
    paragraphs: ['Fully visible page: nothing is hidden anywhere in the main content.'],
    residual: 0,
    scrollHeight: () => 1000,
    perceive: () => pagePerception(model, []),
    html: () => htmlOf(model),
    click() {},
  };
  const events = [];
  const out = await revealAll(makePage(model), baseCtx(NONE, events), 'https://fake.site/page', 'estrai tutto');
  assert.equal(out.hiddenResidualChars, 0);
  assert.ok(!events.some((e) => e.type === 'warn' && e.reason === 'reveal-residual'));
});

test('#9 truthful residual: text captured in an earlier state is not counted as still-hidden', async () => {
  const CAPTURED = 'Panel Bravo content: a full paragraph of real text captured when its tab is active on this page.';
  const MISSING = 'Ghost panel content: a paragraph no control ever reveals, so it never enters the output at all here.';
  const model = {
    paragraphs: ['Base intro: visible starting text for this page, long enough to be a content block.'],
    residual: CAPTURED.length + MISSING.length,
    hidden: [{ n: CAPTURED.length, s: CAPTURED.slice(0, 140) }, { n: MISSING.length, s: MISSING.slice(0, 140) }],
    scrollHeight: () => 1000,
    perceive() {
      const p = pagePerception(model, [rev(1, { label: 'Bravo' })]);
      p.hiddenTexts = model.hidden; // both panels report as hidden in the final state
      p.hiddenResidualChars = model.residual;
      return p;
    },
    html: () => htmlOf(model),
    click(id) {
      if (id === 1) model.paragraphs.push(CAPTURED); // clicking the tab captures its panel
    },
  };
  const events = [];
  const out = await revealAll(makePage(model), baseCtx(NONE, events), 'https://fake.site/page', 'estrai tutto');
  assert.ok(out.markdown.includes('Panel Bravo content'), 'the panel WAS captured');
  assert.ok(out.hiddenResidualChars < model.residual, 'the captured-but-hidden panel is subtracted from the residual');
  assert.ok(
    Math.abs(out.hiddenResidualChars - MISSING.length) <= 5,
    `residual reflects only genuinely-missing text (got ${out.hiddenResidualChars}, expected ~${MISSING.length})`,
  );
});
