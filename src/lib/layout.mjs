// Output layout — decide how the crawl's pages become .md files.
//
// The rule (set by the product): by DEFAULT everything lands in ONE .md file.
// The model only splits the content into several named files when the task
// asks for it ("extract drinks and pizzas separately" -> drinks.md + pizzas.md;
// "extract the menu prices" -> menu.md). Content is always kept VERBATIM — the
// model only chooses the grouping and the filenames, never rewrites text — and
// no section is ever dropped: anything the model fails to assign is folded into
// the first file so the output is always complete.

import { slug } from './url.mjs';
import { splitBlocks } from '../extract.mjs';
import { aiLayoutScheme, aiRouteBlocks, aiReformat } from '../engine/decide.mjs';

// Above this many BLOCKS we stop asking the model to route per page and just
// consolidate into a single file (a safety valve; routing is per-page so this is
// rarely hit).
const UNIT_CAP = 4000;

/** Canonicalise a filename to a safe `*.md` name (stable: same raw → same name). */
function canonName(raw) {
  const base = slug(String(raw || '').replace(/\.md$/i, '')) || 'content';
  return `${base}.md`;
}

/** Classify a Markdown block so the layout router knows its type / image-ness. */
function classifyBlock(text) {
  const t = String(text || '').trim();
  const hasImage = /!\[[^\]]*\]\([^)]*\)/.test(t);
  let type = 'text';
  if (/^#{1,6}\s/.test(t)) type = 'heading';
  else if (/^\s*(```|~~~)/.test(t)) type = 'code';
  else if (/\|/.test(t) && /\n\s*\|?[\s:|-]*-{2,}/.test(t)) type = 'table';
  else if (/^\s*([-*+]|\d+[.)])\s/m.test(t) && !hasImage) type = 'list';
  else if (hasImage && t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[\s)\]]/g, '').length < 3) type = 'image';
  return { type, hasImage };
}

/** Sanitise a model-proposed filename to a safe, unique `*.md` name. */
function sanitizeName(raw, used) {
  let base = slug(String(raw || '').replace(/\.md$/i, ''));
  if (!base) base = 'content';
  let name = `${base}.md`;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}.md`;
  used.add(name);
  return name;
}

/** Derive a fallback filename from the task (used only if the model fails). */
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

/**
 * Derive a filename base from a page (its URL's last path/fragment segment, else
 * its title). This is COSMETIC output naming only — it makes no crawl decision,
 * so parsing the URL here does not violate the "no URL-shape rules" principle
 * that governs link-following (decide.mjs). Works for normal paths (/docs/intro
 * -> "intro") and SPA fragment routes (/#/about -> "about", /#/feature01 ->
 * "feature01"); the root (/#/) has no segment, so it becomes "home".
 */
function pageFileBase(page) {
  let seg = '';
  try {
    const u = new URL(page.url);
    const tail = (u.pathname + u.hash).split(/[/#!?]+/).filter(Boolean);
    seg = tail.length ? tail[tail.length - 1] : '';
  } catch {
    /* fall through to title */
  }
  // Note: slug('') returns its own fallback ('section'), so only slug a
  // non-empty source; the root page (no segment, no title) becomes "home".
  const raw = (seg || page.title || '').trim();
  return raw ? slug(raw) : 'home';
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

/** Assemble one output file from a list of units (verbatim, original order). */
function makeFile(filename, task, units, generatedAt) {
  const sources = [];
  const seen = new Set();
  for (const u of units) {
    const url = u.page && u.page.url;
    if (url && !seen.has(url)) {
      seen.add(url);
      sources.push(url);
    }
  }
  const body = units.map((u) => u.text).join('\n\n').trim();
  const markdown = frontMatter({ task, sources, generatedAt }) + body + '\n';
  return {
    filename,
    title: deriveTitle(filename),
    markdown,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    pages: sources,
  };
}

function singleFile(task, units, generatedAt) {
  const name = sanitizeName(taskToName(task), new Set());
  return makeFile(name, task, units, generatedAt);
}

/**
 * One output file per crawled page (the "by pages" layout). Groups units by
 * their source page in first-seen (crawl) order and names each file from the
 * page. Lossless — every unit belongs to exactly one page — so the model only
 * has to choose this layout, never enumerate the files.
 */
function filesPerPage(task, units, generatedAt) {
  const used = new Set();
  const order = [];
  const byPage = new Map();
  for (const u of units) {
    if (!byPage.has(u.page)) {
      byPage.set(u.page, []);
      order.push(u.page);
    }
    byPage.get(u.page).push(u);
  }
  return order.map((page) =>
    makeFile(sanitizeName(pageFileBase(page), used), task, byPage.get(page), generatedAt),
  );
}

/**
 * Plan and assemble the output files for a finished crawl.
 * @param {object} a
 * @param {string} a.model   Ollama model for the grouping decision
 * @param {string} a.task    the (primary) task driving the grouping
 * @param {Array}  a.pages   result.pages
 * @returns {Promise<Array<{ filename, title, markdown, bytes, pages: string[] }>>}
 */
export async function planFiles({ model, task, pages, host }) {
  const all = (pages || []).filter((p) => (p.markdown || '').trim());
  if (all.length === 0) return [];
  const generatedAt = new Date().toISOString();

  // Units are BLOCKS (headings, paragraphs, images, lists, tables, code) in
  // document order, kept PER PAGE — fine-grained enough that the router can put
  // an image in a different file from its caption, or keep them together.
  const pageUnits = all
    .map((p) => splitBlocks(p.markdown).map((text) => ({ page: p, ...classifyBlock(text), text })))
    .filter((arr) => arr.length);
  const total = pageUnits.reduce((n, a) => n + a.length, 0);
  if (total === 0) return [];

  // STEP 1: decide the file plan from the task alone (cheap, scale-independent).
  let scheme;
  try {
    scheme = await aiLayoutScheme({ model, task, host });
  } catch {
    scheme = { single: true };
  }

  if (scheme.perPage) return filesPerPage(task, pageUnits.flat(), generatedAt);
  if (!scheme.files || !scheme.files.length || total > UNIT_CAP) {
    return [singleFile(task, pageUnits.flat(), generatedAt)];
  }

  // Canonicalise + dedupe the plan's files (stable names so per-page results
  // merge into the same buckets).
  const sf = [];
  const seenNames = new Set();
  for (const f of scheme.files) {
    const name = canonName(f.filename);
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    sf.push({ name, role: f.role, rule: f.rule });
  }
  const matchFiles = sf.filter((f) => f.role === 'match');
  const hasCatchAll = sf.some((f) => f.role === 'all' || f.role === 'complement');

  const byFile = new Map(sf.map((f) => [f.name, []]));
  const otherUnits = [];

  // STEP 2: route each page's blocks INTO the plan. "all"/"complement" files are
  // filled deterministically (so they can never be dropped); only the "match"
  // files need the model, one small per-page call at a time → reliable at scale.
  for (const units of pageUnits) {
    let routed = {};
    if (matchFiles.length) {
      try {
        routed = await aiRouteBlocks({
          model,
          task,
          host,
          files: matchFiles.map((f) => ({ filename: f.name, rule: f.rule })),
          blocks: units.map((u, i) => ({
            index: i,
            type: u.type,
            hasImage: u.hasImage,
            preview: u.text.replace(/\s+/g, ' ').slice(0, 140),
          })),
        });
      } catch {
        routed = {};
      }
    }

    // Normalise the model's per-file indexes (by canonical name).
    const matchIdx = new Map(matchFiles.map((f) => [f.name, new Set()]));
    for (const [rawName, idxs] of Object.entries(routed)) {
      const cn = canonName(rawName);
      if (!matchIdx.has(cn)) continue;
      for (const i of idxs) if (i >= 0 && i < units.length) matchIdx.get(cn).add(i);
    }
    const claimed = new Set();
    for (const s of matchIdx.values()) for (const i of s) claimed.add(i);

    for (const f of sf) {
      const bucket = byFile.get(f.name);
      if (f.role === 'all') {
        for (const u of units) bucket.push(u);
      } else if (f.role === 'complement') {
        units.forEach((u, i) => { if (!claimed.has(i)) bucket.push(u); });
      } else {
        [...matchIdx.get(f.name)].sort((a, b) => a - b).forEach((i) => bucket.push(units[i]));
      }
    }
    // Completeness: if there is no catch-all file, blocks that matched nothing
    // must still survive — collect them into an "other" bucket.
    if (!hasCatchAll) units.forEach((u, i) => { if (!claimed.has(i)) otherUnits.push(u); });
  }

  const files = [];
  for (const f of sf) {
    const bucket = byFile.get(f.name);
    if (bucket.length) files.push(makeFile(f.name, task, bucket, generatedAt));
  }
  if (otherUnits.length) files.push(makeFile(canonName('other'), task, otherUnits, generatedAt));
  if (files.length === 0) return [singleFile(task, pageUnits.flat(), generatedAt)];
  return files;
}

/** Separate a file's leading YAML front-matter from its body. */
function splitFrontMatter(md) {
  const m = String(md || '').match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
  return m ? { front: m[1], body: m[2] } : { front: '', body: String(md || '') };
}

/**
 * Apply the task's opt-in output transform (from aiInterpretTask) to already-
 * assembled files. Runs AFTER layout so it sees each file's full content. The
 * reshape (aiReformat) is grounded and self-targeting, so files whose content
 * does not fit the shape come back unchanged; a `transformed:` marker is added to
 * the front-matter of files that were actually reshaped, for transparency. A
 * no-op when no transform is requested, so callers can invoke it unconditionally.
 *
 * @param {Array} files  output of planFiles
 * @param {object} a  { model, task, transform: { shape }, host }
 * @returns {Promise<Array>}
 */
export async function transformFiles(files, { model, task, transform, host } = {}) {
  if (!transform || !transform.shape || !Array.isArray(files) || files.length === 0) return files;
  const out = [];
  for (const f of files) {
    const { front, body } = splitFrontMatter(f.markdown);
    const reshaped = await aiReformat({ model, task, shape: transform.shape, markdown: body, host }).catch(() => body);
    if (!reshaped || reshaped.trim() === body.trim()) {
      out.push(f); // didn't fit the shape (or failed) — keep verbatim
      continue;
    }
    const marker = front
      ? front.replace(/---\n$/, `transformed: ${JSON.stringify(transform.shape)}\n---\n`)
      : '';
    const markdown = marker + reshaped.trim() + '\n';
    out.push({ ...f, markdown, bytes: Buffer.byteLength(markdown, 'utf8') });
  }
  return out;
}
