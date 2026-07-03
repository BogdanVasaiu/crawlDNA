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
//
// NO-AI MODE (`noAi: true` → provider 'none'): every phase-1 judgment below
// short-circuits to its completeness-bias fallback WITHOUT building a prompt or
// touching the transport — heuristic reveal triage, keep pages whole, follow all
// in-scope links, no targeted navigation. Identical behaviour to a model outage
// (the fallbacks are shared), but intentional, warned once, and free of the
// failed calls' latency. Zero tokens by construction.
import { chat, llmDisabled } from '../lib/llm.mjs';
import { selectRelevant } from '../lib/retrieve.mjs';

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

// PROMPT-CACHE CONTRACT (#4): every judgment call's SYSTEM prompt below is a plain
// string literal — byte-identical across all calls of its type. That identity is what
// lets remote providers (OpenAI, DeepSeek, vLLM, OpenRouter) serve the repeated prefix
// from their prompt cache (~10× cheaper input) on a crawl's thousands of calls. Keep
// per-call data (task, page text, links, controls) in the USER message — never
// interpolate it into a system prompt. Locked by a test (decide.test.mjs).

// JSON shapes the crawl-judgment calls must return. Passed to the transport for
// CONSTRAINED DECODING (Ollama `format`) / guaranteed JSON (OpenAI `response_format`),
// so the model can't emit fences, prose or a wrong shape — the #1 cause of a parse
// failure (which would force the completeness-bias "follow/keep ALL" fallback and waste
// the crawl). Per-call downstream validation is unchanged (it stays the safety net).
const SCHEMAS = {
  reveal: { type: 'object', properties: { click: { type: 'array', items: { type: 'integer' } } }, required: ['click'], additionalProperties: false },
  links: { type: 'object', properties: { follow: { type: 'array', items: { type: 'integer' } } }, required: ['follow'], additionalProperties: false },
  keep: { type: 'object', properties: { keep: { type: 'array', items: { type: 'integer' } } }, required: ['keep'], additionalProperties: false },
  plan: { type: 'object', properties: { direction: { type: ['integer', 'null'] }, target: { type: ['string', 'null'] } }, required: ['direction', 'target'], additionalProperties: false },
};

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
    // A local model sometimes DOUBLES the block markers (a nested `===FILE: …===`
    // first line and a stray `===END` fragment at the end) — strip them so the
    // artefact never leaks into the saved file.
    content = content
      .replace(/^===FILE:[^\n]*===\s*\r?\n/, '')
      .replace(/\r?\n={2,}\s*END=*\s*$/, '')
      .trim();
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

// How many characters of source content to send the model per turn. Large crawls
// can exceed a model's context window; we cap and flag truncation rather than fail
// (the full extraction always stays on disk).
const RESHAPE_CAP = 60000;

/** One-line identity for a document so the model can be told (and the user can
 * reference) exactly which file it is: name · size · title · source URL(s). */
function docLabel(d, i, kind) {
  return [
    d.filename ? `"${d.filename}"` : `${kind} ${i + 1}`,
    d.bytes || d.bytes === 0 ? `${d.bytes} bytes` : '',
    d.title ? `titled "${d.title}"` : '',
    d.sources && d.sources.length ? `crawled from ${d.sources.join(' , ')}` : '',
    d.partial ? 'PARTIAL EXTRACT — only the sections relevant to this request are shown' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Render a labelled set of documents, each under a header that states its identity. */
function renderDocs(set, kind) {
  return set
    .map((d, i) => `===== ${kind} [${i + 1}] — ${docLabel(d, i, kind)} =====\n${String(d.content || '').trim()}`)
    .join('\n\n');
}

/**
 * Rework already-extracted content to fulfil a user request, like answering from a
 * knowledge base built over the whole crawl output. This is Phase 2: it runs on
 * the SAVED files, on demand, as many times as the user wants — the crawl itself
 * (Phase 1) never reshapes. The model MAY filter, reorder, regroup and reformat
 * (e.g. into a Markdown table); it MUST keep every kept value (name/number/price/
 * time/URL/string) EXACTLY as written and never invent or alter one.
 *
 * Context is passed as IDENTIFIABLE DOCUMENTS, not an anonymous blob, so the model
 * knows what it's looking at and can honour references like "the original md" or
 * "the 4574 bytes file":
 *   - `documents` — the ORIGINAL crawled extraction (the default thing to reshape),
 *     each `{ filename, bytes, title?, sources?, content }`.
 *   - `produced`  — files the user produced earlier in THIS chat (so they can
 *     iterate on one), each `{ filename, bytes?, content }`. Clearly separated.
 *   - `corpus`    — back-compat: a bare string becomes a single unnamed document.
 *
 * @param {object} a
 * @param {{provider,model,baseUrl,apiKey}} a.llm
 * @param {string} a.instruction               the user's latest message
 * @param {Array<{role:string, content:string}>} [a.history]  prior turns (this session)
 * @param {Array<object>} [a.documents]         original crawled source documents
 * @param {Array<object>} [a.produced]          files produced earlier in this chat
 * @param {string} [a.corpus]                   back-compat: unnamed source content
 * @returns {Promise<{ reply: string, files: Array<{ filename, content }>, truncated: boolean }>}
 */
export async function aiReshape({ llm, instruction, history = [], documents = null, produced = [], corpus = '' }) {
  let docs = Array.isArray(documents) ? documents : null;
  if (!docs) docs = String(corpus || '').trim() ? [{ filename: '', content: String(corpus) }] : [];
  docs = docs.filter((d) => String(d.content || '').trim());
  if (!docs.length) return { reply: 'There is no extracted content to work from yet.', files: [], truncated: false, contextMode: 'full' };

  // #11 root cause: when the sources exceed the model budget, RETRIEVE the sections
  // relevant to the instruction instead of blindly sending the first RESHAPE_CAP chars.
  // The blind head-slice is what made the model "answer" out-of-budget topics from its
  // own memory (a fabricated v-alert props table, live). Verbatim subsets, document
  // order preserved, omissions marked; 'head' mode = the legacy slice, kept only when
  // nothing in the instruction discriminates (e.g. "tidy everything up").
  const sel = selectRelevant(docs, instruction, RESHAPE_CAP);
  let contextMode = sel.mode;
  let truncated = sel.truncated;
  let sourcesBlock = renderDocs(sel.docs, 'SOURCE DOCUMENT');
  if (sourcesBlock.length > RESHAPE_CAP) {
    sourcesBlock = sourcesBlock.slice(0, RESHAPE_CAP);
    truncated = true;
    if (contextMode === 'full') contextMode = 'head';
  }
  if (sel.omittedDocs > 0) {
    sourcesBlock += `\n\n(${sel.omittedDocs} other source document(s) contained nothing relevant to this request and were omitted.)`;
  }
  // Prior chat outputs as secondary context, only with whatever budget remains so
  // they can never crowd out the originals.
  const prod = (produced || []).filter((d) => String(d.content || '').trim());
  let producedBlock = prod.length ? renderDocs(prod, 'FILE YOU PRODUCED EARLIER IN THIS CHAT') : '';
  const budget = Math.max(0, RESHAPE_CAP - sourcesBlock.length);
  if (producedBlock.length > budget) producedBlock = producedBlock.slice(0, budget);

  const system =
    'You help a user reshape and answer questions over ALREADY-EXTRACTED website content, ' +
    'like a knowledge base. The content is given as one or more SOURCE DOCUMENTS — the original, ' +
    'verbatim crawl output — each labelled with its filename and byte size. STRICT RULES:\n' +
    '- The SOURCE DOCUMENTS are your only source of facts AND the DEFAULT thing to work on. When ' +
    'the user says "the original", "the original md", a filename, or a size (e.g. "the 4574 bytes ' +
    'file"), they mean the matching SOURCE DOCUMENT — operate on THAT document.\n' +
    '- NEVER supply a fact, value, prop, price, example or code snippet from your own knowledge ' +
    'of the site, product or framework — even when you are confident you know it. If the SOURCE ' +
    'DOCUMENTS do not contain what the user asks for, say so plainly ("the extraction does not ' +
    'contain X") — an honest gap beats an invented answer every time.\n' +
    '- Never invent, add, infer or alter a value: keep every name, number, price, time, URL and ' +
    'string EXACTLY as written. You may select, drop, reorder, regroup, reformat (e.g. into a ' +
    'Markdown table) and tidy the layout — but never change the actual content or values.\n' +
    '- "Redo/rewrite the original better without changing its content" means reproduce that WHOLE ' +
    'document, tidied and well-structured, with every value preserved verbatim.\n' +
    '- Files labelled "FILE YOU PRODUCED EARLIER IN THIS CHAT" are your own prior outputs; revise ' +
    'one only when the user clearly refers to it. They are NOT the originals.\n' +
    '- When you produce deliverable content, emit it as one or more FILE BLOCKS, each in this EXACT ' +
    'format on their own lines:\n' +
    '===FILE: name.md===\n' +
    '<the file\'s Markdown>\n' +
    '===END===\n' +
    'You may emit SEVERAL files (e.g. split by category or by day). Use short, descriptive .md ' +
    'filenames. Do NOT wrap a block\'s body in a code fence.\n' +
    '- Only emit FILE BLOCKS when the user asks you to CREATE, RESHAPE, REDO, SPLIT, FILTER or ' +
    'REFORMAT a deliverable (or the answer is itself inherently a document — a table, several ' +
    'sections, a long list). A QUESTION is NOT such a request: when the user ASKS something (e.g. ' +
    '"what street is it on?", "how many slots are free?"), answer in plain text with NO file blocks, ' +
    'and do NOT reproduce a SOURCE DOCUMENT as a file. Put any explanation OUTSIDE the blocks, brief.\n' +
    '- If the request cannot be satisfied from the documents, say so plainly (no blocks).';

  const convo = (history || [])
    .map((h) => `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${h.content}`)
    .join('\n');
  const user =
    'SOURCE DOCUMENTS — the original crawled extraction (verbatim). By DEFAULT these are what you ' +
    'reshape; refer to them by filename or size when the user does:\n\n' +
    sourcesBlock +
    '\n\n' +
    (producedBlock
      ? 'FILES YOU PRODUCED EARLIER IN THIS CHAT (you may revise one if asked; NOT the originals):\n\n' +
        producedBlock +
        '\n\n'
      : '') +
    (convo ? 'Conversation so far:\n' + convo + '\n\n' : '') +
    'User: ' +
    String(instruction || '');

  let ans;
  try {
    ans = await chat(llm, system, user, null, 'reshape');
  } catch (err) {
    // Surface the real reason (bad key, unreachable URL, unknown model) — this is
    // a user-facing chat turn, not a silent crawl decision.
    return {
      reply:
        'The model call failed: ' +
        ((err && err.message) || String(err)) +
        '. Check the selected model, and (for an API provider) the base URL and API key.',
      files: [],
      truncated,
      contextMode,
    };
  }
  const parsed = parseReshape(ans);
  if (!parsed.reply && !parsed.files.length) {
    return { reply: 'The model did not return a usable response. Try rephrasing, or check the model is reachable.', files: [], truncated, contextMode };
  }
  // "Auto" mode safety net: if the model answered with document-worthy content but
  // didn't wrap it in a FILE BLOCK, promote that content to a saved document so the
  // user gets a file — not just a chat message. Short Q&A is left as a message.
  if (!parsed.files.length && isDocumentWorthy(parsed.reply)) {
    parsed.files.push({ filename: deriveDocName(instruction, parsed.reply), content: parsed.reply });
    parsed.reply = '';
  }
  return { ...parsed, truncated, contextMode };
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
  if (llmDisabled(llm)) return { markdown, relevant: !!markdown }; // no-AI: keep whole
  if (!markdown || markdown.length < 1200) return { markdown, relevant: !!markdown };

  const sections = sectionize(markdown);
  if (sections.length <= 1) {
    // Single blob: keep it whole, no model call. The only thing a relevance verdict
    // could do here is DROP the page, and the drop-guard was "irrelevant AND thin
    // (< 600 chars)" — unreachable, since everything under 1200 chars already
    // returned above. So the call could never change the outcome; it only burned
    // one scope call per single-section page. Narrowing a kept page to the task is
    // the job of section-scoping below and of Phase 2 (reshape).
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
    SCHEMAS.keep,
    'scope',
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
  if (llmDisabled(llm)) return capped.map((l) => l.href); // no-AI: follow all in-scope

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
    SCHEMAS.links,
    'links',
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j || !Array.isArray(j.follow)) return capped.map((l) => l.href); // follow all in-scope on failure
  const idx = new Set(j.follow.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < capped.length));
  // A non-empty answer whose indexes are ALL out of range is garbage → treat as failure.
  // A well-formed EMPTY list is a legitimate verdict ("none of these are on-task pages")
  // and must be honoured — overriding it to follow-all is what sent crawls wandering
  // through 160 off-task links whenever a page had nothing worth following.
  if (j.follow.length && idx.size === 0) return capped.map((l) => l.href);
  return capped.filter((_, i) => idx.has(i)).map((l) => l.href);
}

/**
 * Plan navigation ONCE for a multi-view page — the crawl4ai-inspired split: the AI
 * makes a single high-level PLAN, then the reveal loop EXECUTES it deterministically
 * (no LLM in the click loop, which is what made a per-step navigator flaky on a local
 * model). A page can be a sequence/graph of views reached by clicking controls that
 * move between them: paginators ("next"/"previous"/page N), calendar month arrows,
 * wizard steps, "load next", view switchers.
 *
 * The model answers one easy question: for THIS task, which control ADVANCES toward
 * the target, and what literal TEXT marks the target view (so the loop can stop by a
 * plain substring check, not another model call)? For an open-ended task
 * ("everything"/"all") there is no single target — it returns `direction: null` and
 * the loop explores every control instead.
 *
 * @param {object} a
 * @param {{provider,model,baseUrl,apiKey}} a.llm
 * @param {string} a.task
 * @param {{title?:string, snippet?:string}} a.current   the view we're on now
 * @param {Array<{signature:string, kind?:string, label?:string, context?:string}>} a.controls
 * @returns {Promise<{direction:number|null, target:string|null}|null>}
 *   direction = index into `controls` of the advancing control; target = literal text
 *   (in the PAGE's language) that appears in the target view; or null on failure.
 */
export async function aiPlanNavigation({ llm, task, current = {}, controls = [] }) {
  const list = (controls || []).slice(0, 60);
  if (list.length === 0) return { direction: null, target: null };
  // no-AI: no targeted walk — the reveal loop explores every control open-ended.
  if (llmDisabled(llm)) return { direction: null, target: null };

  const lines = list
    .map((c, i) => `${i}: [${c.kind || 'control'}] "${(c.label || '(no label)').slice(0, 70)}"` + (c.context ? ` — under "${c.context}"` : ''))
    .join('\n');

  const ans = await chat(
    llm,
    'You plan how to navigate a web page to fulfil an extraction task. Some pages are a ' +
      'SEQUENCE of views reached by clicking a control repeatedly (a "next month" arrow on ' +
      'a calendar, a "next page" paginator, wizard steps). Decide ONE plan:\n' +
      '- If the task targets a SPECIFIC view reachable by such navigation (a particular ' +
      'month+year, page, section or date), return the index of the control that ADVANCES ' +
      'toward it (e.g. the next/forward/"successivo" arrow to reach a LATER month; the ' +
      'previous/"precedente" one for an EARLIER month — reason from the current view) AND a ' +
      'short "target" string that will literally appear in that target view. The target ' +
      'string MUST be written in the SAME LANGUAGE/spelling as the page (look at the current ' +
      'view text: if months read "GIUGNO", "LUGLIO" then August is "agosto", not "august").\n' +
      '- If the task is open-ended ("everything", "all", "the whole …") or needs no such ' +
      'navigation, return {"direction": null, "target": null}.\n' +
      'Answer with JSON only.',
    `Task: "${task || ''}"\n\n` +
      `Current view (title + visible text):\n${(current.title || '').slice(0, 100)}\n${(current.snippet || '').replace(/\s+/g, ' ').slice(0, 700)}\n\n` +
      `Controls on the page (index: [kind] "label"):\n${lines}\n\n` +
      'Reply with {"direction": <index or null>, "target": "<text that marks the target view, or null>"}.',
    SCHEMAS.plan,
    'nav-plan',
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j) return null; // signal: caller falls back to open-ended exploration
  const dir = Number(j.direction);
  const direction = Number.isInteger(dir) && dir >= 0 && dir < list.length ? dir : null;
  const target = typeof j.target === 'string' && j.target.trim() ? j.target.trim() : null;
  return { direction, target };
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
  // no-AI: null = "use the per-candidate DOM heuristic" (same signal as a model
  // outage), so reveal coverage never drops below the deterministic baseline.
  if (llmDisabled(llm)) return null;

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
    SCHEMAS.reveal,
    'reveal',
  ).catch(() => '');

  const j = parseJson(ans);
  if (!j || !Array.isArray(j.click)) return null; // signal: use the fallback
  const keep = new Set(j.click.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < list.length));
  return new Set([...keep].map((i) => list[i].signature));
}
