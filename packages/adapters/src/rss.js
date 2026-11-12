import { AdapterError, fetchWithTimeout } from './http.js';

const ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

export function decodeXmlEntities(value = '') {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[String(name).toLowerCase()] ?? match);
}

export function stripHtml(value = '') {
  return decodeXmlEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTag(xml = '', tag = '') {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const match = String(xml || '').match(pattern);
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function extractAttribute(xml, tag, attribute) {
  const pattern = new RegExp(`<${tag}\\b[^>]*\\b${attribute}=(["'])(.*?)\\1[^>]*>`, 'i');
  const match = String(xml || '').match(pattern);
  return match ? decodeXmlEntities(match[2]).trim() : '';
}

function splitTitleAndSource(rawTitle, explicitSource = '') {
  const raw = stripHtml(rawTitle);
  const parts = raw.split(' - ');
  const title = parts.length > 1 ? parts.slice(0, -1).join(' - ').trim() : raw;
  const source = explicitSource || (parts.length > 1 ? parts[parts.length - 1].trim() : '');
  return { title, source };
}

function slug(value, limit = 80) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit);
}

function isoDate(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString();
}

function parseRssItems(xml) {
  return [...String(xml || '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
}

function parseAtomEntries(xml) {
  return [...String(xml || '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
}

export function parseNewsFeed(xml, request = {}) {
  const items = parseRssItems(xml);
  return items.map((item) => {
    const titleRaw = extractTag(item, 'title');
    const source = extractTag(item, 'source');
    const { title, source: derivedSource } = splitTitleAndSource(titleRaw, source);
    const link = extractTag(item, 'link') || extractTag(item, 'guid');
    const publishedAt = isoDate(extractTag(item, 'isoDate') || extractTag(item, 'pubDate'));
    const date = (publishedAt || new Date().toISOString()).slice(0, 10);
    const base = slug(link || extractTag(item, 'guid') || title, 80);
    const jugador = String(request.jugador || '').trim();
    return {
      id_noticia: `${jugador || 'sin-jugador'}-${date}-${base}`,
      seleccion: String(request.seleccion || '').trim(),
      jugador,
      titular: title,
      fuente: derivedSource || String(request.source_name || 'RSS'),
      fecha_publicacion: publishedAt || new Date().toISOString(),
      link,
      snippet: stripHtml(extractTag(item, 'description') || extractTag(item, 'content:encoded')).slice(0, 1000),
      fuente_origen: String(request.source_kind || 'rss'),
      cluster_id: '',
      estado_revision: 'pendiente',
      fecha_detectada: new Date().toISOString(),
      tema_principal: '',
    };
  }).filter((row) => row.titular && row.link);
}

export function parseChannelFeed(xml, { channelId = '', feedUrl = '' } = {}) {
  const entries = parseAtomEntries(xml);
  const feedTitle = extractTag(xml, 'title');
  const resolvedId = channelId || extractTag(xml, 'yt:channelId') || '';
  const videos = entries.map((entry) => {
    const link = extractAttribute(entry, 'link', 'href') || extractTag(entry, 'link');
    const videoId = extractTag(entry, 'yt:videoId')
      || extractTag(entry, 'id').split(':').pop()
      || '';
    return {
      videoId,
      video_id: videoId,
      channelId: extractTag(entry, 'yt:channelId') || resolvedId,
      channel_id: extractTag(entry, 'yt:channelId') || resolvedId,
      title: extractTag(entry, 'title'),
      publishedAt: extractTag(entry, 'published'),
      published_at: extractTag(entry, 'published'),
      link: link || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : ''),
      liveStatus: 'none',
    };
  }).filter((video) => video.videoId);
  return { channelId: resolvedId, channel_id: resolvedId, title: feedTitle, feedUrl, videos };
}

async function fetchText(fetchImpl, url, timeoutMs) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    timeoutMs,
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*', 'user-agent': 'newsroom-local-adapters/0.1' },
  });
  const text = typeof response?.text === 'function' ? await response.text() : '';
  if (!response?.ok) {
    throw new AdapterError(`rss_http_${response?.status || 'error'}`, `RSS request failed (HTTP ${response?.status || 'unknown'})`);
  }
  return text;
}

/**
 * NewsSourcePort for Google News RSS. It parses the same fields the n8n RSS
 * node used to produce, without any API key.
 */
export class RssNewsSourceAdapter {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 30_000);
  }

  async fetchFeed(request = {}) {
    const feedUrl = typeof request === 'string' ? request : String(request.feed_url || request.feedUrl || '').trim();
    if (!feedUrl) throw new AdapterError('rss_feed_url_missing', 'Feed URL is required', { statusCode: 400 });
    const xml = await fetchText(this.fetchImpl, feedUrl, this.timeoutMs);
    return parseNewsFeed(xml, typeof request === 'string' ? {} : request);
  }
}

/**
 * ChannelFeedPort: YouTube's public channel RSS feed (`feeds/videos.xml`).
 * Replaces the YouTube Data API + WebSub path.
 */
export class RssChannelFeedAdapter {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 30_000, feedUrl = 'https://www.youtube.com/feeds/videos.xml' } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 30_000);
    this.feedUrl = feedUrl;
  }

  async fetchChannel({ channelId = '', url = '' } = {}) {
    const target = String(url || '').trim()
      || (channelId ? `${this.feedUrl}?channel_id=${encodeURIComponent(channelId)}` : '');
    if (!target) throw new AdapterError('channel_feed_missing_id', 'channelId or url is required', { statusCode: 400 });
    const xml = await fetchText(this.fetchImpl, target, this.timeoutMs);
    return parseChannelFeed(xml, { channelId, feedUrl: target });
  }
}
