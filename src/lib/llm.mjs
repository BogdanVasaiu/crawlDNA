// The LLM transport layer — the ONE place that talks to a model provider.
//
// docdna's judgment layer (src/engine/decide.mjs) and reshape (src/reshape.mjs)
// are provider-agnostic: they call `chat(llm, system, user)` and never know which
// backend answered. Two backends are supported:
//
//   - 'ollama'  — a local Ollama server (the default; uses the `ollama` package,
//                 so model loading / keep-alive are handled for you).
//   - 'openai'  — ANY OpenAI-compatible Chat Completions API, addressed by a base
//                 URL + API key. This is the de-facto standard, so the same code
//                 path covers OpenAI, OpenRouter, Groq, Together, Mistral, DeepSeek,
//                 and local servers (llama.cpp, LM Studio, vLLM). Ollama itself
//                 speaks it at http://localhost:11434/v1, so it works here too.
//
// A model config is the small descriptor `{ provider, model, baseUrl, apiKey }`,
// produced once by `resolveLlm(options)` and threaded through the engine.

import ollama, { Ollama } from 'ollama';

const PROVIDERS = new Set(['ollama', 'openai']);
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const REQUEST_TIMEOUT_MS = 120000;

/** Strip a trailing slash; treat empty as empty. */
function trimUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/**
 * Build the base URL for an OpenAI-compatible API. Most providers want the `/v1`
 * suffix already in the URL (OpenAI, Ollama), but some carry their own path
 * (OpenRouter's `/api/v1`). So: if the user gave only an origin (no path), append
 * `/v1` for them; otherwise respect whatever path they typed.
 */
function openaiBase(raw) {
  let s = trimUrl(raw);
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.pathname === '' || u.pathname === '/') s = trimUrl(s) + '/v1';
  } catch {
    /* not a full URL — leave it untouched and let the request surface the error */
  }
  return s;
}

/** Join a base URL and a path segment with exactly one slash. */
function joinUrl(base, path) {
  return trimUrl(base) + '/' + String(path).replace(/^\/+/, '');
}

/**
 * Normalise raw options into a `{ provider, model, baseUrl, apiKey }` descriptor.
 * Backward compatible: an absent provider means 'ollama', and `ollamaHost` keeps
 * working. For the 'openai' provider, the API key falls back to the environment
 * (DOCDNA_API_KEY, then OPENAI_API_KEY) so it never has to be put on the CLI.
 *
 * @param {object} [options]
 * @param {string} [options.provider]   'ollama' (default) | 'openai'
 * @param {string} [options.model]
 * @param {string} [options.baseUrl]    OpenAI-compatible API base URL
 * @param {string} [options.apiKey]
 * @param {string} [options.ollamaHost] Ollama server URL (legacy / ollama provider)
 */
export function resolveLlm(options = {}) {
  const provider = PROVIDERS.has(String(options.provider || '').toLowerCase())
    ? String(options.provider).toLowerCase()
    : 'ollama';
  const model = options.model || '';

  if (provider === 'openai') {
    const apiKey =
      options.apiKey || process.env.DOCDNA_API_KEY || process.env.OPENAI_API_KEY || '';
    return { provider, model, baseUrl: openaiBase(options.baseUrl), apiKey };
  }

  // ollama: the baseUrl is the Ollama host (no /v1).
  const baseUrl = trimUrl(options.ollamaHost || options.baseUrl || DEFAULT_OLLAMA_HOST);
  return { provider, model, baseUrl, apiKey: '' };
}

// --- Ollama backend (one cached client per host) ---------------------------
const _ollamaClients = new Map();
function ollamaClient(host) {
  const key = trimUrl(host);
  if (!key) return ollama; // package default (127.0.0.1:11434)
  let c = _ollamaClients.get(key);
  if (!c) {
    c = new Ollama({ host: key });
    _ollamaClients.set(key, c);
  }
  return c;
}

async function ollamaChat(llm, system, user) {
  const res = await ollamaClient(llm.baseUrl).chat({
    model: llm.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    options: { temperature: 0 },
  });
  return res?.message?.content || '';
}

// --- OpenAI-compatible backend (raw fetch, zero new deps) -------------------
async function openaiChat(llm, system, user) {
  if (!llm.baseUrl) throw new Error('no API base URL set');
  const r = await fetch(joinUrl(llm.baseUrl, 'chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(llm.apiKey ? { authorization: 'Bearer ' + llm.apiKey } : {}),
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`LLM HTTP ${r.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  const d = await r.json().catch(() => null);
  return d?.choices?.[0]?.message?.content || '';
}

/**
 * One chat turn against the configured provider. Temperature 0, non-streaming.
 * Throws on transport/HTTP errors — callers in the crawl wrap this in
 * `.catch()` and bias toward keep/follow, so a model outage never loses content;
 * reshape surfaces the message to the user.
 *
 * @param {{provider:string, model:string, baseUrl:string, apiKey:string}} llm
 * @returns {Promise<string>}
 */
export async function chat(llm, system, user) {
  if (!llm || !llm.model) throw new Error('no model selected');
  return llm.provider === 'openai'
    ? openaiChat(llm, system, user)
    : ollamaChat(llm, system, user);
}

/**
 * List the models a provider offers, for the setup UI's picker.
 * Shape mirrors the old Ollama probe: `{ ok, models: [{ name, isCloud, size }] }`.
 *  - ollama → GET /api/tags (cloud models report size 0 or a -cloud suffix).
 *  - openai → GET /models (every listed model is "cloud"); needs a valid key for
 *    providers that gate the endpoint, in which case `ok:false` lets the UI fall
 *    back to a typed model id.
 *
 * @param {{provider:string, baseUrl:string, apiKey:string}} llm
 * @returns {Promise<{ ok:boolean, models:Array<{name:string,isCloud:boolean,size:number}>, error?:string }>}
 */
export async function listModels(llm) {
  if (llm.provider === 'openai') {
    if (!llm.baseUrl) return { ok: false, models: [], error: 'no base URL' };
    try {
      const r = await fetch(joinUrl(llm.baseUrl, 'models'), {
        headers: llm.apiKey ? { authorization: 'Bearer ' + llm.apiKey } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return { ok: false, models: [], error: 'HTTP ' + r.status };
      const d = await r.json().catch(() => null);
      const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d?.models) ? d.models : [];
      const models = arr
        .map((m) => ({ name: m.id || m.name || '', isCloud: true, size: 0 }))
        .filter((m) => m.name);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: String((err && err.message) || err) };
    }
  }

  // ollama
  const base = trimUrl(llm.baseUrl) || 'http://localhost:11434';
  try {
    const r = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { ok: false, models: [] };
    const d = await r.json();
    const models = (d.models || []).map((m) => ({
      name: m.name,
      isCloud: /[:-]cloud\b/i.test(m.name || '') || m.size === 0,
      size: m.size || 0,
    }));
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}
