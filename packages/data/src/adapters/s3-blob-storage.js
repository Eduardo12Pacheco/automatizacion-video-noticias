import { createHash, createHmac } from 'node:crypto';

import { BlobStoragePort } from '../ports/blob-storage-port.js';

function assertSafeKey(key) {
  const text = String(key ?? '').trim();
  if (!text) throw new Error('invalid blob key: empty');
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) throw new Error(`invalid blob key: ${text}`);
  if (text.includes('\\')) throw new Error(`invalid blob key: ${text}`);
  const segments = text.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`invalid blob key: ${text}`);
  }
  return text;
}

function normalizeContentType(value) {
  const text = String(value || '').split(';')[0].trim().toLowerCase();
  return text || 'application/octet-stream';
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new Error('blob data must be a Buffer, Uint8Array or string');
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

// AWS requires RFC 3986 encoding; encodeURIComponent leaves four characters
// unescaped that SigV4 expects to be percent-encoded.
export function uriEncode(value, { encodeSlash = false } = {}) {
  const encoded = encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (leftKey === rightKey
      ? leftValue.localeCompare(rightValue)
      : leftKey.localeCompare(rightKey)))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseListResponse(xml) {
  const contents = [];
  for (const match of String(xml || '').matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const field = (name) => {
      const found = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
      return found ? decodeXml(found[1]) : '';
    };
    const key = field('Key');
    if (!key) continue;
    contents.push({
      key,
      size: Number(field('Size')) || 0,
      content_type: 'application/octet-stream',
      created_at: field('LastModified') || null,
      etag: field('ETag').replace(/^"|"$/g, '') || null,
    });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
  return { contents, nextToken: truncated && token ? decodeXml(token[1]) : null };
}

/**
 * Optional S3-compatible blob storage adapter (MinIO, Garage, AWS S3).
 *
 * It implements the same port as `FsBlobStorage` and deliberately uses only
 * Node's crypto and fetch: the product ships without an AWS SDK, and the API
 * keeps serving blobs through `/panel/blobs/...` so the browser contract does
 * not change. Path-style addressing is used because MinIO expects it.
 */
export class S3BlobStorage extends BlobStoragePort {
  constructor({
    endpoint = 'http://127.0.0.1:9000',
    bucket = 'newsroom',
    region = 'us-east-1',
    accessKey = '',
    secretKey = '',
    publicPath = '/panel/blobs',
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  } = {}) {
    super();
    if (!bucket) throw new Error('S3 bucket is required');
    this.endpoint = String(endpoint || '').replace(/\/+$/, '');
    this.bucket = String(bucket);
    this.region = String(region || 'us-east-1');
    this.accessKey = String(accessKey || '');
    this.secretKey = String(secretKey || '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 30_000);
    this.publicPath = `/${String(publicPath || '/panel/blobs').replace(/^\/+|\/+$/g, '')}`;
  }

  getPublicUrl(key) {
    const safe = assertSafeKey(key);
    const encoded = safe.split('/').map((segment) => uriEncode(segment, { encodeSlash: true })).join('/');
    return `${this.publicPath}/${encoded}`;
  }

  #canonicalUri(key = '') {
    const suffix = key
      ? `/${String(key).split('/').map((segment) => uriEncode(segment, { encodeSlash: true })).join('/')}`
      : '';
    return `/${uriEncode(this.bucket)}${suffix}`;
  }

  #signedRequest({ method, key = '', searchParams = new URLSearchParams(), body = null, contentType = '' }) {
    const url = new URL(`${this.endpoint}${this.#canonicalUri(key)}`);
    for (const [name, value] of searchParams.entries()) url.searchParams.append(name, value);
    const canonicalUri = this.#canonicalUri(key);
    const query = canonicalQuery(url.searchParams);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payload = body == null ? Buffer.alloc(0) : body;
    const payloadHash = sha256Hex(payload);

    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${String(headers[name]).trim()}\n`)
      .join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = [
      method,
      canonicalUri,
      query,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretKey}`, dateStamp), this.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const requestHeaders = { ...headers, authorization };
    // `host` is set by fetch from the URL; duplicating it is harmless and
    // lets a caller supply a custom fetch implementation.
    delete requestHeaders.host;
    return {
      url,
      options: {
        method,
        headers: requestHeaders,
        ...(body == null ? {} : { body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
      payloadHash,
    };
  }

  async #request({ method, key = '', searchParams, body = null, contentType = '' }) {
    const { url, options } = this.#signedRequest({ method, key, searchParams, body, contentType });
    return this.fetchImpl(url.toString(), options);
  }

  async ensureBucket() {
    const response = await this.#request({ method: 'PUT' });
    if (response.ok || response.status === 409) return { ok: true, bucket: this.bucket };
    throw new Error(`S3 bucket ${this.bucket} is unavailable (HTTP ${response.status})`);
  }

  async verifyConnection() {
    try {
      const response = await this.#request({ method: 'HEAD' });
      if (response.ok) return { ok: true, bucket: this.bucket };
      return { ok: false, status: response.status, message: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, message: String(error?.message || error) };
    }
  }

  async put(key, data, { contentType = 'application/octet-stream' } = {}) {
    const safe = assertSafeKey(key);
    const bytes = toBuffer(data);
    const type = normalizeContentType(contentType);
    const response = await this.#request({ method: 'PUT', key: safe, body: bytes, contentType: type });
    if (!response.ok) throw new Error(`S3 put failed (HTTP ${response.status})`);
    return {
      key: safe,
      size: bytes.length,
      content_type: type,
      created_at: new Date().toISOString(),
      etag: sha256Hex(bytes),
      url: this.getPublicUrl(safe),
    };
  }

  async head(key) {
    const safe = assertSafeKey(key);
    const response = await this.#request({ method: 'HEAD', key: safe });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`S3 head failed (HTTP ${response.status})`);
    const size = Number(response.headers.get('content-length'));
    return {
      key: safe,
      size: Number.isFinite(size) ? size : null,
      content_type: response.headers.get('content-type') || 'application/octet-stream',
      created_at: response.headers.get('last-modified') || null,
      etag: String(response.headers.get('etag') || '').replace(/^"|"$/g, '') || null,
      url: this.getPublicUrl(safe),
    };
  }

  async get(key) {
    const safe = assertSafeKey(key);
    const response = await this.#request({ method: 'GET', key: safe });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`S3 get failed (HTTP ${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    const head = await this.head(safe);
    return {
      key: safe,
      data,
      size: data.length,
      content_type: head?.content_type || response.headers.get('content-type') || 'application/octet-stream',
      etag: head?.etag || null,
    };
  }

  async delete(key) {
    const safe = assertSafeKey(key);
    const response = await this.#request({ method: 'DELETE', key: safe });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`S3 delete failed (HTTP ${response.status})`);
    return true;
  }

  async list(prefix = '') {
    const base = String(prefix || '').replace(/^\/+|\/+$/g, '');
    if (base) assertSafeKey(base);
    const output = [];
    let continuationToken = '';
    do {
      const searchParams = new URLSearchParams({ 'list-type': '2' });
      if (base) searchParams.set('prefix', `${base}/`);
      if (continuationToken) searchParams.set('continuation-token', continuationToken);
      const response = await this.#request({ method: 'GET', searchParams });
      if (!response.ok) throw new Error(`S3 list failed (HTTP ${response.status})`);
      const parsed = parseListResponse(await response.text());
      for (const item of parsed.contents) {
        output.push({ ...item, content_type: 'application/octet-stream', url: this.getPublicUrl(item.key) });
      }
      continuationToken = parsed.nextToken || '';
    } while (continuationToken);
    return output;
  }
}
