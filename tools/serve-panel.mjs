#!/usr/bin/env node
/**
 * Minimal static server for the panel, used by the visual-QA Playwright spec.
 * It serves `apps/panel` only (no directory listing) and never leaves the repo.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../apps/panel', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PANEL_PORT || 8154);
const HOST = process.env.PANEL_HOST || '127.0.0.1';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
});

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = resolve(join(ROOT, relative === '/' ? 'index.html' : relative));
  return target.startsWith(ROOT) ? target : null;
}

const server = createServer((request, response) => {
  const target = safePath(request.url || '/');
  if (!target) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = statSync(target);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  console.log(`panel static server: http://${address.address}:${address.port}/?showcase=1`);
});
