const { stableId } = require("../projects/editor-project");

const DEFAULT_ENDPOINT = "https://google.serper.dev/images";
const DEFAULT_GL = "us";
const DEFAULT_HL = "en";
const DEFAULT_NUM = 100;
const DEFAULT_TBS = "qdr:w";

const BLOCKED_IMAGE_DOMAINS = [
  "tiktok.com",
  "tiktokcdn.com",
  "tiktokv.com",
  "facebook.com",
  "fbcdn.net",
  "instagram.com",
  "cdninstagram.com",
  "youtube.com",
  "ytimg.com",
  "ebay.com",
  "alamy.com",
];

function providerError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function providerStatus(overrides = {}) {
  return {
    provider: "serper-images",
    endpoint: overrides.endpoint || DEFAULT_ENDPOINT,
    filter: DEFAULT_TBS,
    gl: overrides.gl || DEFAULT_GL,
    hl: overrides.hl || DEFAULT_HL,
    num: overrides.num || DEFAULT_NUM,
    fallback: false,
    ...overrides,
  };
}

function mapImageResult(item, index, query) {
  const imageUrl = item.imageUrl || item.image_url || item.image || item.url;
  const thumbnailUrl = item.thumbnailUrl || item.thumbnail_url || item.thumbnail;
  const domain = item.domain || (item.link ? safeHostname(item.link) : undefined);
  const position = Number.isFinite(Number(item.position)) ? Number(item.position) : index + 1;
  const idInput = imageUrl || item.link || item.googleUrl || `${query}-${position}`;
  return {
    id: `serper-${stableId(idInput) || position}`,
    label: item.title || item.source || domain || `Serper image #${position}`,
    provider: "serper-images",
    score: Number((1 - index * 0.05).toFixed(2)),
    reason: "Serper Images 1w result",
    source: {
      kind: "api-candidate",
      provider: "serper-images",
      query,
      imageUrl,
      thumbnailUrl,
      title: item.title,
      source: item.source,
      domain,
      link: item.link,
      googleUrl: item.googleUrl,
      position,
    },
  };
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function isBlockedDomain(domain = "") {
  const normalized = domain.toLowerCase();
  return BLOCKED_IMAGE_DOMAINS.some((blocked) => normalized.includes(blocked));
}

function createImageSearchProvider({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = env.SERPER_API_KEY;
  const endpoint = env.SERPER_IMAGES_ENDPOINT || DEFAULT_ENDPOINT;
  const gl = env.SERPER_GL || DEFAULT_GL;
  const hl = env.SERPER_HL || DEFAULT_HL;
  const num = parsePositiveInteger(env.SERPER_NUM, DEFAULT_NUM);

  function getStatus() {
    if (!apiKey) {
      return providerStatus({ provider: "deterministic-local", endpoint, gl, hl, num, fallback: true, reason: "missing-api-key" });
    }
    return providerStatus({ endpoint, gl, hl, num });
  }

  async function searchImages({ query }) {
    if (!apiKey) throw providerError("missing_api_key", "missing SERPER_API_KEY");
    if (!fetchImpl) throw providerError("missing_fetch", "fetch implementation is required for Serper image search");
    const body = { q: query, gl, hl, num, tbs: DEFAULT_TBS };
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-KEY": apiKey },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw providerError("provider_error", error.message || "Serper request failed", { cause: error.message });
    }
    if (!response.ok) {
      throw providerError("provider_error", `Serper request failed with ${response.status}`, { status: response.status });
    }
    const payload = await response.json();
    const images = Array.isArray(payload.images) ? payload.images : [];
    const candidates = images
      .filter((item) => {
        const domain = item.domain || (item.link ? safeHostname(item.link) : "");
        return !isBlockedDomain(domain);
      })
      .map((item, index) => mapImageResult(item, index, query))
      .filter((candidate) => candidate.source.imageUrl || candidate.source.thumbnailUrl);
    return {
      candidates,
      providerStatus: providerStatus({ endpoint, gl, hl, num }),
    };
  }

  return { getStatus, searchImages };
}

module.exports = { createImageSearchProvider };
