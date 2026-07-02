// The OpenAI-compatible transport's #4 prompt-caching pieces: cached-token metering
// (OpenAI and DeepSeek report shapes) and the cache_control system block, which only
// OpenRouter receives. Local stub server — no external network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chat, buildOpenAiMessages } from '../src/lib/llm.mjs';

let usagePayload = {};
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: usagePayload }));
  });
});

let llm;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  llm = { provider: 'openai', model: 'stub', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'k' };
});
after(() => server.close());

const meter = async () => {
  let seen = null;
  llm.__onUsage = (u) => (seen = u);
  await chat(llm, 'system', 'user');
  return seen;
};

test('cached input tokens are metered from the OpenAI report shape', async () => {
  usagePayload = { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } };
  const u = await meter();
  assert.equal(u.inputTokens, 100);
  assert.equal(u.cachedInputTokens, 80);
});

test('cached input tokens are metered from the DeepSeek report shape', async () => {
  usagePayload = { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64 };
  assert.equal((await meter()).cachedInputTokens, 64);
});

test('providers that report no cache info meter 0 (never NaN)', async () => {
  usagePayload = { prompt_tokens: 10, completion_tokens: 2 };
  assert.equal((await meter()).cachedInputTokens, 0);
});

test('buildOpenAiMessages: cache_control system block for OpenRouter ONLY', () => {
  const or = buildOpenAiMessages({ baseUrl: 'https://openrouter.ai/api/v1' }, 'SYS', 'USR');
  assert.deepEqual(or[0], {
    role: 'system',
    content: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
  });
  assert.deepEqual(or[1], { role: 'user', content: 'USR' });

  // every other endpoint gets the untouched plain-string form
  for (const baseUrl of ['https://api.openai.com/v1', 'http://127.0.0.1:8080/v1', 'not a url', '']) {
    const msgs = buildOpenAiMessages({ baseUrl }, 'SYS', 'USR');
    assert.equal(msgs[0].content, 'SYS', `plain system for ${JSON.stringify(baseUrl)}`);
  }
});
