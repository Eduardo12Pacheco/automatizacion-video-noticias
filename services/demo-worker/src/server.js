#!/usr/bin/env node
/**
 * Deterministic CPU-only demo worker for the default Compose profile.
 *
 * It implements the public shapes of the TTS orchestrator, the subtitles
 * service and the renderer used by apps/panel. The real workers are opt-in
 * (gpu profile); this adapter exists so `docker compose up` can walk one story
 * without keys, a GPU or multi-gigabyte model downloads.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_VIDEO = resolve(ROOT, 'examples/brand/final-demo.mp4');
const JSON_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 64 * 1024 * 1024;

const DEMO_SEGMENTS = Object.freeze([
  {
    id: 'demo-segment-1',
    start_ms: 0,
    end_ms: 3200,
    source_text: 'Aurenia ajusta su mediocampo para el próximo partido.',
    translated_text: 'Aurenia ajusta su mediocampo para el próximo partido.',
    style: { font_size: 110, font_family: 'Khand', color: '#FFFFFF', align: 'left', max_width_px: 1080 },
  },
  {
    id: 'demo-segment-2',
    start_ms: 3200,
    end_ms: 7000,
    source_text: 'Nicolás Arbelo vuelve a ser el eje del equipo.',
    translated_text: 'Nicolás Arbelo vuelve a ser el eje del equipo.',
    style: { font_size: 110, font_family: 'Khand', color: '#FFFFFF', align: 'left', max_width_px: 1080 },
  },
]);

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, text, headers = {}) {
  const payload = Buffer.from(String(text));
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(payload);
}

function readBody(req, limit = JSON_LIMIT) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buffer = await readBody(req);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
  }
}

function wavBuffer({ seconds = 1.2, sampleRate = 16000 } = {}) {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 6000);
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function parseUrl(req) {
  return new URL(req.url || '/', 'http://demo-worker.local');
}

function jsonData(data) {
  return { ok: true, data };
}

export function createDemoWorkerServer({
  host = '0.0.0.0',
  port = 8088,
  videoPath = process.env.DEMO_VIDEO_PATH || DEFAULT_VIDEO,
  logger = console,
} = {}) {
  const ttsJobs = new Map();
  const subtitleSessions = new Map();
  const projects = new Map();
  let videoBytes = null;

  function demoVideo() {
    if (!videoBytes) {
      try {
        videoBytes = readFileSync(videoPath);
      } catch (error) {
        logger.error?.(`demo-worker: demo video not found at ${videoPath}: ${error.message}`);
        videoBytes = Buffer.alloc(0);
      }
    }
    return videoBytes;
  }

  function sendVideo(res) {
    const bytes = demoVideo();
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    });
    res.end(bytes);
  }

  function sendWav(res) {
    const bytes = wavBuffer();
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
    });
    res.end(bytes);
  }

  function ttsJobView(job) {
    return {
      job_id: job.job_id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      title: job.title,
      created_at: job.created_at,
      updated_at: job.updated_at,
      download_ready: true,
    };
  }

  function sessionView(session) {
    return {
      id: session.session_id,
      session_id: session.session_id,
      status: session.status,
      display_name: session.display_name,
      current_snapshot_version: session.version,
      preview: {
        video_url: `/api/subtitles/sessions/${session.session_id}/preview/video`,
        duration_ms: 7000,
      },
      download: { ready: session.render_status === 'succeeded' },
      created_at: session.created_at,
      updated_at: session.updated_at,
    };
  }

  async function handleTts(req, res, url) {
    if (url.pathname === '/health' || url.pathname === '/api/tts/healthz') {
      sendJson(res, 200, { status: 'ok', service: 'demo-tts' });
      return true;
    }
    if (url.pathname === '/api/tts/jobs' && req.method === 'GET') {
      sendJson(res, 200, { items: [...ttsJobs.values()].map(ttsJobView) });
      return true;
    }
    if (url.pathname === '/api/tts/jobs' && req.method === 'POST') {
      const body = await readJson(req);
      const text = String(body.text || '').trim();
      if (text.length < 20) {
        sendJson(res, 400, { error: { code: 'validation_error', message: 'text is too short' } });
        return true;
      }
      const jobId = `tts-demo-${randomUUID()}`;
      const job = {
        job_id: jobId,
        status: 'done',
        stage: 'completed',
        progress: { stage: 'completed', percent: 100 },
        title: String(body.title || 'demo'),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      ttsJobs.set(jobId, job);
      sendJson(res, 202, { job_id: jobId, status: 'done', created_at: job.created_at });
      return true;
    }
    const jobMatch = url.pathname.match(/^\/api\/tts\/jobs\/([^/]+)(?:\/(events|download))?$/);
    if (jobMatch?.[1]) {
      const job = ttsJobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'job not found' } });
        return true;
      }
      if (jobMatch[2] === 'download') {
        sendWav(res);
        return true;
      }
      if (jobMatch[2] === 'events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`event: status\ndata: ${JSON.stringify(ttsJobView(job))}\n\n`);
        res.end();
        return true;
      }
      sendJson(res, 200, ttsJobView(job));
      return true;
    }
    return false;
  }

  async function handleSubtitles(req, res, url) {
    if (url.pathname === '/api/subtitles/health') {
      sendJson(res, 200, { status: 'online', message: 'Demo subtitles ready' });
      return true;
    }
    if (url.pathname === '/api/subtitles/sessions' && req.method === 'POST') {
      await readBody(req, UPLOAD_LIMIT);
      const sessionId = `demo-subtitles-${randomUUID()}`;
      const session = {
        session_id: sessionId,
        display_name: 'Demo story',
        status: 'editing',
        version: 1,
        render_status: 'idle',
        segments: structuredClone(DEMO_SEGMENTS),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      subtitleSessions.set(sessionId, session);
      sendJson(res, 201, sessionView(session));
      return true;
    }
    if (url.pathname === '/api/subtitles/sessions' && req.method === 'GET') {
      sendJson(res, 200, { items: [...subtitleSessions.values()].map(sessionView) });
      return true;
    }
    const sessionMatch = url.pathname.match(/^\/api\/subtitles\/sessions\/([^/]+)(?:\/(segments|render|download|download\/file|preview\/video))?$/);
    if (!sessionMatch?.[1]) return false;
    const session = subtitleSessions.get(decodeURIComponent(sessionMatch[1]));
    if (!session) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'session not found' } });
      return true;
    }
    const suffix = sessionMatch[2] || '';
    if (suffix === 'segments' && req.method === 'GET') {
      sendJson(res, 200, { version: session.version, segments: session.segments });
      return true;
    }
    if (suffix === 'segments' && (req.method === 'PUT' || req.method === 'PATCH')) {
      const body = await readJson(req);
      if (Array.isArray(body.segments)) session.segments = body.segments;
      session.version += 1;
      session.updated_at = nowIso();
      sendJson(res, 200, { version: session.version, segments: session.segments });
      return true;
    }
    if (suffix === 'render' && req.method === 'POST') {
      await readJson(req).catch(() => ({}));
      session.render_status = 'succeeded';
      session.updated_at = nowIso();
      sendJson(res, 202, {
        job: { id: `demo-subtitle-render-${session.session_id}`, status: 'succeeded', progress_percent: 100 },
        download: { ready: true },
      });
      return true;
    }
    if (suffix === 'render' && req.method === 'GET') {
      sendJson(res, 200, {
        job: { id: `demo-subtitle-render-${session.session_id}`, status: session.render_status === 'succeeded' ? 'succeeded' : 'queued', progress_percent: session.render_status === 'succeeded' ? 100 : 0 },
        download: { ready: session.render_status === 'succeeded' },
      });
      return true;
    }
    if (suffix === 'download/file') {
      sendVideo(res);
      return true;
    }
    if (suffix === 'download') {
      sendJson(res, 200, { ready: true, url: `/api/subtitles/sessions/${session.session_id}/download/file` });
      return true;
    }
    if (suffix === 'preview/video') {
      sendVideo(res);
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, sessionView(session));
      return true;
    }
    if (req.method === 'DELETE') {
      subtitleSessions.delete(session.session_id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (body.display_name) session.display_name = String(body.display_name);
      sendJson(res, 200, sessionView(session));
      return true;
    }
    return false;
  }

  async function handleProjects(req, res, url) {
    if (url.pathname === '/api/projects/create-from-approval' && req.method === 'POST') {
      await readJson(req).catch(() => ({}));
      const projectId = `demo-render-${randomUUID()}`;
      const project = { project_id: projectId, status: 'queued', created_at: nowIso() };
      projects.set(projectId, project);
      sendJson(res, 201, { ok: true, data: project });
      return true;
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(render-final|render-preview|status|download\/final|download\/preview))?$/);
    if (!projectMatch?.[1]) return false;
    const project = projects.get(decodeURIComponent(projectMatch[1]));
    if (!project) {
      sendJson(res, 404, { ok: false, error: { message: 'project not found' } });
      return true;
    }
    const suffix = projectMatch[2] || '';
    if ((suffix === 'render-final' || suffix === 'render-preview') && req.method === 'POST') {
      project.status = 'done';
      project.output = suffix === 'render-final' ? `/api/projects/${project.project_id}/download/final` : `/api/projects/${project.project_id}/download/preview`;
      sendJson(res, 200, jsonData({ status: 'queued', project_id: project.project_id }));
      return true;
    }
    if (suffix === 'status') {
      sendJson(res, 200, jsonData({ status: project.status, project_id: project.project_id, output: project.output || '' }));
      return true;
    }
    if (suffix === 'download/final' || suffix === 'download/preview') {
      sendVideo(res);
      return true;
    }
    sendJson(res, 200, jsonData(project));
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = parseUrl(req);
      if (await handleTts(req, res, url)) return;
      if (await handleSubtitles(req, res, url)) return;
      if (await handleProjects(req, res, url)) return;
      if (url.pathname === '/health' || url.pathname === '/healthz' || url.pathname === '/ready') {
        sendJson(res, 200, { status: 'ok', service: 'demo-worker' });
        return;
      }
      sendJson(res, 404, { error: { code: 'not_found', message: 'route not found' } });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (!res.headersSent) sendJson(res, status, { error: { code: status === 400 ? 'invalid_request' : 'internal_error', message: error.message } });
      else res.end();
    }
  });
  server.listen(port, host);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.DEMO_WORKER_PORT || 8088);
  createDemoWorkerServer({ port, host: process.env.DEMO_WORKER_HOST || '0.0.0.0' });
  console.info(`demo-worker listening on ${port}`);
}
