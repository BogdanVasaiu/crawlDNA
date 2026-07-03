// resolveLlm — the provider descriptor every AI call is routed by. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLlm, llmDisabled, chat } from '../src/lib/llm.mjs';

test('defaults to ollama with the standard local host', () => {
  const llm = resolveLlm({ model: 'qwen3-coder:30b' });
  assert.equal(llm.provider, 'ollama');
  assert.equal(llm.model, 'qwen3-coder:30b');
  assert.equal(llm.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(llm.apiKey, '');
});

test('ollamaHost override, trailing slashes trimmed; unknown provider falls back to ollama', () => {
  assert.equal(resolveLlm({ ollamaHost: 'http://gpu:11434/' }).baseUrl, 'http://gpu:11434');
  assert.equal(resolveLlm({ provider: 'banana' }).provider, 'ollama');
});

test('openai: origin-only base URL gets /v1 appended, an explicit path is respected', () => {
  const mk = (baseUrl) => resolveLlm({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl }).baseUrl;
  assert.equal(mk('https://api.openai.com'), 'https://api.openai.com/v1');
  assert.equal(mk('https://api.openai.com/'), 'https://api.openai.com/v1');
  assert.equal(mk('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
  assert.equal(mk('https://x.dev/v1/'), 'https://x.dev/v1');
});

test('noAi wins over everything → provider none; chat refuses it with a clear reason', async () => {
  // Even a fully-configured provider is ignored: noAi means ZERO model calls.
  const llm = resolveLlm({ noAi: true, provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://x.dev', apiKey: 'k' });
  assert.equal(llm.provider, 'none');
  assert.equal(llm.model, '');
  assert.equal(llmDisabled(llm), true);
  assert.equal(llmDisabled(resolveLlm({ model: 'qwen3-coder:30b' })), false);
  // The transport backstop: a leaked 'none' descriptor fails loud and clear (no
  // network is touched — the guard throws before any request is built).
  await assert.rejects(() => chat(llm, 'sys', 'user'), /disabled/);
});

test('openai: api key falls back to SAGECRAWL_API_KEY then OPENAI_API_KEY', () => {
  const prevSage = process.env.SAGECRAWL_API_KEY;
  const prevOpen = process.env.OPENAI_API_KEY;
  try {
    process.env.SAGECRAWL_API_KEY = 'sage-key';
    process.env.OPENAI_API_KEY = 'openai-key';
    assert.equal(resolveLlm({ provider: 'openai', baseUrl: 'https://x.dev' }).apiKey, 'sage-key');
    delete process.env.SAGECRAWL_API_KEY;
    assert.equal(resolveLlm({ provider: 'openai', baseUrl: 'https://x.dev' }).apiKey, 'openai-key');
    // an explicit option always wins over the environment
    assert.equal(
      resolveLlm({ provider: 'openai', baseUrl: 'https://x.dev', apiKey: 'explicit' }).apiKey,
      'explicit',
    );
  } finally {
    if (prevSage === undefined) delete process.env.SAGECRAWL_API_KEY;
    else process.env.SAGECRAWL_API_KEY = prevSage;
    if (prevOpen === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpen;
  }
});
