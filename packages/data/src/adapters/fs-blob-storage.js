import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

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

export class FsBlobStorage extends BlobStoragePort {
  #root;
  #publicPath;

  constructor({ root = process.env.BLOB_ROOT || './data/blobs', publicPath = '/panel/blobs' } = {}) {
    super();
    this.#root = root;
    this.#publicPath = `/${String(publicPath || '/panel/blobs').replace(/^\/+|\/+$/g, '')}`;
  }

  get root() {
    return this.#root;
  }

  #objectPath(key) {
    return join(this.#root, 'objects', key);
  }

  #metaPath(key) {
    return join(this.#root, 'meta', `${key}.json`);
  }

  getPublicUrl(key) {
    const safe = assertSafeKey(key);
    const encoded = safe.split('/').map(encodeURIComponent).join('/');
    return `${this.#publicPath}/${encoded}`;
  }

  async put(key, data, { contentType = 'application/octet-stream' } = {}) {
    const safe = assertSafeKey(key);
    const bytes = toBuffer(data);
    const meta = {
      key: safe,
      size: bytes.length,
      content_type: normalizeContentType(contentType),
      created_at: new Date().toISOString(),
      etag: createHash('sha256').update(bytes).digest('hex'),
    };

    const objectPath = this.#objectPath(safe);
    const metaPath = this.#metaPath(safe);
    await mkdir(dirname(objectPath), { recursive: true });
    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(objectPath, bytes);
    await writeFile(metaPath, JSON.stringify(meta, null, 2));

    return { ...meta, url: this.getPublicUrl(safe) };
  }

  async head(key) {
    const safe = assertSafeKey(key);
    try {
      const meta = JSON.parse(await readFile(this.#metaPath(safe), 'utf8'));
      return { ...meta, url: this.getPublicUrl(safe) };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        try {
          const info = await stat(this.#objectPath(safe));
          return {
            key: safe,
            size: info.size,
            content_type: 'application/octet-stream',
            created_at: info.mtime.toISOString(),
            etag: null,
            url: this.getPublicUrl(safe),
          };
        } catch {
          return null;
        }
      }
      throw error;
    }
  }

  async get(key) {
    const safe = assertSafeKey(key);
    try {
      const data = await readFile(this.#objectPath(safe));
      const head = await this.head(safe);
      return {
        key: safe,
        data,
        size: data.length,
        content_type: head?.content_type || 'application/octet-stream',
        etag: head?.etag || null,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key) {
    const safe = assertSafeKey(key);
    const before = await this.head(safe);
    await rm(this.#objectPath(safe), { force: true });
    await rm(this.#metaPath(safe), { force: true });
    return Boolean(before);
  }

  async list(prefix = '') {
    const base = String(prefix || '').replace(/^\/+|\/+$/g, '');
    if (base) assertSafeKey(base);
    const objectsRoot = join(this.#root, 'objects');
    const output = [];
    await this.#walk(objectsRoot, '', output);
    return output
      .filter((entry) => (base ? entry.key === base || entry.key.startsWith(`${base}/`) : true))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async #walk(directory, relative, output) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const nextRelative = relative ? posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await this.#walk(join(directory, entry.name), nextRelative, output);
        continue;
      }
      const head = await this.head(nextRelative);
      if (head) output.push(head);
    }
  }
}
