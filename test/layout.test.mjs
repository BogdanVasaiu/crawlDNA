// Output assembly: the consolidated verbatim .md (Phase 1) and the opt-in
// per-document packaging (#10) — union of bodies must equal the kept pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleScan, assemblePerDocument, extractHeadings } from '../src/lib/layout.mjs';

const pages = [
  {
    url: 'https://ex.com/docs/intro',
    title: 'Intro',
    markdown: '# Intro\n\nWelcome text.',
    meta: { fetchedAt: '2026-07-01T00:00:00.000Z' },
  },
  {
    url: 'https://ex.com/docs/setup',
    title: 'Setup',
    markdown: '# Setup\n\n```sh\nnpm i\n```',
    meta: { fetchedAt: '2026-07-01T00:00:01.000Z' },
  },
];

test('assembleScan: empty input → no files', () => {
  assert.deepEqual(assembleScan({ task: 't', pages: [] }), []);
  assert.deepEqual(assembleScan({ task: 't', pages: [{ markdown: '   ' }] }), []);
});

test('assembleScan: one consolidated file, task-derived name, front-matter, verbatim bodies', () => {
  const files = assembleScan({ task: 'Extract the full menu', pages });
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.filename, 'full-menu.md');
  assert.ok(f.markdown.startsWith('---\ntask: "Extract the full menu"'));
  assert.deepEqual(f.pages, pages.map((p) => p.url));
  for (const p of pages) {
    assert.ok(f.markdown.includes(p.markdown.trim()), `page body must appear verbatim: ${p.url}`);
    assert.ok(f.markdown.includes(`_Source: ${p.url}_`), 'multi-page scans record provenance');
  }
  assert.equal(f.bytes, Buffer.byteLength(f.markdown, 'utf8'));
});

test('assembleScan: single page gets no per-page header', () => {
  const files = assembleScan({ task: 'x', pages: [pages[0]] });
  assert.ok(!files[0].markdown.includes('_Source:'));
  assert.ok(files[0].markdown.includes('# Intro'));
});

test('assemblePerDocument: verbatim per-page bodies, stable ids, index + valid JSONL', () => {
  const out = assemblePerDocument({ task: 'Extract docs', pages });
  assert.equal(out.documents.length, 2);
  assert.deepEqual(out.documents.map((d) => d.id), ['docs-intro', 'docs-setup']);
  for (let i = 0; i < pages.length; i++) {
    assert.equal(out.documents[i].markdown, pages[i].markdown.trim(), 'body must be VERBATIM');
    assert.equal(out.documents[i].url, pages[i].url);
    assert.ok(out.files[i].markdown.includes(pages[i].markdown.trim()));
    assert.ok(out.files[i].markdown.startsWith('---\n'), 'per-doc file carries front-matter');
  }
  assert.ok(out.index.markdown.includes('(documents/docs-intro.md)'));
  const lines = out.jsonl.content.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const rec = JSON.parse(line); // every line must be valid standalone JSON
    assert.ok(rec.id && rec.url && rec.file.startsWith('documents/'));
  }
});

test('assemblePerDocument: id collisions get a stable numeric suffix', () => {
  const twin = { ...pages[0], url: 'https://ex.com/docs/intro?v=2' };
  const out = assemblePerDocument({ task: 't', pages: [pages[0], twin] });
  assert.deepEqual(out.documents.map((d) => d.id), ['docs-intro', 'docs-intro-2']);
});

test('extractHeadings: H1–H3 outline, fence-aware', () => {
  const md = '# A\n\n```md\n# not a heading\n```\n\n## B\n\n#### too deep';
  assert.deepEqual(extractHeadings(md), [
    { level: 1, text: 'A' },
    { level: 2, text: 'B' },
  ]);
});
