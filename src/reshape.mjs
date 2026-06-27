// Phase 2 — "reshape" (chat with your extraction).
//
// The crawl (Phase 1) produces a faithful, VERBATIM extraction per link. This
// step reworks those SAVED files into whatever the user asks — a table, a split,
// a filtered subset, a regroup — on demand, as many times as they want, reusing
// the same extraction as context (like querying a knowledge base). The crawl's
// own files are never touched; every reshape output lands under <scan>/chat/ and
// the conversation is recorded in that scan's session. Value-faithful by design:
// aiReshape copies every kept value exactly and never invents one.

import {
  getRun,
  readRunFile,
  getChatSession,
  saveChatSession,
  writeChatFile,
} from './lib/runs.mjs';
import { aiReshape } from './engine/decide.mjs';
import { resolveLlm } from './lib/llm.mjs';
import { slug } from './lib/url.mjs';

// How many characters of extracted content to send the model per turn. Large
// crawls can exceed a model's context; we cap and flag truncation rather than
// fail. (The full extraction always stays on disk.)
const CORPUS_CAP = 60000;

function stripFrontMatter(md) {
  const m = String(md || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? String(md).slice(m[0].length) : String(md || '');
}

function ensureTrailingNewline(s) {
  const t = String(s || '');
  return t.endsWith('\n') ? t : t + '\n';
}

/** Sanitise a model-proposed filename to a safe, unique `*.md` name. */
function sanitizeChatName(raw, used) {
  const base = slug(String(raw || '').replace(/\.md$/i, '')) || 'reshaped';
  let name = `${base}.md`;
  let n = 2;
  while (used.has(name) || name === 'session.json') name = `${base}-${n++}.md`;
  used.add(name);
  return name;
}

/** Find a scan in a run manifest by id (''/undefined = the only/first scan). */
function findScan(manifest, scanId) {
  const scans = manifest.scans || [];
  const sid = String(scanId || '');
  return scans.find((s) => String(s.scanId || '') === sid) || (sid ? null : scans[0]) || null;
}

/**
 * Run one reshape turn over a saved scan's extraction.
 *
 * @param {object} a
 * @param {string} a.runId
 * @param {string} [a.scanId]   '' = the run's only/first scan
 * @param {string} a.message    the user's request
 * @param {string} a.model      model id/name
 * @param {string} [a.provider] 'ollama' (default) | 'openai'
 * @param {string} [a.host]     Ollama host override (provider 'ollama')
 * @param {string} [a.baseUrl]  OpenAI-compatible API base URL (provider 'openai')
 * @param {string} [a.apiKey]   API key (provider 'openai')
 * @param {string} [a.cacheDir] runs-cache override
 * @returns {Promise<{ reply: string, files: Array<{ filename, bytes, at }>, truncated: boolean }>}
 */
export async function reshape({ runId, scanId = '', message, model, provider, host, baseUrl, apiKey, cacheDir }) {
  if (!String(message || '').trim()) throw new Error('empty message');
  if (!model) throw new Error('no model selected');
  const llm = resolveLlm({ provider, model, ollamaHost: host, baseUrl, apiKey });
  const opts = cacheDir ? { cacheDir } : {};

  const { manifest } = await getRun(runId, opts);
  const scan = findScan(manifest, scanId);
  if (!scan) throw new Error('scan not found');
  const sid = String(scan.scanId || '');

  // Assemble the scan's verbatim corpus from its crawl files (front-matter dropped).
  const parts = [];
  for (const f of scan.files || []) {
    try {
      parts.push(stripFrontMatter(await readRunFile(runId, sid, f.filename, opts)));
    } catch {
      /* skip an unreadable file rather than fail the whole turn */
    }
  }
  let corpus = parts.join('\n\n').trim();
  if (!corpus) throw new Error('no extracted content for this link');
  const truncated = corpus.length > CORPUS_CAP;
  if (truncated) corpus = corpus.slice(0, CORPUS_CAP);

  const session = await getChatSession(runId, sid, opts);
  const { reply, files } = await aiReshape({
    llm,
    corpus,
    instruction: message,
    history: (session.messages || []).map((m) => ({ role: m.role, content: m.content })),
  });

  // Persist any produced files under the scan's chat folder, with stable names.
  const used = new Set((session.files || []).map((f) => f.filename));
  const savedFiles = [];
  for (const file of files) {
    const name = sanitizeChatName(file.filename, used);
    const content = ensureTrailingNewline(file.content);
    await writeChatFile(runId, sid, name, content, opts);
    savedFiles.push({ filename: name, bytes: Buffer.byteLength(content, 'utf8'), at: new Date().toISOString() });
  }

  // Record the turn (user + assistant) and register the new files.
  const now = new Date().toISOString();
  session.messages = session.messages || [];
  session.messages.push({ role: 'user', content: String(message), at: now });
  session.messages.push({
    role: 'assistant',
    content: reply,
    files: savedFiles.map((f) => f.filename),
    at: now,
  });
  session.files = [...(session.files || []), ...savedFiles];
  await saveChatSession(runId, sid, session, opts);

  return { reply, files: savedFiles, truncated };
}

export default reshape;
