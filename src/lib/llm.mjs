// The LLM transport layer — the ONE place that talks to a model provider.
//
// sagecrawl's judgment layer (src/engine/decide.mjs) and reshape (src/reshape.mjs)
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
// Reshape turns rework WHOLE documents (long outputs, slow on a local model) — the
// 120s leash killed a legitimate "redo the original, tidied" turn live. They get a
// longer, still-bounded budget; the crawl's small judgment calls keep the tight one.
const RESHAPE_TIMEOUT_MS = 300000;
const timeoutFor = (kind) => (kind === 'reshape' ? RESHAPE_TIMEOUT_MS : REQUEST_TIMEOUT_MS);

// --- LLM call throttle (provider-aware) ------------------------------------
// A LOCAL model (Ollama) is a single process that answers ~one prompt at a time,
// so firing the crawl's parallel pages' judgment calls at it ALL AT ONCE only
// thrashes it: each call gets slower, and Stop drags because in-flight calls must
// drain. So we cap CONCURRENT calls PER PROVIDER — tight for local, generous for a
// remote API (OpenAI/DeepSeek/OpenRouter/… scale horizontally, so parallelism there
// is a clear win). The browser still renders pages in parallel; only the model
// calls are metered.
const PROVIDER_CONCURRENCY = { ollama: 2, openai: 16 };

function createLimiter(max) {
  let active = 0;
  const waiters = [];
  const pump = () => {
    while (active < max && waiters.length) {
      active++;
      const { fn, resolve, reject } = waiters.shift();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        waiters.push({ fn, resolve, reject });
        pump();
      });
    },
    // Drop everything still QUEUED (not yet started) so a stopped crawl doesn't
    // keep handing work to the model. Callers in decide.mjs `.catch()` and bias to
    // keep/follow, so a cancelled judgment never loses content.
    clear() {
      const pending = waiters.splice(0);
      for (const w of pending) w.reject(new Error('LLM call cancelled (crawl stopped)'));
    },
  };
}

const _limiters = new Map();
function limiterFor(provider) {
  let l = _limiters.get(provider);
  if (!l) {
    l = createLimiter(PROVIDER_CONCURRENCY[provider] || 8);
    _limiters.set(provider, l);
  }
  return l;
}

/** Cancel all QUEUED (not-yet-started) LLM calls — called by run.stop() so a stop
 *  is near-instant instead of waiting for a backlog of judgment calls to run. */
export function abortPendingLlm() {
  for (const l of _limiters.values()) l.clear();
}

/** Rough token estimate (≈4 chars/token) — only a FALLBACK for when a backend
 *  doesn't report real counts; real numbers from the provider are preferred. */
function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

/** Reject a promise if it outruns `ms`, so a hung model call can't stall a crawl
 *  (or its Stop) indefinitely. The Ollama client has no per-call timeout of its own. */
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

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
 * (SAGECRAWL_API_KEY, then OPENAI_API_KEY) so it never has to be put on the CLI.
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
      options.apiKey || process.env.SAGECRAWL_API_KEY || process.env.OPENAI_API_KEY || '';
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

async function ollamaChat(llm, system, user, schema, timeoutMs = REQUEST_TIMEOUT_MS) {
  const req = {
    model: llm.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    options: { temperature: 0 },
  };
  // Constrained decoding: force the model to emit EXACTLY this JSON shape (Ollama uses
  // XGrammar). Removes the #1 cause of parse failures (code fences, preambles, partial
  // or wrong-shaped JSON) and is markedly faster — no tokens spent on formatting. Only
  // when a schema is expected; free-form calls (reshape, the health ping) pass none.
  if (schema) req.format = schema;
  const res = await withTimeout(
    ollamaClient(llm.baseUrl).chat(req),
    timeoutMs,
    'Ollama request',
  );
  const content = res?.message?.content || '';
  // Ollama reports real token counts (prompt_eval_count / eval_count); fall back to
  // an estimate only if a build doesn't.
  const usage = {
    inputTokens: res?.prompt_eval_count ?? estimateTokens(system + user),
    outputTokens: res?.eval_count ?? estimateTokens(content),
    cachedInputTokens: 0, // Ollama reuses its KV cache internally but doesn't report it
  };
  return { content, usage };
}

// --- OpenAI-compatible backend (raw fetch, zero new deps) -------------------

/**
 * Build the chat messages for an OpenAI-compatible request (#4 prompt caching).
 *
 * The judgment system prompts are deliberately BYTE-IDENTICAL across every call of
 * their type (per-call data lives in the user message), so providers with automatic
 * prefix caching (OpenAI, DeepSeek, vLLM, …) reuse them without being asked —
 * repeat input tokens become ~10× cheaper/faster on a crawl's thousands of calls.
 *
 * OpenRouter is the one place an EXPLICIT marker helps: Anthropic models behind it
 * cache only blocks tagged `cache_control`, and OpenRouter documents this content-
 * parts form for all models (it strips the field where unsupported). Every other
 * endpoint gets the plain-string system message, so nothing changes for them.
 * Exported for tests.
 */
export function buildOpenAiMessages(llm, system, user) {
  let sys = system;
  try {
    const host = new URL(llm.baseUrl).hostname;
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
      sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
  } catch {
    /* unparsable base URL — keep the plain string; the request will surface the error */
  }
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

async function openaiChat(llm, system, user, schema, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!llm.baseUrl) throw new Error('no API base URL set');
  const headers = {
    'content-type': 'application/json',
    ...(llm.apiKey ? { authorization: 'Bearer ' + llm.apiKey } : {}),
  };
  const base = {
    model: llm.model,
    messages: buildOpenAiMessages(llm, system, user),
    temperature: 0,
    stream: false,
  };
  // When the caller expects JSON, ask for guaranteed-valid JSON via `json_object`: it
  // kills the code fences / preambles that break parsing, and is broadly supported
  // (OpenAI, DeepSeek, Groq, vLLM, LM Studio…). The prompts already contain the word
  // "JSON" (OpenAI requires it for this mode). If a provider REJECTS response_format, we
  // retry once WITHOUT it — a crawl must never break on an endpoint lacking the feature.
  const send = (useFormat) =>
    fetch(joinUrl(llm.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(useFormat ? { ...base, response_format: { type: 'json_object' } } : base),
      signal: AbortSignal.timeout(timeoutMs),
    });

  let r = await send(!!schema);
  if (!r.ok && schema && [400, 404, 415, 422, 501].includes(r.status)) {
    r = await send(false); // provider doesn't support response_format — degrade, don't fail
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`LLM HTTP ${r.status}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  const d = await r.json().catch(() => null);
  const content = d?.choices?.[0]?.message?.content || '';
  // OpenAI-compatible APIs return token usage; estimate only if absent.
  const u = d?.usage || {};
  const usage = {
    inputTokens: u.prompt_tokens ?? estimateTokens(system + user),
    outputTokens: u.completion_tokens ?? estimateTokens(content),
    // #4: how much of the input was served from the provider's prompt cache —
    // OpenAI-style (prompt_tokens_details.cached_tokens) or DeepSeek-style
    // (prompt_cache_hit_tokens). Metered so a run can SHOW the cached share growing
    // (those tokens are ~10× cheaper); 0 when the provider doesn't report it.
    cachedInputTokens: Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) || 0,
  };
  return { content, usage };
}

/**
 * One chat turn against the configured provider. Temperature 0, non-streaming.
 * Throws on transport/HTTP errors — callers in the crawl wrap this in
 * `.catch()` and bias toward keep/follow, so a model outage never loses content;
 * reshape surfaces the message to the user.
 *
 * @param {{provider:string, model:string, baseUrl:string, apiKey:string}} llm
 * @param {object} [schema]  optional JSON schema → constrained/guaranteed JSON output
 * @param {string} [kind]    a label for WHAT this call is (reveal/scope/links/nav-plan/
 *                           reshape/health) — reported to the usage sink so tokens can be
 *                           attributed per call type, not just totalled (see src/eval).
 * @returns {Promise<string>}
 */
export async function chat(llm, system, user, schema = null, kind = '') {
  if (!llm || !llm.model) throw new Error('no model selected');
  const provider = llm.provider === 'openai' ? 'openai' : 'ollama';
  // Meter concurrent calls per provider (tight for local, generous for remote).
  return limiterFor(provider).run(async () => {
    const timeoutMs = timeoutFor(kind);
    const { content, usage } = provider === 'openai'
      ? await openaiChat(llm, system, user, schema, timeoutMs)
      : await ollamaChat(llm, system, user, schema, timeoutMs);
    // Report token usage to an optional sink on the descriptor (set by the crawl)
    // so cost can be approximated. The `kind` lets the sink break the total down by
    // call type (which judgment actually spends the tokens). Metering must never
    // break the actual call.
    if (typeof llm.__onUsage === 'function') {
      try {
        llm.__onUsage({
          provider,
          kind: kind || 'other',
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
          cachedInputTokens: usage.cachedInputTokens || 0,
        });
      } catch {
        /* ignore */
      }
    }
    return content;
  });
}

/**
 * One-time health check run before a crawl: confirm the configured model actually
 * answers. The crawl's judgment calls (decide.mjs) all `.catch()` and bias toward
 * keep/follow/reveal, so a misconfigured model (wrong key, unreachable host,
 * un-pulled model) would otherwise degrade to heuristics SILENTLY — bad output
 * with no explanation. This lets the caller warn LOUDLY instead. Best-effort and
 * bounded: any throw means "not usable" with a short reason; it never throws.
 *
 * @param {{provider:string, model:string, baseUrl:string, apiKey:string}} llm
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function checkModel(llm) {
  if (!llm || !llm.model) return { ok: false, reason: 'no model selected' };
  if (llm.provider === 'openai' && !llm.baseUrl) return { ok: false, reason: 'no API base URL set' };
  try {
    await chat(llm, 'Reply with the single word OK.', 'ping', null, 'health');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 200) };
  }
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
