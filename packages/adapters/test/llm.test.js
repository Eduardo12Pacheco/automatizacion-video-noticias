import assert from 'node:assert/strict';
import test from 'node:test';

import { OllamaLLMAdapter, OpenAICompatibleLLMAdapter } from '../src/llm.js';

function fakeResponse({ status = 200, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

test('Ollama adapter posts a chat request and returns the assistant text', async () => {
  const calls = [];
  const adapter = new OllamaLLMAdapter({
    baseUrl: 'http://ollama.local:11434/',
    model: 'qwen2.5:7b-instruct',
    timeoutMs: 5_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ body: JSON.stringify({ model: 'qwen2.5:7b-instruct', message: { content: 'Hola guion' } }) });
    },
  });

  const result = await adapter.complete({ prompt: 'Escribe', system: 'Sos editor', temperature: 0.3, maxTokens: 100 });

  assert.equal(result.text, 'Hola guion');
  assert.equal(result.provider, 'ollama');
  assert.equal(calls[0].url, 'http://ollama.local:11434/api/chat');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'qwen2.5:7b-instruct');
  assert.deepEqual(body.messages[0], { role: 'system', content: 'Sos editor' });
  assert.equal(body.messages[1].content, 'Escribe');
  assert.equal(body.options.temperature, 0.3);
  assert.equal(body.options.num_predict, 100);
  assert.equal(body.stream, false);
});

test('Ollama adapter raises a typed error on an empty response', async () => {
  const adapter = new OllamaLLMAdapter({
    fetchImpl: async () => fakeResponse({ body: JSON.stringify({ message: { content: '' } }) }),
  });

  await assert.rejects(() => adapter.complete({ prompt: 'x' }), /empty response/);
});

test('Ollama adapter surfaces upstream failures without leaking the body', async () => {
  const adapter = new OllamaLLMAdapter({
    fetchImpl: async () => fakeResponse({ status: 503, body: JSON.stringify({ error: 'model not loaded' }) }),
  });

  await assert.rejects(
    () => adapter.complete({ prompt: 'x' }),
    (error) => error.code === 'ollama_http_503' && /model not loaded/.test(error.message),
  );
});

test('OpenAI-compatible adapter maps choices and only sends an authorization header when configured', async () => {
  const calls = [];
  const adapter = new OpenAICompatibleLLMAdapter({
    baseUrl: 'http://llm.local/v1',
    model: 'local-model',
    apiKey: 'not-a-real-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse({ body: JSON.stringify({ model: 'local-model', choices: [{ message: { content: 'ok' } }] }) });
    },
  });

  const result = await adapter.complete({ prompt: 'hola' });

  assert.equal(result.text, 'ok');
  assert.equal(calls[0].url, 'http://llm.local/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, 'Bearer not-a-real-key');
  assert.equal(JSON.parse(calls[0].options.body).max_tokens, undefined);
});
