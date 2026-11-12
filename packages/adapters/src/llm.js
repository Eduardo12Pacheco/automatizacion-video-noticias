import { AdapterError, fetchWithTimeout, readJsonResponse, trimBaseUrl } from './http.js';

function buildMessages({ prompt = '', system = '' } = {}) {
  const messages = [];
  if (String(system || '').trim()) messages.push({ role: 'system', content: String(system) });
  messages.push({ role: 'user', content: String(prompt || '') });
  return messages;
}

function requirePrompt(prompt) {
  if (!String(prompt || '').trim()) {
    throw new AdapterError('llm_empty_prompt', 'LLM prompt is required', { statusCode: 400 });
  }
}

/**
 * Local default LLM: Ollama's native chat API. No key, no cloud account; the
 * model is expected to be pulled once by the installer (`ollama pull ...`).
 */
export class OllamaLLMAdapter {
  constructor({
    baseUrl = 'http://127.0.0.1:11434',
    model = 'qwen2.5:7b-instruct',
    fetchImpl = globalThis.fetch,
    timeoutMs = 300_000,
  } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.model = String(model || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 300_000);
  }

  async complete({ prompt = '', system = '', temperature = 0.2, maxTokens = null } = {}) {
    requirePrompt(prompt);
    if (!this.model) throw new AdapterError('llm_model_missing', 'OLLAMA_MODEL is required');
    const options = { temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2 };
    const tokens = Number(maxTokens);
    if (Number.isFinite(tokens) && tokens > 0) options.num_predict = Math.trunc(tokens);
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/chat`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: buildMessages({ prompt, system }),
        stream: false,
        options,
      }),
    });
    const data = await readJsonResponse(response, { adapter: 'ollama' });
    const text = String(data?.message?.content ?? data?.response ?? '').trim();
    if (!text) throw new AdapterError('llm_empty_response', 'Ollama returned an empty response');
    return { text, model: data?.model || this.model, provider: 'ollama', raw: data };
  }
}

/**
 * Optional OpenAI-compatible adapter. It also works against Ollama's
 * `/v1/chat/completions` endpoint or any local gateway that speaks the same
 * protocol; it stays off unless `LLM=openai` is selected.
 */
export class OpenAICompatibleLLMAdapter {
  constructor({
    baseUrl = 'http://127.0.0.1:11434/v1',
    model = 'qwen2.5:7b-instruct',
    apiKey = '',
    fetchImpl = globalThis.fetch,
    timeoutMs = 300_000,
  } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.model = String(model || '').trim();
    this.apiKey = String(apiKey || '').trim();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 300_000);
  }

  async complete({ prompt = '', system = '', temperature = 0.2, maxTokens = null } = {}) {
    requirePrompt(prompt);
    const body = {
      model: this.model,
      messages: buildMessages({ prompt, system }),
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
      stream: false,
    };
    const tokens = Number(maxTokens);
    if (Number.isFinite(tokens) && tokens > 0) body.max_tokens = Math.trunc(tokens);
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/chat/completions`, {
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await readJsonResponse(response, { adapter: 'openai' });
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new AdapterError('llm_empty_response', 'OpenAI-compatible endpoint returned an empty response');
    return { text, model: data?.model || this.model, provider: 'openai', raw: data };
  }
}
