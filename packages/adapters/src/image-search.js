import { AdapterError, fetchWithTimeout, readJsonResponse, trimBaseUrl } from './http.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const ALLOWED_EXTENSIONS = /\.(jpe?g|png|webp)(?:$|\?)/i;

function hostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function cleanTitle(value = '') {
  return String(value || '').replace(/^File:/i, '').replace(/_/g, ' ').trim();
}

function mapSearxngResult(result, index) {
  const imageUrl = String(result?.img_src || result?.thumbnail_src || '').trim();
  const link = String(result?.url || result?.source || '').trim();
  return {
    title: String(result?.title || result?.source || `Imagen ${index + 1}`).trim(),
    imageUrl,
    thumbnailUrl: String(result?.thumbnail_src || result?.img_src || '').trim(),
    link,
    domain: hostname(link) || String(result?.source || '').trim(),
    source: 'searxng',
    width: Number(result?.img_width || result?.width) || null,
    height: Number(result?.img_height || result?.height) || null,
    position: index + 1,
  };
}

export function mapWikimediaPages(payload, { limit = 100 } = {}) {
  const pages = payload?.query?.pages;
  const list = pages && typeof pages === 'object' ? Object.values(pages) : [];
  return list
    .map((page, index) => {
      const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
      if (!info) return null;
      const imageUrl = String(info.thumburl || info.url || '').trim();
      if (!imageUrl || !ALLOWED_EXTENSIONS.test(imageUrl)) return null;
      const license = String(info?.extmetadata?.LicenseShortName?.value || '').trim();
      return {
        title: cleanTitle(page?.title) || `Wikimedia image ${index + 1}`,
        imageUrl,
        thumbnailUrl: String(info.thumburl || info.url || '').trim(),
        link: String(info.descriptionurl || info.url || '').trim(),
        domain: 'commons.wikimedia.org',
        source: 'wikimedia-commons',
        license,
        width: Number(info.width) || null,
        height: Number(info.height) || null,
        position: index + 1,
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit) || 100));
}

/**
 * ImageSearchPort with two keyless providers:
 * - SearXNG (JSON enabled) for web image results,
 * - Wikimedia Commons for freely licensed reference images.
 *
 * Missing providers degrade to whichever one answered; only when both fail is
 * an error raised, which the publish use case records as `image_search_error`.
 */
export class SearxngWikimediaImageSearch {
  constructor({
    searxngUrl = 'http://127.0.0.1:8888',
    commonsUrl = COMMONS_API,
    useWikimedia = true,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  } = {}) {
    this.searxngUrl = trimBaseUrl(searxngUrl);
    this.commonsUrl = String(commonsUrl || COMMONS_API);
    this.useWikimedia = useWikimedia !== false;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 30_000);
  }

  async search({ query = '', limit = 100 } = {}) {
    const text = String(query || '').trim();
    if (!text) throw new AdapterError('image_query_missing', 'Image query is required', { statusCode: 400 });
    const max = Math.max(1, Math.min(Number(limit) || 100, 200));
    const sources = {};
    const images = [];

    if (this.searxngUrl) {
      try {
        const url = new URL(`${this.searxngUrl}/search`);
        url.searchParams.set('q', text);
        url.searchParams.set('format', 'json');
        url.searchParams.set('categories', 'images');
        url.searchParams.set('safesearch', '1');
        const response = await fetchWithTimeout(this.fetchImpl, url.toString(), {
          timeoutMs: this.timeoutMs,
          headers: { accept: 'application/json' },
        });
        const payload = await readJsonResponse(response, { adapter: 'searxng' });
        const found = (Array.isArray(payload?.results) ? payload.results : [])
          .map((item, index) => mapSearxngResult(item, index))
          .filter((item) => item.imageUrl);
        images.push(...found);
        sources.searxng = { status: 'ok', count: found.length };
      } catch (error) {
        sources.searxng = { status: 'error', error: String(error?.message || error).slice(0, 300) };
      }
    } else {
      sources.searxng = { status: 'not_configured' };
    }

    if (this.useWikimedia && images.length < max) {
      try {
        const url = new URL(this.commonsUrl);
        url.searchParams.set('action', 'query');
        url.searchParams.set('format', 'json');
        url.searchParams.set('generator', 'search');
        url.searchParams.set('gsrsearch', text);
        url.searchParams.set('gsrnamespace', '6');
        url.searchParams.set('gsrlimit', String(Math.min(max, 50)));
        url.searchParams.set('prop', 'imageinfo');
        url.searchParams.set('iiprop', 'url|size|extmetadata');
        url.searchParams.set('iiurlwidth', '800');
        const response = await fetchWithTimeout(this.fetchImpl, url.toString(), {
          timeoutMs: this.timeoutMs,
          headers: { accept: 'application/json', 'user-agent': 'newsroom-local-adapters/0.1' },
        });
        const payload = await readJsonResponse(response, { adapter: 'wikimedia' });
        const found = mapWikimediaPages(payload, { limit: max });
        images.push(...found);
        sources.wikimedia = { status: 'ok', count: found.length };
      } catch (error) {
        sources.wikimedia = { status: 'error', error: String(error?.message || error).slice(0, 300) };
      }
    } else {
      sources.wikimedia = { status: this.useWikimedia ? 'skipped' : 'not_configured' };
    }

    const seen = new Set();
    const deduped = [];
    for (const item of images) {
      const key = String(item.imageUrl || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...item, position: deduped.length + 1 });
      if (deduped.length >= max) break;
    }
    if (!deduped.length && !Object.values(sources).some((source) => source.status === 'ok')) {
      const errors = Object.values(sources).map((source) => source.error).filter(Boolean).join('; ');
      throw new AdapterError('image_search_unavailable', `No image provider answered: ${errors || 'not configured'}`);
    }
    return {
      images: deduped,
      meta: {
        provider: 'searxng+wikimedia',
        query: text,
        result_count: deduped.length,
        sources,
      },
    };
  }
}
