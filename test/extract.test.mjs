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
  assert.ok(md.includes('<!-- variant: Tab1 -->'), 'tab variants carry their marker');
  assert.ok(md.indexOf('Base content.') < md.indexOf('Tab one content.'), 'capture order preserved');
  const blocks = acc.toBlocks();
  assert.deepEqual(blocks.map((b) => b.provenance), ['baseline', 'baseline', 'tab:Tab1']);
});
