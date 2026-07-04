// HTML → Markdown extraction: main-content picking, chrome removal, link-density
// pruning with its safety cascade (#8), block utilities and the BlockAccumulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMarkdown,
  splitBlocks,
  classifyBlock,
  enrichBlocks,
  stripImages,
  stripLinks,
  applyExclusions,
  stripSvgNoise,
  contentWordLen,
  BlockAccumulator,
} from '../src/extract.mjs';

test('basic page: h1 title, prose kept, nav/footer/hidden removed, code fence keeps language', () => {
  const html = `<html><head><title>T</title></head><body>
    <nav><a href="/a">NavA</a><a href="/b">NavB</a></nav>
    <main><h1>Guide</h1><p>Some prose here explaining things in detail for everyone.</p>
    <pre><code class="language-js">const x = 1;</code></pre>
    <div data-sagecrawl-hidden="1"><p>HIDDEN MODAL TEXT</p></div>
    <footer>foot</footer></main></body></html>`;
  const { title, markdown } = extractMarkdown(html, { baseUrl: 'https://ex.com/docs/' });
  assert.equal(title, 'Guide');
  assert.ok(markdown.includes('Some prose here'));
  assert.ok(markdown.includes('```js\nconst x = 1;\n```'));
  assert.ok(!markdown.includes('NavA'), 'nav chrome must be removed');
  assert.ok(!markdown.includes('foot'), 'footer must be removed');
  assert.ok(!markdown.includes('HIDDEN MODAL TEXT'), 'reveal-marked hidden elements must be dropped');
});

test('relative links are absolutised against baseUrl', () => {
  const html = '<html><body><main><h1>T</h1><p>See <a href="/rel">the page</a> now.</p></main></body></html>';
  const { markdown } = extractMarkdown(html, { baseUrl: 'https://ex.com/docs/x' });
  assert.ok(markdown.includes('(https://ex.com/rel)'));
});

test('#8 link-density pruning: a bare link list is dropped, a described list survives', () => {
  const bareNav = `<html><body><main><h1>Guide</h1>
    <p>Real prose that must always survive the pruning cascade unharmed.</p>
    <ul>
      <li><a href="/one">One</a></li><li><a href="/two">Two</a></li>
      <li><a href="/three">Three</a></li><li><a href="/four">Four</a></li>
      <li><a href="/five">Five</a></li>
    </ul></main></body></html>`;
  const pruned = extractMarkdown(bareNav).markdown;
  assert.ok(pruned.includes('Real prose'));
  assert.ok(!pruned.includes('/one'), 'link-only list = in-content navigation → pruned');

  const described = `<html><body><main><h1>Resources</h1>
    <ul>
      <li><a href="/one">One</a> — a long description of the first resource with details</li>
      <li><a href="/two">Two</a> — another long description of the second resource here</li>
      <li><a href="/three">Three</a> — yet another descriptive sentence for this one too</li>
      <li><a href="/four">Four</a> — and a fourth description that is clearly content</li>
    </ul></main></body></html>`;
  const kept = extractMarkdown(described).markdown;
  assert.ok(kept.includes('first resource'), 'a content list (links + descriptions) must be preserved');
});

test('#8 pruning is site-aware: an OFF-SITE link list is references (kept), same-site nav still pruned', () => {
  const html = `<html><body><main><h1>Guide</h1>
    <p>For more information regarding supported package managers, please visit their official websites:</p>
    <ul>
      <li><a href="https://pnpm.io/">pnpm</a></li><li><a href="https://yarnpkg.com/">yarn</a></li>
      <li><a href="https://www.npmjs.com/">npm</a></li><li><a href="https://bun.sh/">bun</a></li>
    </ul>
    <ul>
      <li><a href="/one">One</a></li><li><a href="/two">Two</a></li>
      <li><a href="/three">Three</a></li><li><a href="/four">Four</a></li>
      <li><a href="/five">Five</a></li>
    </ul></main></body></html>`;
  const { markdown } = extractMarkdown(html, { baseUrl: 'https://ex.com/docs/install' });
  assert.ok(markdown.includes('https://pnpm.io'), 'external reference list is content, never navigation');
  assert.ok(markdown.includes('https://yarnpkg.com'));
  assert.ok(!markdown.includes('ex.com/one'), 'same-site bare link list is still pruned as navigation');
});

test('ARIA tab strip is chrome (junk label row dropped), tab PANELS are content (kept)', () => {
  const html = `<html><body><main><h1>Install</h1>
    <p>Paste the following code into your terminal to get going quickly.</p>
    <div role="tablist"><button role="tab">pnpm</button><button role="tab">yarn</button><button role="tab">npm</button></div>
    <div role="tabpanel"><pre><code class="language-bash">pnpm create x</code></pre></div>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(!/pnpmyarn|yarnnpm/.test(markdown.replace(/\s+/g, '')), 'tab label row must not serialise as junk text');
  assert.ok(markdown.includes('pnpm create x'), 'the tab panel is content');
});

test('ARIA lists (role=list/listitem): one item = one bullet line, whatever the tag', () => {
  const html = `<html><body><main><h1>Feed</h1>
    <p>Enough intro prose so the main-content picker anchors on this container.</p>
    <div role="list">
      <div role="listitem"><div><span>JL</span></div><div><b>John Leider</b><div>21 Mar 8:00PM</div></div><div>+$36.11</div></div>
      <div role="listitem"><div><span>$</span></div><div><b>ATM withdrawal</b><div>21 Mar 6:00PM</div></div><div>-$20.00</div></div>
    </div></main></body></html>`;
  const { markdown } = extractMarkdown(html);
  const lines = markdown.split('\n');
  assert.ok(lines.some((l) => /^- .*John Leider.*21 Mar 8:00PM.*\+\$36\.11/.test(l)), `item fields share one bullet — got:\n${markdown}`);
  assert.ok(lines.some((l) => /^- .*ATM withdrawal.*21 Mar 6:00PM.*-\$20\.00/.test(l)));
});

test('role-less repeated rows (same-shape sibling divs) become bullets; prose paragraphs never do', () => {
  const html = `<html><body><main><h1>Feed</h1>
    <p>Prose paragraph one, long enough to look like real article content here.</p>
    <p>Prose paragraph two, also long enough to look like real article content.</p>
    <div class="wrap">
      <div class="row row--a"><span>JL</span><b>John Leider</b><div>21 Mar 8:00PM</div><div>+$36.11</div></div>
      <div class="row"><span>$</span><b>ATM withdrawal</b><div>21 Mar 6:00PM</div><div>-$20.00</div></div>
      <div class="row"><span>JD</span><b>Jane Doe</b><div>21 Mar 4:00PM</div><div>+$45.00</div></div>
    </div></main></body></html>`;
  const { markdown } = extractMarkdown(html);
  const lines = markdown.split('\n');
  assert.ok(lines.some((l) => /^- .*John Leider.*21 Mar 8:00PM.*\+\$36\.11/.test(l)), `row fields share one bullet — got:\n${markdown}`);
  assert.ok(lines.some((l) => /^- .*Jane Doe/.test(l)));
  assert.ok(lines.some((l) => /^Prose paragraph one/.test(l.trim())), 'prose stays a paragraph, never a bullet');
});

test('an empty-alt image never leaves an orphan "!" and never breaks a block\'s dedup identity', () => {
  // The permalink cleanup must not eat the `[](src)` of `![](src)`.
  const html = `<html><body><main><h1>T</h1>
    <p>Enough intro prose so the main-content picker anchors on this container.</p>
    <p><img src="https://cdn.example/avatar.png" alt=""> G Pro X Superlight</p></main></body></html>`;
  const { markdown } = extractMarkdown(html, { baseUrl: 'https://ex.com/' });
  assert.ok(!/(^|\s)!(\s|$)/.test(markdown), `no orphan bang — got:\n${markdown}`);
  // Dedup identity ignores the decorative image: the same row with and without
  // its lazy-loaded avatar is ONE block, not two.
  const acc = new BlockAccumulator();
  acc.add('Intro.\n\nG Pro X Superlight $149');
  assert.equal(acc.add('Intro.\n\n![](https://cdn.example/a.png) G Pro X Superlight $149'), 0, 'lazy avatar must not re-add the row');
  // …but an image-only block keeps its identity (real content, not decoration)
  assert.equal(acc.add('![](https://cdn.example/photo1.png)'), 1);
});

test('GFM table with block markup inside cells stays a valid table (one line per row)', () => {
  const html = `<html><body><main><h1>Orders</h1>
    <p>Intro prose long enough for the main-content picker to hold onto here.</p>
    <table>
      <thead><tr><th><div><button>Name</button></div></th><th><div>Status</div></th></tr></thead>
      <tbody><tr><td><div><p>G Pro X</p></div></td><td><div><span>Completed</span> <span>(5.0)</span></div></td></tr></tbody>
    </table></main></body></html>`;
  const { markdown } = extractMarkdown(html);
  const rows = markdown.split('\n').filter((l) => l.trim().startsWith('|'));
  assert.ok(rows.some((l) => l.includes('Name') && l.includes('Status')), `header cells share one line — got:\n${markdown}`);
  assert.ok(rows.some((l) => l.includes('G Pro X') && l.includes('Completed') && l.includes('(5.0)')), 'data cells share one line');
  assert.ok(!/\|\s*\n\s*[^|\s]/.test(markdown), 'no cell content bleeding outside its row');
});

test('self-served ad cards ("ads via …") are removed whole; prose mentioning ads survives', () => {
  const html = `<html><body><main><h1>T</h1>
    <p>Real prose that stays, including a mention of ads via networks in a full sentence.</p>
    <a href="https://sponsor.example/click"><img src="https://cdn.example/x.png" alt="">
      <span>Display options elegantly with Sponsor Snips for a streamlined experience.</span>
      <span>ads via vuetify</span></a>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(!/ads via vuetify/.test(markdown), 'the ad label must go');
  assert.ok(!markdown.includes('Sponsor Snips'), 'the whole ad card goes with it (copy included)');
  assert.ok(markdown.includes('Real prose that stays'), 'prose about ads is content, not an ad');
});

test('code fences keep their indentation and blank lines (cleanup never reaches inside a fence)', () => {
  const html = `<html><body><main><h1>T</h1>
    <p>Enough intro prose so the main-content picker has something real to hold.</p>
    <pre><code class="language-ts">export default {
  build: {
    transpile: ['vuetify'],
  },
}</code></pre></main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(markdown.includes("    transpile: ['vuetify'],"), 'nested code indentation must survive');
  assert.ok(markdown.includes('  build: {'), 'top-level code indentation must survive');
});

test('nested list indentation survives the whitespace cleanup', () => {
  const html = `<html><body><main><h1>T</h1>
    <p>Enough intro prose so the main-content picker has something real to hold.</p>
    <ul><li>top item<ul><li>nested item</li></ul></li></ul></main></body></html>`;
  const { markdown } = extractMarkdown(html);
  const nested = markdown.split('\n').find((l) => l.includes('nested item'));
  assert.ok(nested && /^\s{2,}-\s/.test(nested), `nested bullet keeps its leading indent — got: "${nested}"`);
});

test('content-ambiguous containers are NEVER stripped as chrome (menu/announcement/form)', () => {
  const html = `<html><body><main>
    <h1>La Nostra Pizzeria</h1>
    <div class="menu"><h2>Pizze Rosse</h2><p>Margherita — €6.50</p><p>Diavola — €8.00</p></div>
    <div class="announcement"><p>School closed on Friday for maintenance.</p></div>
    <form><label>Choose a slot</label><p>Monday 9:00 — 2 places free</p></form>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(markdown.includes('Margherita — €6.50'), 'a .menu food menu is content, not chrome');
  assert.ok(markdown.includes('School closed on Friday'), 'an .announcement can be real content');
  assert.ok(markdown.includes('Monday 9:00'), 'form-wrapped content (booking/order flows) must survive');
});

test('header removal is article-aware: masthead dropped, an article\'s own header kept', () => {
  const html = `<html><body><main>
    <header>Global Site Header With Menu Links And More Chrome Text</header>
    <article>
      <header><h1>Post Title</h1><p>By Jane Doe</p></header>
      <p>The actual body prose of the article, long enough to matter here.</p>
    </article>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(!markdown.includes('Global Site Header'), 'site masthead is chrome');
  assert.ok(markdown.includes('Post Title'), "an article's own header is content");
  assert.ok(markdown.includes('By Jane Doe'));
  assert.ok(markdown.includes('actual body prose'));
});

test('data-URI images dropped, real-URL images kept, toolbar links stripped', () => {
  const html = `<html><body><main><h1>T</h1>
    <p><img src="data:image/svg+xml,%3Csvg%3E..." alt="deco"><img src="https://ex.com/pic.png" alt="pic"></p>
    <p><a href="/edit">Edit this page</a></p>
    <p>Body text stays.</p></main></body></html>`;
  const { markdown } = extractMarkdown(html, { baseUrl: 'https://ex.com/' });
  assert.ok(!markdown.includes('data:image'), 'data-URI image must be dropped');
  assert.ok(markdown.includes('![pic](https://ex.com/pic.png)'), 'real image must survive');
  assert.ok(!markdown.includes('Edit this page'), 'toolbar action link must be stripped');
  assert.ok(markdown.includes('Body text stays.'));
});

test('stripSvgNoise drops leaked SVG-markup blocks only', () => {
  const md = 'Real paragraph.\n\nfeGaussianBlur stdDeviation gradientUnits noise\n\nAnother real one.';
  const out = stripSvgNoise(md);
  assert.ok(out.includes('Real paragraph.') && out.includes('Another real one.'));
  assert.ok(!out.includes('feGaussianBlur'));
});

test('splitBlocks: fence-aware (a blank line inside a fence does not split it)', () => {
  const md = 'p1\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\np2';
  const blocks = splitBlocks(md);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].startsWith('```js') && blocks[1].endsWith('```'));
  assert.ok(blocks[1].includes('const a') && blocks[1].includes('const b'));
});

test('classifyBlock recognises structural types', () => {
  assert.equal(classifyBlock('# Title').type, 'heading');
  assert.equal(classifyBlock('```js\nx\n```').type, 'code');
  assert.equal(classifyBlock('| a | b |\n|---|---|\n| 1 | 2 |').type, 'table');
  assert.equal(classifyBlock('- item one\n- item two').type, 'list');
  assert.equal(classifyBlock('![alt](x.png)').type, 'image');
  assert.equal(classifyBlock('plain words').type, 'text');
});

test('enrichBlocks builds the heading-ancestry sectionPath', () => {
  const enriched = enrichBlocks(['# A', 'para', '## B', { text: 'para2', provenance: 'tab:X' }]);
  assert.deepEqual(enriched[0].sectionPath, []); // a heading sits UNDER its parents only
  assert.deepEqual(enriched[1].sectionPath, ['A']);
  assert.deepEqual(enriched[2].sectionPath, ['A']);
  assert.deepEqual(enriched[3].sectionPath, ['A', 'B']);
  assert.equal(enriched[3].provenance, 'tab:X');
  assert.equal(enriched[1].provenance, 'baseline');
  assert.deepEqual(enriched.map((b) => b.ord), [0, 1, 2, 3]);
});

test('stripImages / stripLinks / applyExclusions are verbatim-safe for words', () => {
  const md = 'See [![alt](i.png)](https://x) and ![a](p.png) plus [Home](https://ex.com) text.';
  const noImg = stripImages(md);
  assert.ok(!noImg.includes('i.png') && !noImg.includes('p.png'));
  assert.ok(noImg.includes('[Home](https://ex.com)'), 'plain links survive stripImages');
  const noLinks = stripLinks(noImg);
  assert.ok(noLinks.includes('Home'), 'link TEXT is kept');
  assert.ok(!noLinks.includes('https://ex.com'), 'link target is dropped');
  assert.equal(applyExclusions(md, {}), md, 'no exclusions = no-op');
});

test('contentWordLen ignores link text/URLs (removing nav must not look like content loss)', () => {
  assert.equal(contentWordLen('[One](https://a) [Two](https://b) hello world'), contentWordLen('hello world'));
  assert.ok(contentWordLen('real prose here') > 0);
});

test('BlockAccumulator dedups across captures and tracks variant provenance', () => {
  const acc = new BlockAccumulator();
  assert.equal(acc.add('Shared intro.\n\nBase content.'), 2);
  // a tab variant re-serialises the shared parts — only the NEW block counts
  assert.equal(acc.add('Shared intro.\n\nTab one content.', { label: 'Tab1', provenance: 'tab:Tab1' }), 1);
  assert.equal(acc.size(), 3);
  const md = acc.toMarkdown();
  assert.ok(md.includes('**Tab1:**'), 'tab variants carry a VISIBLE marker (an HTML comment vanishes when rendered)');
  assert.ok(md.indexOf('Base content.') < md.indexOf('Tab one content.'), 'capture order preserved');
  const blocks = acc.toBlocks();
  assert.deepEqual(blocks.map((b) => b.provenance), ['baseline', 'baseline', 'tab:Tab1']);
});

test('BlockAccumulator anchors variant blocks IN PLACE (tab siblings adjacent, not appended at the end)', () => {
  // The doc: intro → [active tab's code] → outro → footer. Each tab state re-serialises
  // the whole page with ONLY its own panel visible; the new panel must land beside the
  // sibling it replaces (before the shared block that follows), not after the footer.
  const state = (cmd) => `# Title\n\nIntro paragraph.\n\n\`\`\`bash\n${cmd}\n\`\`\`\n\nOutro paragraph.\n\nFooter text.`;
  const acc = new BlockAccumulator();
  acc.add(state('pnpm create x'));
  assert.equal(acc.add(state('yarn create x'), { label: 'yarn', provenance: 'tab:yarn' }), 1);
  assert.equal(acc.add(state('npm create x'), { label: 'npm', provenance: 'tab:npm' }), 1);
  const md = acc.toMarkdown();
  const order = ['pnpm create x', '**yarn:**', 'yarn create x', '**npm:**', 'npm create x', 'Outro paragraph.', 'Footer text.'];
  let last = 0;
  for (const s of order) {
    const i = md.indexOf(s, last); // search FORWARD ("npm create x" is a substring of "pnpm create x")
    assert.ok(i >= 0, `"${s}" must appear after the previous item — got:\n${md}`);
    last = i + s.length;
  }
});

test('BlockAccumulator still APPENDS truly-appended content (load-more: nothing known follows it)', () => {
  const acc = new BlockAccumulator();
  acc.add('Intro.\n\nItem one.');
  assert.equal(acc.add('Intro.\n\nItem one.\n\nItem two.', { provenance: 'loadmore' }), 1);
  const md = acc.toMarkdown();
  assert.ok(md.indexOf('Item one.') < md.indexOf('Item two.'), 'appended content stays in reading order');
});

test('load-more over THREE states never duplicates an item (accretive: each new block once)', () => {
  const acc = new BlockAccumulator();
  acc.add('Intro.\n\nItem one.');
  acc.add('Intro.\n\nItem one.\n\nItem two.', { provenance: 'loadmore' });
  acc.add('Intro.\n\nItem one.\n\nItem two.\n\nItem three.', { provenance: 'loadmore' });
  const md = acc.toMarkdown();
  for (const [item, n] of [['Item one.', 1], ['Item two.', 1], ['Item three.', 1]]) {
    assert.equal(md.split(item).length - 1, n, `${item} appears exactly once (accretive, not repeated per state)`);
  }
  assert.ok(md.indexOf('Item one.') < md.indexOf('Item two.') && md.indexOf('Item two.') < md.indexOf('Item three.'), 'reading order kept');
});

test('compact-but-structured: a partial change keeps each state WHOLE, frame shared once (A,b,c → A,b,d → r,b,d)', () => {
  // The user's case: mutually-exclusive partial changes. `d`/`r` must NOT be
  // orphaned into a flat A,b,c,d,r — each state's changing context is grouped and
  // labelled; only the block present in EVERY state (BBB) is the shared frame.
  const acc = new BlockAccumulator();
  acc.add('AAA\n\nBBB\n\nCCC'); // state 1 (baseline)
  acc.add('AAA\n\nBBB\n\nDDD', { label: 'S2', provenance: 'control:S2', order: 100 }); // c → d
  acc.add('RRR\n\nBBB\n\nDDD', { label: 'S3', provenance: 'control:S3', order: 200 }); // A → r
  const md = acc.toMarkdown();
  const count = (s) => md.split(s).length - 1;
  assert.equal(count('BBB'), 1, 'the shared frame (present in ALL states) appears once');
  assert.ok(md.includes('**S2:**') && md.includes('**S3:**'), 'each changing state is labelled, never orphaned');
  assert.equal(count('AAA'), 2, 'AAA stays in the two states that show it (base + S2)');
  assert.equal(count('DDD'), 2, 'DDD stays in both states that show it (S2 + S3)');
  const s2 = md.indexOf('**S2:**');
  const s3 = md.indexOf('**S3:**');
  assert.ok(md.slice(s2, s3).includes('AAA') && md.slice(s2, s3).includes('DDD'), 'S2 shows its full context (A·d) together');
  assert.ok(md.slice(s3).includes('RRR') && md.slice(s3).includes('DDD'), 'S3 shows its full context (r·d) together');
});

test('states() is the FAITHFUL per-state record — every snapshot whole and verbatim', () => {
  const acc = new BlockAccumulator();
  acc.add('AAA\n\nBBB\n\nCCC');
  acc.add('AAA\n\nBBB\n\nDDD', { label: 'S2', provenance: 'control:S2', order: 100 });
  acc.add('RRR\n\nBBB\n\nDDD', { label: 'S3', provenance: 'control:S3', order: 200 });
  const snaps = acc.states();
  assert.equal(snaps.length, 3, 'one record per captured state — nothing lost at merge time');
  assert.equal(snaps[0].markdown, 'AAA\n\nBBB\n\nCCC', 'state 1 whole');
  assert.equal(snaps[1].markdown, 'AAA\n\nBBB\n\nDDD', 'state 2 whole (A,b,d — not just the delta d)');
  assert.equal(snaps[2].markdown, 'RRR\n\nBBB\n\nDDD', 'state 3 whole (r,b,d)');
  assert.equal(snaps[1].label, 'S2');
  assert.equal(snaps[2].provenance, 'control:S3');
});

// --- #26: visual headings — the .md keeps the skeleton the page painted -----
// Node path: inline styles stand in for computed styles (the browser twin in
// engine/perceive.mjs is verified live, like #25).

test('#26 big short card title → heading; real <h4> keeps its level; non-heading text unchanged', () => {
  const page = (titleStyle) => `<html><body><main>
    <p>Body prose at the default font size, long enough to dominate the page histogram easily.</p>
    <h4 style="font-size:32px">Component Gallery</h4>
    <div style="${titleStyle}">Summary</div>
    <p>Card content below the summary title, also at the default body font size here.</p>
  </main></body></html>`;
  const withBig = extractMarkdown(page('font-size:22px')).markdown;
  assert.ok(/^### Summary$/m.test(withBig), `22px vs 16px body (1.375×) → h3 — got:\n${withBig}`);
  assert.ok(/^#### Component Gallery$/m.test(withBig), 'a real h4 keeps its semantic level');
  assert.ok(!/^###? Component Gallery$/m.test(withBig), 'a real h4 is never re-levelled by its 32px font');
  // Rule #1: the ONLY difference vs the unstyled page is the added heading level.
  const flat = extractMarkdown(page('font-size:16px')).markdown;
  assert.equal(withBig.replace(/^### Summary$/m, 'Summary'), flat, 'non-heading text must be byte-identical');
});

test('#26 a big jump (≥1.8× body) maps to h2', () => {
  const html = `<html><body><main>
    <p>Plenty of default-size prose here so the page body font lands on sixteen pixels.</p>
    <div style="font-size:30px">Big Section</div>
    <p>Content under the big visual section title, still at the default body size.</p>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(/^## Big Section$/m.test(markdown), '30px / 16px = 1.875 → h2');
});

test('#26 a short standalone BOLD line at body size becomes an h4 (weight rule)', () => {
  const html = `<html><body><main>
    <p>Enough regular prose before the label so the local body font is measurable.</p>
    <div style="font-weight:700">Quick facts</div>
    <p>And the facts themselves following the bold label, in plain body text.</p>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(/^#### Quick facts$/m.test(markdown), 'bold ≥600 at body size → h4');
});

test('#26 a LONG bold paragraph is NOT promoted (a heading is one short line)', () => {
  const long = 'A long bold introduction paragraph that clearly runs past the sixty character line limit for titles.';
  const html = `<html><body><main>
    <p>Some regular prose first, at the standard body font size of the page.</p>
    <p style="font-weight:700">${long}</p>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(markdown.includes(long), 'the paragraph text survives verbatim');
  assert.ok(!/^#{1,6}\s+A long bold/m.test(markdown), 'long bold prose is a paragraph, not a heading');
});

test('#26 never inside links/buttons/lists/tables/listitems (#25 keeps them)', () => {
  const html = `<html><body><main><h1>Guide</h1>
    <p>Regular prose so the page has a normal body font baseline for the ratio.</p>
    <a href="/x"><div style="font-size:24px">Big Link Card</div></a>
    <ul><li><span style="font-size:22px">Big list item text</span></li></ul>
    <div role="listitem"><div style="font-size:22px">Row title</div></div>
    <button><span style="font-size:22px">Big button</span></button>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html, { baseUrl: 'https://ex.com/' });
  assert.ok(!/^#{2,6}\s/m.test(markdown), `no visual heading may come from a control/list/cell — got:\n${markdown}`);
  assert.ok(markdown.includes('Big Link Card'), 'the content itself is kept');
});

test('#26 an all-big block (hero) does not promote its own lines (LOCAL body font)', () => {
  const html = `<html><body><main>
    <p>Default-size body prose elsewhere on the page to anchor the global histogram.</p>
    <section>
      <div style="font-size:22px">Hero line</div>
      <p style="font-size:22px">Hero paragraph also at twenty-two pixels with plenty of characters to dominate the local neighbourhood.</p>
    </section>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(markdown.includes('Hero line'), 'hero text is kept');
  assert.ok(!/^#{1,6}\s+Hero line/m.test(markdown), 'no jump vs its OWN surroundings → not a heading');
});

test('#26 bare numbers/prices and composite stat cards are data, not titles', () => {
  const html = `<html><body><main>
    <p>Ordinary paragraph text at the default size fills out the page body here.</p>
    <div style="font-size:28px">$44.99</div>
    <div><span style="font-size:40px">42</span><span style="font-size:13px">Active users</span></div>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(markdown.includes('$44.99'), 'the value survives');
  assert.ok(!/^#{1,6}\s/m.test(markdown), 'letterless values and mixed-size blocks are never headings');
});

test('#26 repeated same-shape rows (transaction feed) stay #25 bullets, never h4 titles', () => {
  const html = `<html><body><main>
    <p>Intro prose at body size so the histogram has its normal reference point.</p>
    <div class="feed">
      <div class="row row--a"><span>JL</span><b>John Leider</b><span>21 Mar 8:00PM</span></div>
      <div class="row"><span>$</span><b>ATM withdrawal</b><span>21 Mar 6:00PM</span></div>
      <div class="row"><span>JD</span><b>Jane Doe</b><span>21 Mar 4:00PM</span></div>
    </div>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(/^- JL.*John Leider/m.test(markdown), `rows render as bullets — got:\n${markdown}`);
  assert.ok(!/^#{1,6}\s/m.test(markdown), 'a bold name inside a data row must not become a heading');
});

test('#26 browser-stamped data-sagecrawl-heading converts even with no styles at all', () => {
  const html = `<html><body><main>
    <p>Page text captured in the browser, where computed styles marked the title.</p>
    <div data-sagecrawl-heading="2">Injected Title</div>
    <p>Content following the injected title in the captured state.</p>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(/^## Injected Title$/m.test(markdown), 'the marker IS the contract with the browser path');
  assert.ok(!markdown.includes('data-sagecrawl-heading'), 'the marker never leaks into the output');
});

test('#26 a wrapper block whose big text lives in an inline child is still caught', () => {
  const html = `<html><body><main>
    <p>Standard body copy on the page so the dominant font size stays at default.</p>
    <div><span style="font-size:22px">Wrapped Title</span></div>
    <p>Body content that belongs under the wrapped visual title of this card.</p>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(/^### Wrapped Title$/m.test(markdown), 'the block owning the line is marked, not the span');
});

test('#26 a big title in a NESTED wrapper inside a repeated tile stays a bullet (no `- #### …`)', () => {
  // Regression: the marked node is a title-WRAPPER nested in the card, so a
  // sibling-only check missed it and #25 flattened it to `- #### Misty Mountains`.
  // The candidate must look at ANCESTORS: the tile is the repeated shaped row.
  const tile = (name, date) =>
    `<div class="tile"><div class="tt"><span style="font-size:22px;font-weight:700">${name}</span></div><div class="date">${date}</div></div>`;
  const html = `<html><body><main>
    <p>Gallery intro prose at the default body size to anchor the font histogram.</p>
    <div class="gallery">
      ${tile('Misty Mountains', '1st Dec')}
      ${tile('Lake Reflection', '2nd Dec')}
      ${tile('Forest Sunrise', '3rd Dec')}
    </div>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(!/#{2,6}\s/.test(markdown), `no heading marker may survive inside a flattened tile — got:\n${markdown}`);
  assert.ok(/^- .*Misty Mountains/m.test(markdown), 'each tile is one clean bullet');
});

test('#26 a big stat-card VALUE with a unit letter (24.5K) never leaks a mid-line ###', () => {
  const card = (label, value) =>
    `<div class="stat"><div class="lbl">${label}</div><div class="val"><span style="font-size:28px;font-weight:700">${value}</span></div></div>`;
  const html = `<html><body><main>
    <p>Analytics intro prose at the default body size to anchor the histogram here.</p>
    <div class="stats">
      ${card('Page Views', '24.5K')}
      ${card('Visitors', '8,234')}
      ${card('Avg. Duration', '3m 24s')}
    </div>
  </main></body></html>`;
  const { markdown } = extractMarkdown(html);
  assert.ok(markdown.includes('24.5K') && markdown.includes('3m 24s'), 'the values survive');
  assert.ok(!/#{2,6}/.test(markdown), `stat-card values are data, never headings — got:\n${markdown}`);
});

// --- #27: representation order — reveal states in page order, base first ----

test('#27 mutually-exclusive views sharing one anchor land in page order (base first), not click order', () => {
  // An embedded app: Dashboard/Analytics/Chat/Settings all render in the same
  // panel, so every view anchors to the SAME following block (Sponsors). `order`
  // is each nav item's vertical position (rail: Dashboard top → Settings bottom).
  // Dashboard is captured LAST here (revisited after the others) but has the
  // smallest order, so it must jump to the front of the slot.
  const state = (body) => `Gallery header.\n\n${body}\n\nSponsors footer.`;
  const acc = new BlockAccumulator();
  acc.add(state('Placeholder.'));                                                  // baseline skeleton, order 0
  acc.add(state('Analytics view.'), { label: 'Analytics', provenance: 'control:Analytics', order: 200 });
  acc.add(state('Chat view.'), { label: 'Chat', provenance: 'control:Chat', order: 300 });
  acc.add(state('Settings view.'), { label: 'Settings', provenance: 'control:Settings', order: 400 });
  acc.add(state('Dashboard view.'), { label: 'Dashboard', provenance: 'control:Dashboard', order: 100 });
  const md = acc.toMarkdown();
  const order = ['Gallery header', 'Dashboard view', 'Analytics view', 'Chat view', 'Settings view', 'Sponsors footer'];
  let last = -1;
  for (const s of order) {
    const i = md.indexOf(s);
    assert.ok(i > last, `"${s}" out of representation order — got:\n${md}`);
    last = i;
  }
});

test('#27 a reveal state whose only following block is a frame divider anchors PAST it (base stays first)', () => {
  // The vuetify case in miniature: the default view content sits below a `---`
  // divider; a swapped-in view is followed by the SAME divider (an app-frame rule
  // that recurs in every view). Anchoring to the divider would drop the revealed
  // view ABOVE the base content — skipping the weak anchor keeps base-view-first.
  const acc = new BlockAccumulator();
  acc.add('Header.\n\n---\n\nBase view content.\n\nSponsors footer.');
  acc.add('Header.\n\nRevealed view content.\n\n---\n\nSponsors footer.', { order: 500 });
  const md = acc.toMarkdown();
  assert.ok(
    md.indexOf('Base view content.') < md.indexOf('Revealed view content.'),
    `the base view must stay before the revealed view — got:\n${md}`,
  );
  assert.ok(
    md.indexOf('Revealed view content.') < md.indexOf('Sponsors footer.'),
    'the revealed view still lands before the distinctive footer',
  );
});

test('#27 a multi-block view stays contiguous and in reading order within its slot', () => {
  const acc = new BlockAccumulator();
  acc.add('Head.\n\nTail.');
  acc.add('Head.\n\nAlpha one.\n\nAlpha two.\n\nTail.', { order: 150 });
  const md = acc.toMarkdown();
  assert.ok(md.indexOf('Head.') < md.indexOf('Alpha one.'), 'group sits after the shared head');
  assert.ok(md.indexOf('Alpha one.') < md.indexOf('Alpha two.'), 'reading order kept inside the group');
  assert.ok(md.indexOf('Alpha two.') < md.indexOf('Tail.'), 'group sits before the shared tail');
});

test('#27 order 0 everywhere preserves the legacy click-order merge (tabs unaffected)', () => {
  // Same as the tab-variant test but asserted explicitly: with no positional
  // order the merge is byte-for-byte the old anchored behaviour.
  const state = (cmd) => `Intro.\n\n${cmd}\n\nOutro.`;
  const acc = new BlockAccumulator();
  acc.add(state('pnpm x'));
  acc.add(state('yarn x'), { label: 'yarn', provenance: 'tab:yarn' });
  acc.add(state('npm x'), { label: 'npm', provenance: 'tab:npm' });
  const md = acc.toMarkdown();
  const order = ['pnpm x', 'yarn x', 'npm x', 'Outro.'];
  let last = -1;
  for (const s of order) {
    const i = md.indexOf(s, last + 1);
    assert.ok(i > last, `"${s}" not in click order — got:\n${md}`);
    last = i;
  }
});
