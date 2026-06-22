// The AI judgment layer. Two jobs, both kept verbatim-safe:
//   - aiScopeContent: keep only the sections relevant to the task (e.g. drop a
//     marketing/landing/footer section when the task is "documentation"; keep
//     only the menu when the task is "the pizza menu"). Output is the ORIGINAL
//     text of the kept sections — the model never rewrites content.
//   - aiSelectLinks: pick which discovered links lead to more task-relevant
//     pages. Falls back to a deterministic scope heuristic on any failure.
//
// Both bias toward completeness: when the model is unsure or errors, keep.

import ollama, { Ollama } from 'ollama';

// Reuse one client per host so a custom Ollama host (chosen in the UI) is
// honoured without reconnecting on every call. No host → the package default
// (127.0.0.1:11434).
const _clients = new Map();
function clientFor(host) {
  if (!host) return ollama;
  let c = _clients.get(host);
  if (!c) {
    c = new Ollama({ host });
    _clients.set(host, c);
  }
  return c;
}

async function chat(model, system, user, host) {
  const res = await clientFor(host).chat({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    options: { temperature: 0 },
  });
  return res?.message?.content || '';
}

/** Pull the first JSON value out of a model reply. */
function parseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const m = body.match(/[[{][\s\S]*[\]}]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Split markdown into heading-delimited sections (verbatim text preserved). */
function sectionize(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let cur = { heading: '(intro)', lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      if (cur.lines.length || sections.length === 0) sections.push(cur);
      cur = { heading: h[2].trim().slice(0, 100), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);
  return sections.map((s, i) => ({ index: i, heading: s.heading, text: s.lines.join('\n').trim() }));
}

/**
 * Interpret the natural-language task into explicit, faithful OUTPUT DIRECTIVES
 * the rest of the pipeline can enforce deterministically. Today this covers the
 * element-type EXCLUSIONS a user can state in plain English ("don't include
 * images", "strip the links"): removing a whole media/link element is
 * verbatim-safe — it drops an element, it never rewrites prose — unlike content
 * scoping, which is judged per-section in aiScopeContent and cannot reach an
 * image embedded inside an otherwise-relevant section.
 *
 * The AI is the primary interpreter (no per-site assumptions about meaning); a
 * narrow deterministic backstop guarantees the most common, unambiguous
 * phrasings are honoured even when the model is unavailable or hedges — the user
 * ranks precision (actually honouring the instruction) above everything. The
 * backstop is NOT a content value-filter or a URL-shape rule (those stay fully
 * AI-judged); it only recognises an explicit "no <images|links>" request.
 *
 * It also detects an opt-in output TRANSFORM: a shape the task explicitly asks
 * the content to be presented in ("as a table", "as a list", "as JSON"). This is
 * the ONE place the verbatim rule is relaxed, and only on explicit request —
 * default is null (verbatim). The reshape itself (aiReformat) stays grounded:
 * it reshapes only the provided content and never invents or drops values.
 *
 * NOTE: how content is GROUPED INTO FILES (separate files, images vs text,
 * "images with their captions", per-page, by category, …) is NOT handled here —
 * that is the job of the general layout router (`aiLayoutScheme` decides the file
 * plan, `aiRouteBlocks` routes each page's blocks into it; driven by `planFiles`
 * in layout.mjs). Keeping that out of here is deliberate: file layout is
 * open-ended ("the task may be infinite"), so it must be judged against the
 * content, not pre-enumerated into fixed directive types.
 *
 * @returns {Promise<{ exclude: { images: boolean, links: boolean }, transform: null | { shape: string } }>}
 */
export async function aiInterpretTask({ model, task, host }) {
  const directives = { exclude: { images: false, links: false }, transform: null };
  const t = (task || '').trim();
  if (!t) return directives;

  const ans = await chat(
    model,
    'You convert a web-extraction task into a tiny JSON of explicit output ' +
      'directives. Report ONLY what the user EXPLICITLY asks for.\n' +
      '- exclude.images=true ONLY when the task asks to leave images OUT entirely ' +
      '(e.g. "no images", "without images", "remove/omit/exclude images", ' +
      '"don\'t include images"). Covers images/pictures/photos/figures/screenshots/' +
      'icons/logos. NOTE: asking to put images in a SEPARATE FILE is NOT an ' +
      'exclusion (the images are kept) — leave this false for that.\n' +
      '- exclude.links=true ONLY when the task asks to leave hyperlinks/URLs OUT ' +
      'entirely.\n' +
      '- transform: set {"shape":"..."} ONLY when the task explicitly asks to ' +
      'PRESENT the content in a specific structure/format (e.g. "as a table", ' +
      '"in a table", "as a list", "as bullet points", "as JSON"); put a short ' +
      'description of that shape in "shape". Otherwise transform=null.\n' +
      'Never infer from the topic alone — "extract the images" or "get the links" ' +
      'are NOT exclusions, and tabular-looking data is NOT a transform unless ' +
      'explicitly requested. Answer with JSON only.',
    `Task: "${t}"\n\nReply with {"exclude":{"images":bool,"links":bool},"transform":null|{"shape":"..."}}.`,
    host,
  ).catch(() => '');
  const j = parseJson(ans);
  const aiImg = !!(j && j.exclude && j.exclude.images === true);
  const aiLink = !!(j && j.exclude && j.exclude.links === true);
  if (j && j.transform && typeof j.transform === 'object' && typeof j.transform.shape === 'string' && j.transform.shape.trim()) {
    directives.transform = { shape: j.transform.shape.trim().slice(0, 120) };
  }

  // Deterministic exclusion signal: an exclusion VERB closely followed by the
  // media/link noun. Conservative (the negation is required) so "extract the
  // images" never matches.
  const excludeNear = (noun) =>
    new RegExp(
      "(?:\\bno\\b|without|exclude|exclud\\w*|omit\\w*|skip\\w*|drop\\w*|remove\\w*|" +
        "strip\\w*|ignore\\w*|leave out|leaving out|don'?t (?:include|want)|" +
        "do not (?:include|want))[^.\\n]{0,30}?\\b(?:" + noun + ")\\b",
      'i',
    );
  const imgVerb = excludeNear('images?|imgs?|pictures?|photos?|photographs?|figures?|screenshots?|graphics?|illustrations?|icons?|logos?').test(t);
  const linkVerb = excludeNear('links?|hyperlinks?|urls?|hrefs?|anchors?').test(t);

  // Excluding loses content, so bias toward KEEPING (the user ranks completeness
  // above all): an explicit exclusion verb always wins, but a bare AI "exclude"
  // is trusted only when the task is NOT clearly doing file layout. Layout cues
  // ("separate", "own file", "in X.md", "with their …") mean the content is being
  // FILED, not removed — the general router handles those, not exclusion.
  const layoutCue = /\bseparat\w*\b|\bown file\b|\b(?:its|their)\s+own\b|\bwith (?:their|its)\b|\bgroup\b|\.md\b/i.test(t);
  directives.exclude.images = imgVerb || (aiImg && !layoutCue);
  directives.exclude.links = linkVerb || (aiLink && !layoutCue);

  // Sanity gate: never exclude something the task never named. The model can
  // hallucinate an exclusion for a noun absent from the task (e.g. flag links on
  // an images-only request); requiring an explicit mention contains that.
  const mentions = (noun) => new RegExp('\\b(?:' + noun + ')\\b', 'i').test(t);
  if (!mentions('images?|imgs?|pictures?|photos?|photographs?|figures?|screenshots?|graphics?|illustrations?|icons?|logos?|visuals?|media'))
    directives.exclude.images = false;
  if (!mentions('links?|hyperlinks?|urls?|hrefs?|anchors?')) directives.exclude.links = false;

  return directives;
}

/**
 * Reshape already-extracted content into the task's requested output shape (from
 * aiInterpretTask's transform). GROUNDED and self-targeting: it uses only the
 * given content (never invents/drops a value, keeps every number/string exact),
 * and leaves content that does not fit the shape unchanged — so a "prices as a
 * table" task tables the price data and passes prose through verbatim. On any
 * failure or empty reply it returns the input unchanged (no data loss).
 *
 * @param {object} a
 * @param {string} a.shape   e.g. "a Markdown table", "a bulleted list"
 * @param {string} a.markdown content to reshape
 * @returns {Promise<string>}
 */
export async function aiReformat({ model, task, shape, markdown, host }) {
  const src = String(markdown || '');
  if (!src.trim() || !shape) return src;

  const ans = await chat(
    model,
    'You reformat ALREADY-EXTRACTED web content into a requested output shape for a ' +
      'user task. Apply the shape ONLY to content that genuinely fits it (repeated ' +
      'records with consistent fields → a Markdown table; a set of items → a list). ' +
      'If a piece of content does not fit the requested shape (narrative prose, ' +
      'headings, unrelated sections), leave THAT content unchanged. ' +
      'STRICT FAITHFULNESS: use ONLY the provided content — never invent, add, infer, ' +
      'or omit any value; keep every name, number, price and string EXACTLY as ' +
      'written (reordering rows to fill a table is allowed; changing values is NOT). ' +
      'Output ONLY the resulting Markdown — no preamble, no explanation, and do not ' +
      'wrap the whole answer in a code fence.',
    `Task: "${task}"\nRequested output shape: ${shape}\n\nContent:\n\n${src}`,
    host,
  ).catch(() => '');

  let out = (ans || '').trim();
  // Unwrap an accidental whole-output code fence (```markdown … ```).
  const fence = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) out = fence[1].trim();
  return out || src;
}

/**
 * Keep only task-relevant sections, verbatim.
 * @returns {Promise<{ markdown: string, relevant: boolean }>}
 */
export async function aiScopeContent({ model, task, title, markdown, host }) {
  if (!markdown || markdown.length < 1200) return { markdown, relevant: !!markdown };

  const sections = sectionize(markdown);
  if (sections.length <= 1) {
    // Single blob: ask only whether it is relevant at all.
    const ans = await chat(
      model,
      'You decide whether a web page is relevant to a user extraction task. Answer with JSON only.',
      `Task: "${task}"\nPage title: ${title || ''}\n\nContent (truncated):\n${markdown.slice(0, 2500)}\n\n` +
        'Reply with {"relevant": true|false}. Relevant means the page contains content the task asks for.',
      host,
    ).catch(() => '');
    const j = parseJson(ans);
    if (j && j.relevant === false) return { markdown: '', relevant: false };
    return { markdown, relevant: true };
  }

  const outline = sections
    .map((s) => `${s.index}: ${s.heading} — ${s.text.replace(/\s+/g, ' ').slice(0, 140)}`)
    .join('\n');

  const ans = await chat(
    model,
    'You select which sections of a page belong to a user extraction task. ' +
      'Keep every section that contains task-relevant content. Drop only clearly-irrelevant ' +
      'sections such as site navigation, footers, cookie/consent notices, marketing call-to-action, ' +
      'newsletter signups, "related/recommended" widgets, comments, or unrelated topics. ' +
      'When unsure, KEEP. Answer with JSON only.',
    `Task: "${task}"\nPage title: ${title || ''}\n\nSections (index: heading — preview):\n${outline}\n\n` +
      'Reply with {"keep": [list of section indexes to keep]}.',
    host,
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j || !Array.isArray(j.keep)) return { markdown, relevant: true };

  const keep = new Set(j.keep.map(Number).filter((n) => Number.isInteger(n)));
  if (keep.size === 0) return { markdown, relevant: true }; // keep-bias on empty
  const kept = sections.filter((s) => keep.has(s.index)).map((s) => s.text).filter(Boolean);
  const out = kept.join('\n\n').trim();
  return { markdown: out || markdown, relevant: out.length > 0 };
}

/**
 * Choose which links to follow for the task.
 * @param {object} a
 * @param {Array<{href,label}>} a.links  in-scope candidates
 * @returns {Promise<string[]>} hrefs to enqueue
 */
export async function aiSelectLinks({ model, task, links, host }) {
  const capped = links.slice(0, 160);
  if (capped.length === 0) return [];

  const list = capped.map((l, i) => `${i}: ${l.label ? l.label.slice(0, 60) + ' — ' : ''}${l.href}`).join('\n');
  const ans = await chat(
    model,
    'You decide which links to follow while crawling to fulfil an extraction task. ' +
      'You are given raw destinations exactly as they appear on the page — the crawler makes NO ' +
      'assumptions about their shape, so YOU must recognise what is a real, separate page. A real ' +
      'page can be a normal URL, a single-page-app route carried in the URL fragment ' +
      '(e.g. #/contact, #!/features, #/products/42) or in the query string (e.g. ?view=pricing, ' +
      '?page=2), or any other site-specific routing/pagination scheme. Treat all of these as real ' +
      'pages. Do NOT follow: same-page anchors that merely jump within the CURRENT page ' +
      '(e.g. #overview, #section-3, #top — a fragment with no route-like path), links that clearly ' +
      'reload the current page, mailto/tel, or external sites. ' +
      'Among real pages, follow a link ONLY if its destination is the SAME KIND of content the task ' +
      'asks for. For a documentation task the right kind is reference / guide / tutorial / API / ' +
      'concept / configuration (incl. release notes / changelog); avoid blog/news, marketing/landing, ' +
      'pricing, about/team/careers, community/showcase, login/signup, legal. For any other task ' +
      '(a menu, prices, contact info, products, …) apply the same principle for that category. ' +
      'When unsure whether something is on-task, prefer to follow (completeness matters more than speed). ' +
      'Judge by the label and the whole destination string. Answer with JSON only.',
    `Task: "${task}"\n\nDestinations (index: label — href):\n${list}\n\n` +
      'Reply with {"follow": [indexes to follow]}. Include every real, on-task page; exclude same-page anchors and off-task links.',
    host,
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j || !Array.isArray(j.follow)) return capped.map((l) => l.href); // follow all in-scope on failure
  const idx = new Set(j.follow.map(Number).filter((n) => Number.isInteger(n)));
  const chosen = capped.filter((_, i) => idx.has(i)).map((l) => l.href);
  return chosen.length ? chosen : capped.map((l) => l.href);
}

/**
 * Decide which interactive controls on a page actually HIDE content worth
 * revealing — the AI-driven core of discovery. The model reads each candidate
 * (label, kind, class, nearby heading) like a human and judges whether clicking
 * it would surface currently-hidden readable content (tabs, accordions, "show
 * more", variant switches), versus controls that reveal nothing (copy/share,
 * theme toggles, live-demo widgets, plain navigation). This is what lets the
 * crawler find content in non-obvious places on ANY site without per-site rules.
 *
 * Completeness-biased: "when unsure, include". Returns a Set of the chosen
 * candidates' `signature`s, or null on parse failure so the caller can fall back
 * to the deterministic heuristic (no missed content if the model is down).
 *
 * @param {object} a
 * @param {Array<{signature:string, kind:string, label:string, cls?:string, context?:string}>} a.candidates
 * @returns {Promise<Set<string>|null>}
 */
export async function aiSelectRevealers({ model, task, candidates, host }) {
  const list = (candidates || []).slice(0, 150);
  if (list.length === 0) return new Set();

  const lines = list
    .map(
      (c, i) =>
        `${i}: [${c.kind || 'control'}] "${(c.label || '(no label)').slice(0, 80)}"` +
        (c.cls ? ` .${c.cls}` : '') +
        (c.context ? ` — under "${c.context}"` : ''),
    )
    .join('\n');

  const ans = await chat(
    model,
    'You are reading a web page like a human in order to extract ALL of its content, ' +
      'including content that stays hidden until you interact. You are given the ' +
      'interactive controls found in the main content area. Decide which ones, WHEN ' +
      'CLICKED, would reveal additional readable content that is currently hidden — ' +
      'e.g. tabs that swap in different text/code, accordions and expanders, ' +
      '"show more"/"read more"/"load more"/"see details", version or platform or ' +
      'variant switchers. Do NOT pick controls that reveal no new text: ' +
      'copy/share/print buttons, theme or dark-mode toggles, pure interactive demos ' +
      'or playgrounds (date pickers, sliders, colour pickers, steppers, rating stars, ' +
      'carousels of the same widget), cookie notices, or plain links/navigation. ' +
      'When you are unsure whether a control reveals hidden content, INCLUDE it — ' +
      'missing content is far worse than one wasted click. Answer with JSON only.',
    `Task (for context only — reveal everything regardless): "${task || ''}"\n\n` +
      `Controls (index: [kind] "label" .class — context):\n${lines}\n\n` +
      'Reply with {"click":[indexes of controls that reveal hidden content]}.',
    host,
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j || !Array.isArray(j.click)) return null; // signal: use the fallback
  const keep = new Set(j.click.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < list.length));
  return new Set([...keep].map((i) => list[i].signature));
}

/**
 * STEP 1 of the general layout — decide the output FILE PLAN from the task alone
 * (no content), so it stays small and reliable no matter how big the crawl is.
 * Returns one of:
 *   - { single: true }                 — everything in one file (the default)
 *   - { perPage: true }                — one file per crawled page
 *   - { files: [{ filename, role, rule }] } — a named file plan, where role is:
 *       "match"      → holds specific content described by `rule`
 *       "all"        → holds EVERYTHING (every block), e.g. "the rest in ext.md
 *                      but it will include the images anyway" → ext.md is "all"
 *       "complement" → holds "the rest" = everything NOT claimed by match files
 *
 * Splitting the decision this way is what makes layout scale: "all"/"complement"
 * files are filled deterministically by the caller (never dropped), and only the
 * "match" files need per-page AI routing (aiRouteBlocks).
 */
export async function aiLayoutScheme({ model, task, host }) {
  const t = (task || '').trim();
  if (!t) return { single: true };

  const ans = await chat(
    model,
    'You plan the OUTPUT FILES for a web-extraction task — the file PLAN only, not ' +
      'the content. Reply with ONE of:\n' +
      '- {"single": true} — everything in ONE file. This is the DEFAULT; use it unless ' +
      'the task clearly asks to split/separate content into more than one file.\n' +
      '- {"perPage": true} — one file per crawled page ("by pages", "per page", "each ' +
      'page separately").\n' +
      '- {"files":[{"filename":"name.md","role":"match|all|complement","rule":"..."}]} ' +
      'when the task asks for specific files. For each file:\n' +
      '   role "match" — it holds specific content described by "rule" (e.g. "images ' +
      'together with their titles and descriptions", "the drinks", "the FAQ").\n' +
      '   role "all" — it holds EVERYTHING, every block, the full content. Use this ' +
      'when a file should contain all the content INCLUDING things also placed in ' +
      'another file (e.g. "the rest in ext.md but it will include the images anyway", ' +
      '"a full copy in all.md").\n' +
      '   role "complement" — it holds "the rest" = everything NOT placed in the ' +
      '"match" files. Use this ONLY when the remaining file should EXCLUDE what the ' +
      'match files took (e.g. "the FAQ in faq.md and everything else in other.md").\n' +
      'Use the EXACT filenames the task names. Answer with JSON only.',
    `Task: "${t}"\n\nReply with {"single":true} | {"perPage":true} | ` +
      '{"files":[{"filename":"name.md","role":"match|all|complement","rule":"..."}]}.',
    host,
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j) return { single: true };
  if (j.perPage === true) return { perPage: true };
  if (Array.isArray(j.files) && j.files.length) {
    const files = j.files
      .filter((f) => f && typeof f.filename === 'string' && f.filename.trim())
      .map((f) => ({
        filename: f.filename.trim().slice(0, 80),
        role: ['match', 'all', 'complement'].includes(f.role) ? f.role : 'match',
        rule: typeof f.rule === 'string' ? f.rule.slice(0, 200) : '',
      }));
    if (files.length) return { files };
  }
  return { single: true };
}

/**
 * STEP 2 of the general layout — for ONE page, assign its blocks to the "match"
 * files of the plan (per each file's rule). Small prompt (one page at a time) so
 * it stays reliable on large sites. A block may go to several files; blocks that
 * match nothing are simply omitted here (the caller routes them via the
 * all/complement files or an "other" bucket, so nothing is lost).
 *
 * @param {object} a
 * @param {Array<{filename:string, rule:string}>} a.files  the match files
 * @param {Array<{index:number, type:string, hasImage:boolean, preview:string}>} a.blocks
 * @returns {Promise<Record<string, number[]>>}  filename -> block indexes
 */
export async function aiRouteBlocks({ model, task, files, blocks, host }) {
  if (!files || !files.length || !blocks || !blocks.length) return {};

  const fileList = files.map((f) => `- ${f.filename}: ${f.rule || '(matching content)'}`).join('\n');
  const blockList = blocks
    .map((b) => `${b.index}: [${b.type || 'text'}${b.hasImage ? '+img' : ''}] ${(b.preview || '').slice(0, 140)}`)
    .join('\n');

  const ans = await chat(
    model,
    'You assign a page\'s content blocks to output file(s), STRICTLY following each ' +
      'file\'s RULE. You are given the target files (each with a rule) and the page ' +
      'BLOCKS in document order. For EACH file, list the indexes of the blocks that ' +
      'satisfy its rule — include EXACTLY what the rule asks for and NOTHING MORE. A ' +
      'block may go to more than one file.\n' +
      'Guidance for image rules: an image\'s TITLE is the short heading that names it ' +
      '(the image\'s own alt text also serves as its title). So a rule like "images ' +
      'with their titles" means each image block PLUS at most the ONE heading that ' +
      'titles it — do NOT pull in surrounding paragraphs, lists, or whole sections. ' +
      'Include descriptions / body text / captions ONLY when the rule explicitly says ' +
      'so (e.g. "with their descriptions", "with their text"). Use document order to ' +
      'pair an image with its title.\n' +
      'Blocks that satisfy no file\'s rule may be omitted. Answer with JSON only.',
    `Task: "${task}"\n\nFiles:\n${fileList}\n\nBlocks (index: [type] preview):\n${blockList}\n\n` +
      'Reply with {"files":[{"filename":"name.md","items":[indexes]}]}.',
    host,
  ).catch(() => '');

  const j = parseJson(ans);
  const out = {};
  if (j && Array.isArray(j.files)) {
    for (const pf of j.files) {
      if (!pf || typeof pf.filename !== 'string') continue;
      out[pf.filename.trim()] = (Array.isArray(pf.items) ? pf.items : [])
        .map(Number)
        .filter((n) => Number.isInteger(n));
    }
  }
  return out;
}
