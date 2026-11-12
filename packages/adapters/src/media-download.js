import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { AdapterError } from './http.js';

const ALLOWED_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

export function validateYouTubeUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new AdapterError('invalid_url', 'Media URL must be an absolute http(s) URL', { statusCode: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AdapterError('invalid_url', 'Media URL must use http or https', { statusCode: 400 });
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AdapterError('invalid_url', 'Media URL host is not allowed', { statusCode: 400 });
  }
  return url.toString();
}

export function classifyYtDlpFailure(stderr = '') {
  const normalized = String(stderr || '').toLowerCase();
  if (/(live event will begin|premieres in|premiere will begin|not currently live|upcoming)/.test(normalized)) {
    return 'yt_dlp_live_pending';
  }
  if (/(copyright|blocked it|contains content from)/.test(normalized)) return 'yt_dlp_copyright_blocked';
  if (/(confirm your age|age-restricted|age restricted|inappropriate for some users)/.test(normalized)) {
    return 'yt_dlp_age_restricted';
  }
  if (/(video unavailable|private video|has been removed|removed by the uploader|this video is unavailable)/.test(normalized)) {
    return 'yt_dlp_private_or_removed';
  }
  if (/(not a bot|sign in to confirm)/.test(normalized)) return 'yt_dlp_bot_check';
  if (/(not available in your country|geo-restricted|geo restricted)/.test(normalized)) {
    return 'yt_dlp_geo_blocked';
  }
  return 'yt_dlp_failed';
}

/**
 * MediaDownloadPort: spawns the local `yt-dlp` binary. It replaces the Cloud
 * Run remote fetcher (service 11); the same guardrails (audio only, file-size
 * and duration limits, optional cookies) are kept.
 */
export class YtDlpMediaDownload {
  constructor({
    binary = 'yt-dlp',
    spawnImpl = nodeSpawn,
    timeoutMs = 30 * 60 * 1000,
    cookiesPath = '',
    maxFilesize = '2G',
    maxDurationSeconds = 7200,
    socketTimeoutSeconds = 30,
    retries = 3,
    fragmentRetries = 3,
    readdirImpl = readdir,
    mkdirImpl = mkdir,
  } = {}) {
    this.binary = binary;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 30 * 60 * 1000);
    this.cookiesPath = String(cookiesPath || '').trim();
    this.maxFilesize = String(maxFilesize || '').trim();
    this.maxDurationSeconds = Number(maxDurationSeconds) || 0;
    this.socketTimeoutSeconds = Number(socketTimeoutSeconds) || 0;
    this.retries = Number(retries) || 0;
    this.fragmentRetries = Number(fragmentRetries) || 0;
    this.readdirImpl = readdirImpl;
    this.mkdirImpl = mkdirImpl;
  }

  buildArgs(url, outputPattern) {
    const args = ['--no-playlist'];
    if (this.socketTimeoutSeconds > 0) args.push('--socket-timeout', String(this.socketTimeoutSeconds));
    if (this.retries >= 0) args.push('--retries', String(this.retries));
    if (this.fragmentRetries >= 0) args.push('--fragment-retries', String(this.fragmentRetries));
    if (this.cookiesPath) args.push('--cookies', this.cookiesPath);
    if (this.maxFilesize) args.push('--max-filesize', this.maxFilesize);
    if (this.maxDurationSeconds > 0) args.push('--match-filter', `duration <= ${Math.trunc(this.maxDurationSeconds)}`);
    args.push('--format', 'bestaudio/best', '--output', outputPattern, url);
    return args;
  }

  async download({ url = '', jobDir = '' } = {}) {
    const target = validateYouTubeUrl(url);
    const directory = String(jobDir || '').trim();
    if (!directory) throw new AdapterError('job_dir_missing', 'jobDir is required', { statusCode: 400 });
    await this.mkdirImpl(directory, { recursive: true });
    const outputPattern = join(directory, 'source.%(ext)s');
    const args = this.buildArgs(target, outputPattern);
    await new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = this.spawnImpl(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        rejectPromise(new AdapterError('yt_dlp_unavailable', `yt-dlp binary not found: ${this.binary}`, { cause: error }));
        return;
      }
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill?.('SIGKILL');
        rejectPromise(new AdapterError('yt_dlp_timeout', `yt-dlp timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on?.('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(new AdapterError('yt_dlp_unavailable', `yt-dlp binary not found: ${this.binary}`, { cause: error }));
      });
      child.on?.('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else rejectPromise(new AdapterError(classifyYtDlpFailure(stderr), stderr.trim() || `yt-dlp exited with code ${code}`));
      });
    });
    const files = (await this.readdirImpl(directory)).filter((name) => name.startsWith('source.'));
    if (!files.length) throw new AdapterError('yt_dlp_no_output', 'yt-dlp completed but did not create a source file');
    return { path: join(directory, files[0]), title: null };
  }
}
