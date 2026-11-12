import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FsBlobStorage } from '../../../packages/data/src/index.js';
import { createAdaptersFromEnv } from '../src/composition.js';
import { createConnectorRegistry } from '../src/connectors.js';

function adaptersFor(env = {}) {
  return createAdaptersFromEnv({
    env: { NEWSROOM_MODE: 'local', TTS: 'none', ASR: 'none', TRANSLATION: 'none', RENDERER: 'none', AUTH: 'none', ...env },
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{}'; } }),
    logger: { info() {}, debug() {}, error() {} },
  });
}

test('registry lists every composed port with a local, configured or disabled status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connectors-'));
  try {
    const adapters = adaptersFor({
      NOTIFY: 'smtp',
      SMTP_HOST: 'mailpit',
      SMTP_USER: 'demo',
      SMTP_PASS: 'super-secret-password',
      WORKFLOW: 'n8n',
      N8N_WEBHOOK_BASE_URL: 'http://n8n:5678',
    });
    const registry = createConnectorRegistry({
      env: {},
      adapters,
      blobStorage: new FsBlobStorage({ root }),
    });
    const list = registry.list();
    const ids = list.map((entry) => entry.id);
    for (const id of [
      'repository', 'blob-storage', 'news-source', 'article-extractor', 'llm', 'image-search',
      'tts', 'asr', 'translation', 'video-renderer', 'channel-feed', 'media-download',
      'document-export', 'workflow', 'notification', 'auth',
    ]) {
      assert.ok(ids.includes(id), `missing connector ${id}`);
    }
    assert.equal(list.find((entry) => entry.id === 'llm').status, 'local');
    assert.equal(list.find((entry) => entry.id === 'notification').status, 'configured');
    assert.equal(list.find((entry) => entry.id === 'workflow').status, 'configured');
    assert.equal(list.find((entry) => entry.id === 'tts').status, 'disabled');
    const serialized = JSON.stringify(list);
    assert.equal(serialized.includes('super-secret-password'), false);
    assert.equal(serialized.includes('SMTP_PASS'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed probe marks the connector as error on the next read', async () => {
  const calls = [];
  const registry = createConnectorRegistry({
    env: {},
    adapters: {
      llm: {
        constructor: { name: 'OllamaLLMAdapter' },
        baseUrl: 'http://ollama.local:11434',
        model: 'qwen2.5:3b-instruct',
      },
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: false, status: 503, async text() { return 'down'; } };
    },
  });

  const result = await registry.test('llm');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(calls[0], /\/api\/tags$/);
  assert.equal(registry.list().find((entry) => entry.id === 'llm').status, 'error');
  assert.equal(registry.list().find((entry) => entry.id === 'llm').last_message, 'HTTP 503');
});

test('a successful probe reports local and the connection message', async () => {
  const registry = createConnectorRegistry({
    env: {},
    adapters: {
      notification: {
        constructor: { name: 'SmtpNotificationAdapter' },
        host: 'mailpit',
        port: 1025,
        async verify() { return { ok: true, message: 'SMTP greeting OK' }; },
      },
    },
  });
  const result = await registry.test('notification');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'configured');
  assert.equal(result.message, 'SMTP greeting OK');
});

test('redacts userinfo, query and fragment from every endpoint detail and probe', async () => {
  const malicious = 'https://user:secret@host.example/path?token=abc#frag';
  const adapters = adaptersFor({
    LLM: 'openai',
    OPENAI_BASE_URL: malicious,
    IMAGE_SEARCH: 'searxng',
    SEARXNG_URL: malicious,
    WORKFLOW: 'n8n',
    N8N_WEBHOOK_BASE_URL: malicious,
    ASR_BASE_URL: malicious,
    TTS_BASE_URL: malicious,
    SUBTITLES_BASE_URL: malicious,
    RENDERER_BASE_URL: malicious,
  });
  const registry = createConnectorRegistry({
    env: {},
    adapters,
    fetchImpl: async (url) => {
      throw new Error(`cannot reach ${url}`);
    },
  });

  const serialized = JSON.stringify(registry.list());
  for (const secret of ['user', 'secret', 'token', 'abc', 'frag']) {
    assert.equal(serialized.includes(secret), false, `list leaked ${secret}: ${serialized}`);
  }

  for (const id of ['llm', 'image-search', 'workflow', 'asr', 'tts', 'translation', 'video-renderer', 'media-download']) {
    const result = await registry.test(id);
    const response = JSON.stringify(result);
    for (const secret of ['user', 'secret', 'token', 'abc', 'frag']) {
      assert.equal(response.includes(secret), false, `${id} leaked ${secret}: ${response}`);
    }
  }
});

test('unknown connectors return null instead of inventing a status', async () => {
  const registry = createConnectorRegistry({ env: {}, adapters: {} });
  assert.equal(await registry.test('nope'), null);
});
