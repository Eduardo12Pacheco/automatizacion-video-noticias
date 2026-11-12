import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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


test('OpenAI-compatible adapter reaches a local mock server end to end', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'qwen2.5:3b-instruct', choices: [{ message: { content: 'Guion local' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const adapter = new OpenAICompatibleLLMAdapter({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'qwen2.5:3b-instruct',
      apiKey: 'local-test-key',
      timeoutMs: 5_000,
    });
    const result = await adapter.complete({ prompt: 'Escribe un guion', maxTokens: 64 });
    assert.equal(result.text, 'Guion local');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer local-test-key');
    assert.equal(requests[0].body.model, 'qwen2.5:3b-instruct');
    assert.equal(requests[0].body.stream, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
