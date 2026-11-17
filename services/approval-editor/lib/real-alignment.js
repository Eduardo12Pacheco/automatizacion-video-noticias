const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { alignPhrasesToTranscript } = require("@newsroom/contracts/approval-contract-pipeline");

const WHISPER_DERIVATIVE_FILE = 'voice-whisper-16khz-mono.wav';
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000;
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 20 * 60 * 1000;
// The approval editor only owns its own module root. It never reaches into
// another workspace service for binaries; ffmpeg comes from PATH (the Compose
// image installs it) or from an explicit FFMPEG_PATH override.
const APPROVAL_EDITOR_ROOT = path.resolve(__dirname, '..');

function createAlignmentError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

function resolveRemoteUrl(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry.trim();
  return (entry.public_url || entry.publicUrl || entry.url || entry.storage_public_url || entry.file_url || '').toString().trim();
}

function sanitizeAudioExtension(remoteUrl, contentType = '') {
  const content = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (content === 'audio/mpeg') return '.mp3';
  if (content === 'audio/mp4' || content === 'audio/aac') return '.m4a';
  if (content === 'audio/wav' || content === 'audio/x-wav') return '.wav';
  try {
    const ext = path.extname(new URL(remoteUrl).pathname).toLowerCase();
    if (['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.webm'].includes(ext)) return ext;
  } catch {}
  return '.wav';
}

async function downloadRemoteBinary(fetchImpl, remoteUrl, { timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS } = {}) {
  let parsed;
  try {
    parsed = new URL(String(remoteUrl || ''));
  } catch {
    throw createAlignmentError('invalid_remote_audio_url', `Invalid voice audio URL: ${remoteUrl || ''}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createAlignmentError('invalid_remote_audio_url', `Invalid voice audio URL protocol: ${parsed.protocol}`);
  }
  if (!fetchImpl) throw createAlignmentError('remote_audio_download_failed', 'fetch implementation is required for voice audio download');
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(parsed.toString(), controller ? { signal: controller.signal } : {});
    if (!response.ok) throw createAlignmentError('remote_audio_download_failed', `Voice audio download failed with ${response.status}`);
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: String(response.headers?.get?.('content-type') || ''),
    };
  } catch (error) {
    if (error.code) throw error;
    throw createAlignmentError('remote_audio_download_failed', `Voice audio download failed: ${error.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveFfmpegPath({ env = process.env, moduleRoot = APPROVAL_EDITOR_ROOT } = {}) {
  if (env.FFMPEG_PATH && fs.existsSync(env.FFMPEG_PATH)) return env.FFMPEG_PATH;
  for (const candidate of [path.join(moduleRoot, 'node_modules', 'ffmpeg-static'), 'ffmpeg-static']) {
    try {
      const resolved = require(candidate);
      if (resolved) return resolved;
    } catch {}
  }
  // Compose installs ffmpeg; a local checkout usually has it on PATH too.
  return 'ffmpeg';
}

function writeAudioDerivative16kMono({ inputPath, outputPath, env = process.env, moduleRoot = APPROVAL_EDITOR_ROOT }) {
  const ffmpegPath = resolveFfmpegPath({ env, moduleRoot });
  const result = spawnSync(ffmpegPath, ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', outputPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw createAlignmentError('ffmpeg_unavailable', `FFmpeg execution failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw createAlignmentError('audio_derivative_failed', `FFmpeg failed generating Whisper derivative: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function buildScriptPhrasesForAlignment(segments = []) {
  return segments.map((segment, index) => ({
    id: index + 1,
    phrase: String(segment.phrase || '').trim() || `Segmento ${index + 1}`,
    image: '__APPROVAL_EDITOR_PLACEHOLDER__',
  }));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

function splitSegmentWords(text, start, end) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const span = Math.max(0, Number(end) - Number(start));
  const weights = tokens.map((token) => Math.max(1, token.length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const words = [];
  let cursor = Number(start);
  for (let index = 0; index < tokens.length; index += 1) {
    const duration = (span * weights[index]) / total;
    words.push({ word: tokens[index], start: roundTime(cursor), end: roundTime(cursor + duration), confidence: 0 });
    cursor += duration;
  }
  return words;
}

/**
 * Calls the ASR worker through its HTTP contract. The worker owns the Whisper
 * model, the GPU slot and the CPU fallback; the approval editor only sends a
 * filesystem path that must be reachable from the worker (Compose mounts the
 * same `newsroom_media` volume into both containers).
 */
async function transcribeWithAsrWorker({
  audioPath,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TRANSCRIBE_TIMEOUT_MS,
} = {}) {
  const resolvedPath = path.resolve(String(audioPath || ''));
  if (!resolvedPath) throw createAlignmentError('missing_voice_audio', 'audioPath is required for ASR alignment');
  const baseUrl = String(env.ASR_WORKER_URL || env.STT_ASR_WORKER_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  if (!fetchImpl) throw createAlignmentError('alignment_pipeline_failed', 'fetch implementation is required for ASR alignment');
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let payload;
  try {
    const response = await fetchImpl(`${baseUrl}/api/radar/transcribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.TRANSCRIPT_SERVICE_API_KEY ? { 'x-api-key': env.TRANSCRIPT_SERVICE_API_KEY } : {}),
      },
      body: JSON.stringify({ audio_path: resolvedPath }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw createAlignmentError('alignment_pipeline_failed', `asr-worker HTTP ${response.status}: ${detail.slice(0, 500)}`);
    }
    payload = await response.json();
  } catch (error) {
    if (error.code) throw error;
    throw createAlignmentError('alignment_pipeline_failed', `asr-worker unavailable at ${baseUrl}: ${error.message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const segments = [];
  const words = [];
  for (const [index, segment] of (Array.isArray(payload?.segments) ? payload.segments : []).entries()) {
    const text = String(segment?.text || '').trim();
    if (!text) continue;
    const start = Number(segment.start_ms || 0) / 1000;
    const end = Number(segment.end_ms || 0) / 1000;
    const segmentWords = splitSegmentWords(text, start, end);
    words.push(...segmentWords);
    segments.push({ id: index + 1, text, start: roundTime(start), end: roundTime(end), words: segmentWords });
  }
  return {
    backend: 'whisper',
    requestedBackend: 'whisper',
    notes: [`asr-worker ${baseUrl}`],
    segments,
    words,
    totalDurationSeconds: words.length ? words[words.length - 1].end : 0,
  };
}

function alignSegmentsToTranscript({ segments = [], transcript }) {
  const scriptPhrases = buildScriptPhrasesForAlignment(segments);
  const aligned = alignPhrasesToTranscript(scriptPhrases, transcript);
  if (!aligned?.phrases?.length || aligned.phrases.length < segments.length) {
    throw createAlignmentError('alignment_incomplete', 'Whisper transcript did not produce timings for every phrase');
  }
  return {
    alignedTimings: aligned,
    alignmentStatus: { status: 'ready', source: 'whisper-alignment', generatedAt: nowIso(), transcriptBackend: transcript?.backend || 'unknown' },
    segments: segments.map((segment, index) => ({
      ...segment,
      startTime: aligned.phrases[index].startTime,
      endTime: aligned.phrases[index].endTime,
      alignment: aligned.phrases[index].alignment || null,
      timingSource: 'whisper-alignment',
    })),
  };
}

async function prepareRealVoiceAlignment({ projectDir, projectId, voiceAudio, segments, env = process.env, fetchImpl = globalThis.fetch, transcribeImpl, moduleRoot = APPROVAL_EDITOR_ROOT } = {}) {
  const remoteUrl = resolveRemoteUrl(voiceAudio);
  if (!remoteUrl) throw createAlignmentError('missing_voice_audio', 'voice_audio.public_url is required for Whisper alignment');
  const audioDir = path.join(projectDir, 'audio');
  const outputDir = path.join(projectDir, 'output');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const download = await downloadRemoteBinary(fetchImpl, remoteUrl);
  const voiceExt = sanitizeAudioExtension(remoteUrl, download.contentType);
  const originalPath = path.join(audioDir, `voice-original${voiceExt}`);
  // The ASR worker must read the derivative, so when the services run in
  // separate containers this directory is a shared volume path.
  const alignmentDir = env.APPROVAL_EDITOR_ALIGNMENT_ROOT
    ? path.join(String(env.APPROVAL_EDITOR_ALIGNMENT_ROOT), path.basename(projectDir))
    : audioDir;
  fs.mkdirSync(alignmentDir, { recursive: true });
  const whisperPath = path.join(alignmentDir, WHISPER_DERIVATIVE_FILE);
  const transcriptPath = path.join(outputDir, 'transcript.json');
  const phraseTimestampsPath = path.join(outputDir, 'phrase-timestamps.json');
  fs.writeFileSync(originalPath, download.bytes);
  writeAudioDerivative16kMono({ inputPath: originalPath, outputPath: whisperPath, env, moduleRoot });

  const scriptPhrases = { phrases: buildScriptPhrasesForAlignment(segments) };
  writeJson(path.join(outputDir, 'script-phrases.json'), scriptPhrases);
  const transcribeResult = transcribeImpl
    ? { transcript: await transcribeImpl({ whisperPath, transcriptPath, projectDir, projectId, env }) }
    : { transcript: await transcribeWithAsrWorker({ audioPath: whisperPath, env, fetchImpl }) };
  const aligned = alignSegmentsToTranscript({ segments, transcript: transcribeResult.transcript });
  writeJson(phraseTimestampsPath, {
    totalDurationSeconds: aligned.alignedTimings.totalDurationSeconds,
    transcriptBackend: transcribeResult.transcript?.backend || 'unknown',
    diagnostics: aligned.alignedTimings.diagnostics || {},
    phrases: aligned.alignedTimings.phrases,
  });
  return {
    ...aligned,
    paths: {
      originalVoicePath: originalPath,
      whisperPath,
      transcriptPath,
      phraseTimestampsPath,
    },
  };
}

module.exports = {
  WHISPER_DERIVATIVE_FILE,
  alignSegmentsToTranscript,
  prepareRealVoiceAlignment,
  resolveFfmpegPath,
  transcribeWithAsrWorker,
};
