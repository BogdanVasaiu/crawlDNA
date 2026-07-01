// HTML -> clean Markdown. Isolate the main content node, drop site chrome,
// convert with Turndown (fenced code + GFM tables).

import { createHash } from 'node:crypto';
import { parse } from 'node-html-parser';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Elements that are site chrome, never content. Removed from within the chosen
// content node before conversion.
const CHROME_SELECTORS = [
  'script', 'style', 'noscript', 'svg', 'template', 'iframe',
  'nav', 'aside', 'footer', 'header', 'form',
  '[role=navigation]', '[role=banner]', '[role=contentinfo]', '[role=search]',
  '.sidebar', '.navbar', '.nav', '.menu', '.toc', '.table-of-contents',
  '.breadcrumb', '.breadcrumbs', '.pagination', '.pager',
  '.cookie', '.cookies', '.cookie-banner', '.announcement', '.banner',
  '.edit-this-page', '.theme-doc-toc', '.theme-doc-footer', '.pagination-nav',
  '.skip-link', '.skip-to-content',
  // heading permalink anchors (Docusaurus/VitePress/MkDocs/devsite/…)
  '.header-anchor', '.headerlink', 'a.anchor', '[aria-label*=permalink i]', '[aria-label*=Permalink]',
  // common per-page action chrome
  '.edit-page', '.edit-link', '.feedback', '.devsite-page-rating', '.page-actions',
  '[aria-label*="Copy" i][role=button]',
  // advertisements (carbon ads etc.) — never content
  '#carbonads', '.carbonads', '[class*=carbonads]', '[class*=carbon-ads]',
  '.advertisement', '.ad-container', '.ad-banner', '[data-ad]', '[id*=carbonads]',
];

// Candidate containers for "the main content", best-first, used when no
// framework-specific selector is supplied.
const MAIN_CANDIDATES = [
  'main article', 'article', 'main', '[role=main]',
  '.markdown', '.markdown-body', '.content', '.main-content', '.doc-content',
  '#content', '#main', '.post', '.entry-content',
];

function buildTurndown() {
  const td = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
    bulletListMarker: '-',
    emDelimiter: '_',
    hr: '---',
    linkStyle: 'inlined',
  });
  td.use(gfm);

  // Fenced code blocks that keep the language hint (language-js, lang-js,
  // hljs language-js, highlight-source-js, ...).
  td.addRule('fencedCodeWithLang', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const codeEl =
        (node.querySelector && node.querySelector('code')) || node;
      const cls =
        (codeEl.getAttribute && codeEl.getAttribute('class')) ||
        (node.getAttribute && node.getAttribute('class')) ||
        '';
      const lang = (cls.match(/(?:language|lang|highlight|brush|source)[-:](\w+)/i) || [])[1] || '';
      const text = (codeEl.textContent || node.textContent || '').replace(/\n$/, '');
      const fence = '```';
      return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });

  return td;
}

function textOf(node) {
  return (node && node.text ? node.text : '').replace(/\s+/g, ' ').trim();
}

/** Rewrite relative href/src to absolute so links survive extraction. */
function absolutize(root, baseUrl) {
  if (!baseUrl) return;
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      a.setAttribute('href', new URL(href, baseUrl).toString());
    } catch {
      /* leave as-is */
    }
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) continue;
    try {
      img.setAttribute('src', new URL(src, baseUrl).toString());
    } catch {
      /* leave as-is */
    }
  }
}

/** Pick the densest plausible main-content node. */
function pickMainContent(root, contentSelector) {
  const selectors = [].concat(contentSelector || []).filter(Boolean);
  for (const sel of selectors) {
    const node = root.querySelector(sel);
    if (node && textOf(node).length > 40) return node;
  }
  let best = null;
  let bestLen = 0;
  for (const sel of MAIN_CANDIDATES) {
    const node = root.querySelector(sel);
    if (!node) continue;
    const len = textOf(node).length;
    if (len > bestLen) {
      best = node;
      bestLen = len;
    }
  }
  return best || root.querySelector('body') || root;
}

// Tokens that occur ONLY inside (often URL-encoded) inline-SVG markup and never
// in real prose. When a data-URI SVG image breaks attribute parsing, its body
// spills into the text as garbage blocks; this lets us drop those blocks even
// when the <img> removal above can't catch the mis-parsed remnant.
const SVG_NOISE_RE =
  /data:image\/svg|%3c\/?svg|%3csvg|feGaussianBlur|feFlood|feBlend|fegaussianblur|linearGradient|radialGradient|gradientUnits|stdDeviation|BackgroundImageFix|foregroundBlur|interpolation-filters|userSpaceOnUse/i;

/** Drop paragraph blocks that are inline-SVG / data-URI image noise. */
export function stripSvgNoise(markdown) {
  return String(markdown || '')
    .split(/\n{2,}/)
    .filter((block) => !SVG_NOISE_RE.test(block))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- #8: Trafilatura-style universal cleanup -------------------------------
// CHROME_SELECTORS above is robust but can miss IN-CONTENT navigation on unusual
// layouts (an unclassed <ul> of links, a link grid) — leaving nav boilerplate in the
// output. LINK DENSITY is the universal signal Trafilatura uses: a container that is
// almost entirely anchors, with little text of its own, is navigation — droppable
// without naming a class. It is paired with a CASCADE (Barbaresi; SIGIR-2023): keep the
// pruned "precise" extraction ONLY when it preserved the page's non-link text, else fall
// back to the un-pruned one — so pruning can NEVER lose real content (project rule #1).

/** Length of a page's NON-LINK, NON-IMAGE word text — the "content" a cascade must not
 *  lose. Link text and URLs are excluded ON PURPOSE: removing navigation (which is all
 *  links) must not look like content loss, while removing prose/code must. */
export function contentWordLen(markdown) {
  return String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, ' ') // links: drop BOTH visible text and url
    .replace(/<https?:\/\/[^>\s]+>/gi, ' ') // autolinks
    .replace(/[#>|`*_~+\-]/g, ' ') // markdown structural punctuation
    .replace(/\s+/g, ' ')
    .trim().length;
}

/** Remove clearly-navigational, link-dense containers from within the content node.
 *  Universal (a ratio, never a class name) and bounded (only containers that are almost
 *  all links with little text of their own). Mutates `content`; returns the count removed. */
function pruneNavByLinkDensity(content) {
  const MIN_LINKS = 4; // a couple of links is prose; navigation has many
  const DENSITY = 0.8; // ≥80% of the text is anchor text → navigation
  const MAX_NONLINK_CHARS = 200; // and little text of its own (bullets / separators)
  const matches = [];
  for (const el of content.querySelectorAll('ul, ol, nav, div, section')) {
    const anchors = el.querySelectorAll('a');
    if (anchors.length < MIN_LINKS) continue;
    const total = textOf(el).length;
    if (!total) continue;
    let linkLen = 0;
    for (const a of anchors) linkLen += textOf(a).length;
    if (linkLen / total >= DENSITY && total - linkLen <= MAX_NONLINK_CHARS) matches.push(el);
  }
  const set = new Set(matches);
  let removed = 0;
  for (const el of matches) {
    // Remove only the OUTERMOST match (skip one nested inside another slated node) so we
    // never touch an already-detached child.
    let p = el.parentNode;
    let nested = false;
    while (p && p !== content) {
      if (set.has(p)) {
        nested = true;
        break;
      }
      p = p.parentNode;
    }
    if (nested) continue;
    try {
      el.remove();
      removed++;
    } catch {
      /* already detached */
    }
  }
  return removed;
}

// Doc-toolbar chrome that frameworks render INSIDE the article (so the DOM chrome pass
// misses it): "Edit this page", "Copy Page as Markdown", feedback widgets, etc.
// Stripped generically by phrase, as links or standalone lines.
const TOOLBAR =
  '(?:edit (?:this )?page|edit (?:on|in) github|edit source|copy (?:page|markdown)(?: as markdown)?|copy as markdown|view source|view (?:page )?source|open in [^\\]\\n]{0,30}|report (?:an? )?(?:issue|problem|bug)|give feedback|send feedback|provide feedback|was this (?:page )?helpful[^\\n]*)';

/** Turndown a prepared content node and run the deterministic Markdown cleanups. */
function renderMarkdown(content) {
  const td = buildTurndown();
  let markdown = '';
  try {
    markdown = td.turndown(content.innerHTML || '');
  } catch {
    markdown = textOf(content);
  }
  markdown = markdown
    // permalink/anchor links whose visible text is just '#', '¶', or empty
    .replace(/\[\s*[#¶]?\s*\]\([^)]*\)/g, '')
    // sponsor/ad links rendered inline ("ads via …", "sponsored by …")
    .replace(/\[\s*(?:ads?\s+via|sponsored\b|advertisement)[^\]]*\]\([^)]*\)/gi, '')
    // toolbar actions rendered as links (text may span lines)
    .replace(new RegExp('\\[\\s*' + TOOLBAR + '\\s*\\]\\([^)]*\\)', 'gi'), '')
    // toolbar actions rendered as plain standalone lines
    .replace(new RegExp('^[ \\t]*' + TOOLBAR + '[ \\t]*$', 'gim'), '')
    // orphan link-close artifacts from broken next/prev nav-card markup: a line
    // that is only `](url)` with no opening bracket.
    .replace(/^[ \t]*\]\([^)]*\)[ \t]*$/gm, '')
    // trailing "next/prev page" footer navigation block (kept conservative to
    // clearly-navigational lead-ins so real "next steps" content is not cut).
    .replace(/\n#{1,6}[ \t]*(?:ready for more|continue your learning|keep reading)\b[\s\S]*$/i, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Final safety net: remove any inline-SVG/data-URI image noise that leaked as text
  // (broken data-URI attributes spill their SVG body into the document).
  return stripSvgNoise(markdown);
}

/**
 * Convert an HTML document to `{ title, markdown }`.
 * @param {string} html
 * @param {object} opts
 * @param {string|string[]} [opts.contentSelector] framework-specific container(s)
 * @param {string} [opts.baseUrl] for absolutising links
 * @param {string} [opts.title] override the derived title
 */
export function extractMarkdown(html, { contentSelector, baseUrl, title } = {}) {
  if (!html || typeof html !== 'string') return { title: title || '', markdown: '' };

  const root = parse(html, {
    comment: false,
    blockTextElements: { script: false, style: false, noscript: false },
  });

  // The reveal marks non-visible elements (hidden modals, off-state placeholders,
  // on-screen keyboards) with data-sagecrawl-hidden so the serialized HTML doesn't
  // leak them into the output. Drop them before anything else inspects the DOM, so
  // even the main-content picker never lands on a hidden panel. No-op for the
  // static path (no markers present).
  for (const n of root.querySelectorAll('[data-sagecrawl-hidden]')) n.remove();

  const docTitle =
    title ||
    textOf(root.querySelector('h1')) ||
    textOf(root.querySelector('title')) ||
    '';

  absolutize(root, baseUrl);

  const content = pickMainContent(root, contentSelector);

  // Strip chrome from inside the chosen node.
  for (const sel of CHROME_SELECTORS) {
    for (const n of content.querySelectorAll(sel)) n.remove();
  }

  // Drop data-URI / inline-SVG images. Sites embed decorative gradients, blurs
  // and icons as <img src="data:image/svg+xml,…">; they carry no extractable
  // text and the raw SVG markup (quotes/parens/newlines) shatters into garbage
  // Markdown. Real-URL images (http/https) are kept so they can still be
  // extracted, separated, or excluded by task.
  for (const img of content.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const srcset = img.getAttribute('srcset') || '';
    if (/^\s*data:/i.test(src) || /data:image/i.test(srcset)) img.remove();
  }
  // Inline <svg> nodes are removed by CHROME_SELECTORS above, but defensively
  // drop any that slipped through (e.g. namespaced) so their markup never leaks.
  for (const n of content.querySelectorAll('svg')) n.remove();

  // #8 — extract PRECISELY (prune link-dense in-content navigation), but CASCADE: keep
  // the pruned result only when it preserved the page's non-link content; otherwise fall
  // back to the un-pruned extraction. So navigation boilerplate is trimmed without ever
  // losing real prose/code. `full` is computed BEFORE pruning (it is the safe fallback).
  const full = renderMarkdown(content);
  let markdown = full;
  if (pruneNavByLinkDensity(content) > 0) {
    const pruned = renderMarkdown(content);
    // Accept the trim only if it kept ≥98% of the non-link word content — i.e. it
    // removed navigation, not content. This is the "precise → permissive" fallback.
    if (contentWordLen(pruned) >= contentWordLen(full) * 0.98) markdown = pruned;
  }

  return { title: docTitle.trim(), markdown };
}

/**
 * Split Markdown into structural blocks (paragraphs, headings, list chunks,
 * tables, fenced code) without breaking fenced code blocks. Used for
 * cross-state de-duplication.
 */
export function splitBlocks(markdown) {
  const lines = (markdown || '').split('\n');
  const blocks = [];
  let buf = [];
  let inFence = false;
  let fence = '';

  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) blocks.push(t);
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (!inFence) {
        flush();
        inFence = true;
        fence = m[1];
        buf.push(line);
      } else if (line.trim().startsWith(fence)) {
        buf.push(line);
        inFence = false;
        flush();
      } else {
        buf.push(line);
      }
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    if (line.trim() === '') flush();
    else buf.push(line);
  }
  flush();
  return blocks;
}

/**
 * Classify a Markdown block by structural TYPE and image-ness. Pure/deterministic
 * so the layout router (and the block-metadata spine) agree on what a block is.
 * `text` here is the paragraph type (kept for back-compat with existing routing).
 */
export function classifyBlock(text) {
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

/** Heading depth of a block (# = 1 … ###### = 6), or 0 if it is not a heading. */
function headingLevel(text) {
  const m = String(text || '').match(/^(#{1,6})\s/);
  return m ? m[1].length : 0;
}

/**
 * Enrich raw blocks (`{ text, provenance? }` or bare strings) with the structural
 * metadata every AI layer addresses blocks by:
 *   - `type` / `hasImage` — what the block is.
 *   - `sectionPath` — the heading ancestry the block falls UNDER (its parent
 *     headings, not itself), so a rule like "everything under Privacy Policy" or
 *     "only the white pizzas" is a metadata match, not a per-case rule.
 *   - `ord` — document-order index within the page (for ordinal tasks / stable sort).
 *   - `provenance` — which interaction surfaced the block (`baseline`, `tab:…`,
 *     `expander:…`, `dropdown:…`, `loadmore`), so "the dropdown results" is routable.
 * This is the spine that lets layout stay one general AI-judged mechanism.
 */
export function enrichBlocks(rawBlocks) {
  const stack = []; // active heading ancestry: { level, title }
  return (rawBlocks || []).map((b, ord) => {
    const text = typeof b === 'string' ? b : b.text;
    const provenance = (b && typeof b === 'object' && b.provenance) || 'baseline';
    const { type, hasImage } = classifyBlock(text);
    const lvl = headingLevel(text);
    let sectionPath;
    if (lvl) {
      while (stack.length && stack[stack.length - 1].level >= lvl) stack.pop();
      sectionPath = stack.map((s) => s.title);
      stack.push({ level: lvl, title: text.replace(/^#{1,6}\s*/, '').trim().slice(0, 80) });
    } else {
      sectionPath = stack.map((s) => s.title);
    }
    return { text, type, hasImage, provenance, sectionPath, ord };
  });
}

/**
 * Remove every image from Markdown — verbatim-safe (it drops a media element, it
 * never rewrites prose). Covers inline `![alt](src)`, reference `![alt][id]`,
 * images wrapped in a link `[![alt](src)](href)`, and any raw `<img>` that
 * survived conversion. Honors a task like "don't include images".
 */
export function stripImages(markdown) {
  return String(markdown || '')
    // linked image: [![alt](src)](href) — drop the whole thing
    .replace(/\[\s*!\[[^\]]*\]\([^)]*\)\s*\]\([^)]*\)/g, '')
    // inline image: ![alt](src "title")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // reference image: ![alt][id]
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
    // raw <img …> tags that slipped through conversion
    .replace(/<img\b[^>]*>/gi, '')
    // tidy up artifacts left behind (trailing spaces, blank pile-ups)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove hyperlinks but KEEP their visible text — `[text](url)` -> `text`,
 * `<https://…>` -> dropped. Verbatim-safe for the words; only the link target is
 * dropped. Honors a task like "strip the links". Run AFTER stripImages so an
 * image's leftover does not get mistaken for link text.
 */
export function stripLinks(markdown) {
  return String(markdown || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/gi, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Apply the task's faithful element exclusions to a Markdown string. A no-op when
 * nothing is excluded, so callers can invoke it unconditionally.
 * @param {string} markdown
 * @param {{ images?: boolean, links?: boolean }} [exclude]
 */
export function applyExclusions(markdown, exclude = {}) {
  let md = String(markdown || '');
  if (exclude.images) md = stripImages(md);
  if (exclude.links) md = stripLinks(md);
  return md;
}

const normalizeBlock = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Accumulates unique content blocks seen across many page states (e.g. each tab
 * of a tab group, each expanded accordion). Shared content is de-duplicated;
 * first-seen order is preserved. Blocks revealed by a labelled control (a tab
 * variant) carry that label so provenance survives into the output.
 */
export class BlockAccumulator {
  constructor() {
    this.seen = new Set();
    this.blocks = []; // { text, label, provenance }
  }

  /**
   * Append the *new* blocks of `markdown` in capture order. Append-only is
   * deliberate: revealed states (framework tabs like Vite/Nuxt/Laravel/…) are
   * mutually exclusive and never coexist in one capture, so we cannot infer
   * their document position — capture order (= the reveal's DOM click order)
   * keeps them in natural reading order. Returns the count of new blocks.
   *
   * `label` is the TAB-variant marker used by toMarkdown (unchanged behaviour).
   * `provenance` is the richer reveal source carried to the layout router
   * (`baseline` / `tab:…` / `expander:…` / `dropdown:…` / `loadmore`).
   */
  add(markdown, { label, provenance } = {}) {
    let added = 0;
    for (const text of splitBlocks(markdown)) {
      const key = createHash('sha1').update(normalizeBlock(text)).digest('hex');
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.blocks.push({ text, label: label || null, provenance: provenance || 'baseline' });
      added++;
    }
    return added;
  }

  size() {
    return this.blocks.length;
  }

  /** Raw blocks (`{ text, provenance }`) in capture order for the layout router. */
  toBlocks() {
    return this.blocks.map((b) => ({ text: b.text, provenance: b.provenance || 'baseline' }));
  }

  toMarkdown() {
    const out = [];
    let lastLabel = null;
    for (const blk of this.blocks) {
      if (blk.label && blk.label !== lastLabel) out.push(`<!-- variant: ${blk.label} -->`);
      if (!blk.label) lastLabel = null;
      else lastLabel = blk.label;
      out.push(blk.text);
    }
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}
