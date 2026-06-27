// The AI judgment layer.
//
// PHASE 1 (crawl) — three jobs, all of which keep the captured content VERBATIM:
//   - aiSelectRevealers: which interactive controls actually HIDE content worth
//     revealing (the discovery core — "don't miss anything").
//   - aiScopeContent: keep only the sections relevant to the task (drop the
//     landing/footer/cookie/marketing chrome) — the "stay focused" core. Output
//     is the ORIGINAL text of the kept sections; the model never rewrites content.
//   - aiSelectLinks: which discovered links lead to more task-relevant pages.
// All three bias toward completeness: when the model is unsure or errors, KEEP.
//
// PHASE 2 (reshape) — aiReshape: a separate, AFTER-the-crawl step that reworks the
// already-extracted files on request (a table, a split, a filtered subset), reusing
// the same extraction as context like a knowledge base. Value-faithful: it copies
// every kept value exactly and never invents. This is the ONLY place AI reshapes
// output; the crawl itself stays verbatim.

// All model communication goes through the provider-agnostic transport layer.
// These functions take an `llm` descriptor ({ provider, model, baseUrl, apiKey })
// and never care whether it is backed by Ollama or an OpenAI-compatible API.
import { chat } from '../lib/llm.mjs';

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

// =========================================================================
// PHASE 2 — reshape (the "chat with your extraction" step)
// =========================================================================

/**
 * Parse a reshape reply into `{ reply, files }`. The model emits deliverables as
 * FILE BLOCKS — `===FILE: name.md===` … `===END===` — and anything outside the
 * blocks is the conversational reply. Robust to large content (no JSON escaping)
 * and to an accidental whole-file code fence around a block's body.
 */
function parseReshape(text) {
  const out = { reply: '', files: [] };
  const raw = String(text || '');
  if (!raw.trim()) return out;

  const re = /===FILE:\s*([^\n=]+?)\s*===\r?\n([\s\S]*?)\r?\n===END===/g;
  const replyParts = [];
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    replyParts.push(raw.slice(last, m.index));
    last = re.lastIndex;
    const filename = m[1].trim();
    let content = m[2].replace(/^\s*\n/, '').replace(/\s+$/, '');
    const fence = content.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    if (fence) content = fence[1];
    if (filename && content.trim()) out.files.push({ filename, content });
  }
  replyParts.push(raw.slice(last));
  out.reply = replyParts.join('').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/**
 * Is a chat reply "document-worthy" — i.e. is it itself a deliverable the user
 * would want as a file (a table, several sections, or a long list), rather than a
 * short conversational answer? Models often produce such content inline instead
 * of in a FILE BLOCK; this lets the caller promote it to a saved document so the
 * user always gets a file when the answer is one. Short, unstructured Q&A stays
 * a plain chat message.
 */
function isDocumentWorthy(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const lines = t.split('\n');
  // a Markdown table (a header row followed by a |---|---| separator)
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && /-/.test(lines[i + 1]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) return true;
  }
  const headings = (t.match(/^#{1,6}\s+\S/gm) || []).length;
  const bullets = (t.match(/^\s*([-*+]|\d+\.)\s+\S/gm) || []).length;
  return headings >= 2 || bullets >= 5;
}

/** Derive a readable .md filename for a promoted document (sanitised later). */
function deriveDocName(instruction, reply) {
  const h = String(reply || '').match(/^#{1,6}\s+(.+?)\s*$/m);
  const base = (h ? h[1] : String(instruction || 'answer')).replace(/[*_`#|]/g, '').trim();
  return (base.slice(0, 60) || 'answer') + '.md';
}

/**
 * Rework already-extracted content to fulfil a user request, like answering from a
 * knowledge base built over the whole crawl output. This is Phase 2: it runs on
 * the SAVED files, on demand, as many times as the user wants — the crawl itself
 * (Phase 1) never reshapes. The model MAY filter, reorder, regroup and reformat
 * (e.g. into a Markdown table); it MUST keep every kept value (name/number/price/
 * time/URL/string) EXACTLY as written and never invent or alter one.
 *
 * @param {object} a
 * @param {{provider,model,baseUrl,apiKey}} a.llm
 * @param {string} a.instruction               the user's latest message
 * @param {Array<{role:string, content:string}>} [a.history]  prior turns (this session)
 * @param {string} a.corpus                     the assembled verbatim extraction
 * @returns {Promise<{ reply: string, files: Array<{ filename: string, content: string }> }>}
 */
export async function aiReshape({ llm, instruction, history = [], corpus }) {
  const src = String(corpus || '');
  if (!src.trim()) return { reply: 'There is no extracted content to work from yet.', files: [] };

  const system =
    'You help a user reshape ALREADY-EXTRACTED website content into files, like ' +
    'answering from a knowledge base built from that content. STRICT RULES:\n' +
    '- Use ONLY the provided EXTRACTED CONTENT. Never invent, add, infer or alter a ' +
    'value: keep every name, number, price, time, URL and string EXACTLY as written. ' +
    'You may select, drop, reorder, regroup and reformat (e.g. into a Markdown table).\n' +
    '- When you produce deliverable content, emit it as one or more FILE BLOCKS, each ' +
    'in this EXACT format on their own lines:\n' +
    '===FILE: name.md===\n' +
    '<the file\'s Markdown>\n' +
    '===END===\n' +
    'You may emit SEVERAL files (e.g. split by category or by day). Use short, ' +
    'descriptive .md filenames. Do NOT wrap a block\'s body in a code fence.\n' +
    '- Put any explanation OUTSIDE the file blocks and keep it brief. If the user asks a ' +
    'SHORT factual question, answer in plain text with NO file blocks; but if your answer ' +
    'is itself a document — a table, several sections, or a long list — put that content ' +
    'in a FILE BLOCK rather than inline.\n' +
    '- If the request cannot be satisfied from the content, say so plainly (no blocks).';

  const convo = (history || [])
    .map((h) => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${h.content}`)
    .join('\n');
  const user =
    'EXTRACTED CONTENT (verbatim crawl output — your only source):\n\n' +
    src +
    '\n\n' +
    (convo ? 'Conversation so far:\n' + convo + '\n\n' : '') +
    'User: ' +
    String(instruction || '');

  let ans;
  try {
    ans = await chat(llm, system, user);
  } catch (err) {
    // Surface the real reason (bad key, unreachable URL, unknown model) — this is
    // a user-facing chat turn, not a silent crawl decision.
    return {
      reply:
        'The model call failed: ' +
        ((err && err.message) || String(err)) +
        '. Check the selected model, and (for an API provider) the base URL and API key.',
      files: [],
    };
  }
  const parsed = parseReshape(ans);
  if (!parsed.reply && !parsed.files.length) {
    return { reply: 'The model did not return a usable response. Try rephrasing, or check the model is reachable.', files: [] };
  }
  // "Auto" mode safety net: if the model answered with document-worthy content but
  // didn't wrap it in a FILE BLOCK, promote that content to a saved document so the
  // user gets a file — not just a chat message. Short Q&A is left as a message.
  if (!parsed.files.length && isDocumentWorthy(parsed.reply)) {
    parsed.files.push({ filename: deriveDocName(instruction, parsed.reply), content: parsed.reply });
    parsed.reply = '';
  }
  return parsed;
}

// =========================================================================
// PHASE 1 — crawl-time judgment (scope, links, reveal)
// =========================================================================

/**
 * Keep only task-relevant sections, verbatim. This is the "stay focused" step:
 * for a "documentation" task it drops the landing page, footer, pricing, etc.;
 * for "the pizza menu" it keeps only the menu. It never rewrites content — it
 * returns the ORIGINAL text of the kept sections — and biases toward KEEP.
 * @returns {Promise<{ markdown: string, relevant: boolean }>}
 */
export async function aiScopeContent({ llm, task, title, markdown }) {
  if (!markdown || markdown.length < 1200) return { markdown, relevant: !!markdown };

  const sections = sectionize(markdown);
  if (sections.length <= 1) {
    // Single blob: ask only whether it is relevant at all.
    const ans = await chat(
      llm,
      'You decide whether a web page is relevant to a user extraction task. Answer with JSON only.',
      `Task: "${task}"\nPage title: ${title || ''}\n\nContent (truncated):\n${markdown.slice(0, 2500)}\n\n` +
        'Reply with {"relevant": true|false}. Relevant means the page contains content the task asks for.',
    ).catch(() => '');
    const j = parseJson(ans);
    if (j && j.relevant === false) return { markdown: '', relevant: false };
    return { markdown, relevant: true };
  }

  const outline = sections
    .map((s) => `${s.index}: ${s.heading} — ${s.text.replace(/\s+/g, ' ').slice(0, 140)}`)
    .join('\n');

  const ans = await chat(
    llm,
    'You select which sections of a page belong to a user extraction task. ' +
      'Keep every section that contains task-relevant content. Drop only clearly-irrelevant ' +
      'sections such as site navigation, footers, cookie/consent notices, marketing call-to-action, ' +
      'newsletter signups, "related/recommended" widgets, comments, or unrelated topics. ' +
      'When unsure, KEEP. Answer with JSON only.',
    `Task: "${task}"\nPage title: ${title || ''}\n\nSections (index: heading — preview):\n${outline}\n\n` +
      'Reply with {"keep": [list of section indexes to keep]}.',
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
export async function aiSelectLinks({ llm, task, links }) {
  const capped = links.slice(0, 160);
  if (capped.length === 0) return [];

  const list = capped.map((l, i) => `${i}: ${l.label ? l.label.slice(0, 60) + ' — ' : ''}${l.href}`).join('\n');
  const ans = await chat(
    llm,
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
export async function aiSelectRevealers({ llm, task, candidates }) {
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
    llm,
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
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j || !Array.isArray(j.click)) return null; // signal: use the fallback
  const keep = new Set(j.click.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < list.length));
  return new Set([...keep].map((i) => list[i].signature));
}
