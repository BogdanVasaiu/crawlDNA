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

  const td = buildTurndown();
  let markdown = '';
  try {
    markdown = td.turndown(content.innerHTML || '');
  } catch {
    markdown = textOf(content);
  }
  // Doc-toolbar chrome that frameworks render INSIDE the article (so the DOM
  // chrome pass misses it): "Edit this page", "Copy Page as Markdown", feedback
  // widgets, etc. Stripped generically by phrase, as links or standalone lines.
  const TOOLBAR =
    '(?:edit (?:this )?page|edit (?:on|in) github|edit source|copy (?:page|markdown)(?: as markdown)?|copy as markdown|view source|view (?:page )?source|open in [^\\]\\n]{0,30}|report (?:an? )?(?:issue|problem|bug)|give feedback|send feedback|provide feedback|was this (?:page )?helpful[^\\n]*)';

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

  // Final safety net: remove any inline-SVG/data-URI image noise that leaked as
  // text (broken data-URI attributes spill their SVG body into the document).
  markdown = stripSvgNoise(markdown);

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
    this.blocks = []; // { text, label }
  }

  /**
   * Append the *new* blocks of `markdown` in capture order. Append-only is
   * deliberate: revealed states (framework tabs like Vite/Nuxt/Laravel/…) are
   * mutually exclusive and never coexist in one capture, so we cannot infer
   * their document position — capture order (= the reveal's DOM click order)
   * keeps them in natural reading order. Returns the count of new blocks.
   */
  add(markdown, { label } = {}) {
    let added = 0;
    for (const text of splitBlocks(markdown)) {
      const key = createHash('sha1').update(normalizeBlock(text)).digest('hex');
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.blocks.push({ text, label: label || null });
      added++;
    }
    return added;
  }

  size() {
    return this.blocks.length;
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
