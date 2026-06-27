// Output layout (Phase 1) — assemble a scan's crawled pages into its .md file.
//
// The two-phase model (set by the product): the CRAWL produces a faithful,
// VERBATIM extraction and nothing more — one consolidated .md per link (per
// scan). It never splits, filters or reshapes; all of that is Phase 2 ("reshape",
// the chat over the saved files — see src/reshape.mjs + engine/decide.mjs
// aiReshape). So this module's whole job is: concatenate the kept pages, in crawl
// order, under a small front-matter header, losing nothing.

import { slug } from './url.mjs';

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
    const header = multi
      ? `# ${(p.title || p.url || 'Page').trim()}\n\n_Source: ${p.url || ''}_\n\n`
      : '';
    parts.push(header + p.markdown.trim());
  }

  const body = parts.join(multi ? '\n\n---\n\n' : '\n\n').trim();
  const filename = sanitizeName(taskToName(task));
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
