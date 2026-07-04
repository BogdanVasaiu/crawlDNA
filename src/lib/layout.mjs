// Output layout (Phase 1) — assemble a scan's crawled pages into its .md file.
//
// The two-phase model (set by the product): the CRAWL produces a faithful,
// VERBATIM extraction and nothing more — one consolidated .md per link (per
// scan). It never splits, filters or reshapes; all of that is Phase 2 ("reshape",
// the chat over the saved files — see src/reshape.mjs + engine/decide.mjs
// aiReshape). So this module's whole job is: concatenate the kept pages, in crawl
// order, under a small front-matter header, losing nothing.

import { slug, pathOf, hostOf } from './url.mjs';

/** Sanitise a name to a safe `*.md` filename. */
function sanitizeName(raw) {
  const base = slug(String(raw || '').replace(/\.md$/i, '')) || 'content';
  return `${base}.md`;
}

/** Derive a fallback filename from the task. */
function taskToName(task) {
  const stop = new Set([
    'extract', 'get', 'the', 'a', 'an', 'of', 'all', 'from', 'and', 'to', 'for',
    'me', 'please', 'only', 'list', 'every', 'their', 'its', 'in', 'on', 'with',
  ]);
  const words = String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !stop.has(w))
    .slice(0, 4);
  return words.join('-') || 'content';
}

/** #23 — a task-less scan (noAi: the task has no role, naming included) is named
 *  from its SITE instead. */
function siteName(url) {
  const host = hostOf(url || '');
  return host ? host.replace(/^www\./, '') : '';
}

function deriveTitle(filename) {
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function frontMatter({ task, sources, generatedAt }) {
  const lines = ['---', `task: ${JSON.stringify(task || '')}`, `generatedAt: ${generatedAt}`];
  if (sources && sources.length) {
    lines.push('sources:');
    for (const s of sources) lines.push(`  - ${s}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Assemble one scan's kept pages into its output file(s). Always a SINGLE
 * consolidated, verbatim .md: every page's Markdown is concatenated in crawl
 * order. When a scan spans more than one page, each page's content is introduced
 * by a heading (its title) and a source line so provenance is clear and Phase 2
 * can address pages — a structural header only, the page content stays untouched.
 *
 * @param {object} a
 * @param {string} a.task   the scope task that drove the crawl (names the file)
 * @param {Array}  a.pages  result.pages — { url, title, markdown }
 * @returns {Array<{ filename, title, markdown, bytes, pages: string[] }>}
 */
export function assembleScan({ task, pages }) {
  const all = (pages || []).filter((p) => (p.markdown || '').trim());
  if (all.length === 0) return [];
  const generatedAt = new Date().toISOString();
  const multi = all.length > 1;

  const sources = [];
  const seen = new Set();
  const parts = [];
  for (const p of all) {
    if (p.url && !seen.has(p.url)) {
      seen.add(p.url);
      sources.push(p.url);
    }
    // Structural per-page header (multi-page scans): provenance must be clear and
    // Phase 2 must be able to address pages. When the page's own content already
    // OPENS with an H1 (most pages), repeating the <title>-derived name above it
    // would print two near-identical top headings back to back — the source line
    // alone identifies the page and the content keeps its own skeleton.
    const body = p.markdown.trim();
    const hasOwnH1 = /^#\s/.test(body);
    const header = multi
      ? (hasOwnH1 ? '' : `# ${(p.title || p.url || 'Page').trim()}\n\n`) + `_Source: ${p.url || ''}_\n\n`
      : '';
    parts.push(header + body);
  }

  const body = parts.join(multi ? '\n\n---\n\n' : '\n\n').trim();
  const named = String(task || '').trim() ? taskToName(task) : siteName(all[0].url);
  const filename = sanitizeName(named);
  const markdown = frontMatter({ task, sources, generatedAt }) + body + '\n';

  return [
    {
      filename,
      title: deriveTitle(filename),
      markdown,
      bytes: Buffer.byteLength(markdown, 'utf8'),
      pages: sources,
    },
  ];
}

// =========================================================================
// #10 — OPTIONAL per-document packaging
// =========================================================================
// The consolidated .md above is convenient for a human; a PROGRAMMATIC consumer (a
// script, a pipeline, an index — refdna included) usually wants ONE document per page
// with metadata and a stable id, so pages can be handled individually (Markdown-AST
// chunking, topic filtering, incremental updates). This is pure RE-PACKAGING of the
// exact same kept pages — nothing is filtered, transformed or lost: the union of the
// per-document bodies is identical to what the consolidated file contains. Off by
// default (opt-in via the `perDocument` option); the crawl itself stays verbatim.

/** A lightweight H1–H3 outline of a page (verbatim heading text), fence-aware — for
 *  metadata / RAG section paths. Never alters content. */
export function extractHeadings(markdown) {
  const out = [];
  let inFence = false;
  for (const line of String(markdown || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** A stable, human-readable title for the crawl index — from the task, or from the
 *  site when there is no task (#23, noAi). */
function taskToTitle(task, fallbackUrl) {
  const named = String(task || '').trim() ? taskToName(task) : siteName(fallbackUrl);
  return deriveTitle(sanitizeName(named));
}

/** Minimal self-describing front-matter for a per-document .md file. */
function docFrontMatter({ url, title, fetchedAt }) {
  const lines = ['---'];
  if (url) lines.push(`url: ${JSON.stringify(url)}`);
  if (title) lines.push(`title: ${JSON.stringify(title)}`);
  if (fetchedAt) lines.push(`fetchedAt: ${fetchedAt}`);
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Package one scan's kept pages as INDIVIDUAL documents (opt-in, #10). Verbatim: each
 * document's body is the page's own Markdown, untouched. Returns everything needed to
 * expose the format in memory AND write it to disk:
 *   - `documents` — one record per page: { id, url, title, fetchedAt, bytes, markdown,
 *     headings, file } (stable, URL-derived id; content is the verbatim page Markdown).
 *   - `files`     — the per-document .md files ({ filename, markdown }), each with a
 *     small front-matter header (url/title/fetchedAt) then the verbatim body.
 *   - `index`     — an llms.txt-style index of what was crawled ({ filename, markdown }).
 *   - `jsonl`     — a machine-readable line-per-document manifest ({ filename, content }).
 *
 * @param {object} a
 * @param {string} a.task
 * @param {Array}  a.pages  result.pages — { url, title, markdown, meta:{ fetchedAt } }
 */
export function assemblePerDocument({ task, pages }) {
  const all = (pages || []).filter((p) => (p.markdown || '').trim());
  if (all.length === 0) return { documents: [], files: [], index: null, jsonl: null };

  const usedIds = new Set();
  const stableId = (url, i) => {
    const p = pathOf(url || '');
    const source = p && p !== '/' ? p : hostOf(url || '') || `page-${i + 1}`;
    const base = slug(source) || `page-${i + 1}`;
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`; // stable + unique within the scan
    usedIds.add(id);
    return id;
  };

  const documents = [];
  const files = [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    const id = stableId(p.url || '', i);
    const md = p.markdown.trim();
    const title = (p.title || '').trim();
    const fetchedAt = (p.meta && p.meta.fetchedAt) || '';
    const filename = `${id}.md`;
    documents.push({
      id,
      url: p.url || '',
      title,
      fetchedAt,
      bytes: Buffer.byteLength(md, 'utf8'),
      markdown: md, // VERBATIM page body (no header) — clean for programmatic use
      headings: extractHeadings(md),
      file: filename,
    });
    files.push({ filename, markdown: docFrontMatter({ url: p.url, title, fetchedAt }) + md + '\n' });
  }

  const indexLines = [
    `# ${taskToTitle(task, all[0].url)}`,
    '',
    `_${documents.length} document(s) · generated ${new Date().toISOString()}_`,
    '',
  ];
  for (const d of documents) {
    indexLines.push(`- [${d.title || d.id}](documents/${d.file})${d.url ? ` — ${d.url}` : ''}`);
  }
  const index = { filename: 'index.md', markdown: indexLines.join('\n') + '\n' };

  const jsonl = {
    filename: 'documents.jsonl',
    content:
      documents
        .map((d) =>
          JSON.stringify({ id: d.id, url: d.url, title: d.title, fetchedAt: d.fetchedAt, bytes: d.bytes, file: `documents/${d.file}`, headings: d.headings }),
        )
        .join('\n') + '\n',
  };

  return { documents, files, index, jsonl };
}

/**
 * Package the FAITHFUL per-state record for pages whose reveal captured MORE THAN ONE
 * state (tabs, swapped views, partial changes). The consolidated .md is compact (the
 * shared frame once); this writes each page's whole snapshots VERBATIM — one section
 * per state under a `## State: <label>` marker — so the complete co-occurrence a
 * partial change scatters (`state 3 = r,b,d`) is always recoverable on disk. Single-
 * state pages don't qualify (their one state IS the consolidated page). Pure
 * repackaging: nothing filtered or transformed. Written under `states/` (see
 * output.mjs); never touches the manifest or the default consolidated output.
 *
 * @param {object} a
 * @param {Array}  a.pages  result.pages — some carrying `states: [{label,provenance,order,markdown}]`
 * @returns {{ files: Array<{filename: string, markdown: string}> }}
 */
export function assembleStates({ pages }) {
  const all = (pages || []).filter((p) => Array.isArray(p.states) && p.states.length > 1);
  if (all.length === 0) return { files: [] };

  const usedIds = new Set();
  const stableId = (url, i) => {
    const p = pathOf(url || '');
    const source = p && p !== '/' ? p : hostOf(url || '') || `page-${i + 1}`;
    const base = slug(source) || `page-${i + 1}`;
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`; // stable + unique within the scan
    usedIds.add(id);
    return id;
  };

  const files = [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    const id = stableId(p.url || '', i);
    const parts = [docFrontMatter({ url: p.url, title: (p.title || '').trim(), fetchedAt: (p.meta && p.meta.fetchedAt) || '' })];
    parts.push(`> Faithful reveal record — ${p.states.length} captured states, each whole and verbatim.`);
    p.states.forEach((s, k) => {
      const name = s.label || (s.provenance && s.provenance !== 'baseline' ? s.provenance : k === 0 ? 'base' : `state ${k + 1}`);
      parts.push(`## State: ${name}\n\n${String(s.markdown || '').trim()}`);
    });
    files.push({ filename: `${id}.md`, markdown: parts.join('\n\n') + '\n' });
  }
  return { files };
}
