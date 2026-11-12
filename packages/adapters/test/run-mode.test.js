import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdaptersFromEnv } from '../src/composition.js';
import { DemoArticleExtractor, DemoASRAdapter, DemoLLMAdapter, DemoTTSAdapter, DemoTranslationAdapter, DemoVideoRendererAdapter } from '../src/demo.js';
import { OllamaLLMAdapter, OpenAICompatibleLLMAdapter } from '../src/llm.js';
import { HttpASRAdapter, HttpTranslationAdapter, HttpTTSAdapter, HttpVideoRendererAdapter } from '../src/worker-ports.js';
import {
  DEMO_ROUTE_TARGETS,
  LOCAL_ROUTE_TARGETS,
  applyRunModeDefaults,
  resolveModeRouteTargets,
  resolveRunMode,
} from '../src/run-mode.js';

const fetchStub = async () => ({ ok: true, status: 200, async text() { return '{}'; } });
const silentLogger = { error() {}, info() {}, warn() {} };

test('resolveRunMode defaults to local and accepts only the two real modes', () => {
  assert.equal(resolveRunMode({}), 'local');
  assert.equal(resolveRunMode({ NEWSROOM_MODE: 'LOCAL' }), 'local');
  assert.equal(resolveRunMode({ NEWSROOM_MODE: 'demo' }), 'demo');
  assert.equal(resolveRunMode({ NEWSROOM_MODE: 'showcase' }), 'local');
});

test('demo mode forces the deterministic adapters even when the env asks for the real ones', () => {
  const adapters = createAdaptersFromEnv({
    env: {
      NEWSROOM_MODE: 'demo',
      LLM: 'ollama',
      ARTICLE_EXTRACTOR: 'trafilatura',
      TTS: 'worker',
      ASR: 'worker',
      TRANSLATION: 'worker',
      RENDERER: 'worker',
      MEDIA_DOWNLOAD: 'worker',
    },
    fetchImpl: fetchStub,
    logger: silentLogger,
  });

  assert.ok(adapters.llm instanceof DemoLLMAdapter);
  assert.ok(adapters.articleExtractor instanceof DemoArticleExtractor);
  assert.ok(adapters.tts instanceof DemoTTSAdapter);
  assert.ok(adapters.asr instanceof DemoASRAdapter);
  assert.ok(adapters.translation instanceof DemoTranslationAdapter);
  assert.ok(adapters.videoRenderer instanceof DemoVideoRendererAdapter);
  assert.equal(adapters.mediaDownload, undefined);
});

test('local mode selects the real CPU adapters and the small local model by default', () => {
  const env = applyRunModeDefaults({ NEWSROOM_MODE: 'local' });
  const adapters = createAdaptersFromEnv({ env, fetchImpl: fetchStub, logger: silentLogger });

  assert.ok(adapters.llm instanceof OllamaLLMAdapter);
  assert.equal(adapters.llm.model, 'qwen2.5:3b-instruct');
  assert.ok(adapters.tts instanceof HttpTTSAdapter);
  assert.ok(adapters.asr instanceof HttpASRAdapter);
  assert.ok(adapters.translation instanceof HttpTranslationAdapter);
  assert.ok(adapters.videoRenderer instanceof HttpVideoRendererAdapter);
  assert.equal(env.PIPER_MODEL, 'es_ES-davefx-medium');
});

test('local mode still honours explicit adapter overrides', () => {
  const adapters = createAdaptersFromEnv({
    env: {
      NEWSROOM_MODE: 'local',
      LLM: 'openai',
      OPENAI_BASE_URL: 'http://llm.local:11434/v1',
      TTS: 'demo',
    },
    fetchImpl: fetchStub,
    logger: silentLogger,
  });

  assert.ok(adapters.llm instanceof OpenAICompatibleLLMAdapter);
  assert.ok(adapters.tts instanceof DemoTTSAdapter);
});

test('each run mode resolves its own worker routes and explicit targets win', () => {
  assert.deepEqual(resolveModeRouteTargets({ NEWSROOM_MODE: 'demo' }), { ...DEMO_ROUTE_TARGETS });
  assert.deepEqual(resolveModeRouteTargets({ NEWSROOM_MODE: 'local' }), { ...LOCAL_ROUTE_TARGETS });
  assert.equal(DEMO_ROUTE_TARGETS.tts, 'http://demo-worker:8088');
  assert.equal(LOCAL_ROUTE_TARGETS.tts, 'http://tts-worker:8766');
  assert.equal(LOCAL_ROUTE_TARGETS.approval, 'http://renderer:3042');
});
