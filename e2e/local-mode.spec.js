import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local-mode happy path (D10).
 *
 * Opt-in because it needs the real CPU worker stack: Ollama + Piper +
 * faster-whisper + Remotion. Run it after
 *   docker compose --profile local up -d
 * with NEWSROOM_E2E_LOCAL=1 and a downloaded local model set.
 *
 * The renderer needs to fetch the synthesized voice and the image. The test
 * starts a throwaway static server container on the Compose network, mounted
 * on the test work dir, so the URLs are reachable from the renderer without
 * routing back to the host.
 */

const EDITOR_EMAIL = process.env.E2E_EDITOR_EMAIL || 'editor@example.local';
const EDITOR_PASSWORD = process.env.E2E_EDITOR_PASSWORD || 'e2e-demo-password';
const ORIGIN = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080';
const SCRIPT_TEXT = [
  'La selección de Aurenia ajusta su mediocampo para el próximo partido.',
  'Nicolás Andrade vuelve a entrenar con el grupo y será el eje del equipo.',
  'El cuerpo técnico probó una salida más rápida por las bandas durante la práctica del martes.',
].join(' ');
const SEGMENTS = [
  'La selección de Aurenia ajusta su mediocampo para el próximo partido.',
  'Nicolás Andrade vuelve a entrenar con el grupo y será el eje del equipo.',
  'El cuerpo técnico probó una salida más rápida por las bandas.',
];

test.skip(!process.env.NEWSROOM_E2E_LOCAL, 'local-mode E2E needs NEWSROOM_E2E_LOCAL=1 and the real CPU worker stack (Ollama, Piper, faster-whisper, Remotion)');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function ffprobe(filePath) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath]));
}

function meanVolumeDb(filePath) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return Number((output.match(/mean_volume:\s*(-?[\d.]+) dB/) || [])[1] ?? Number.NaN);
}

async function json(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`expected JSON from ${response.url()} (HTTP ${response.status()}): ${text.slice(0, 300)}`);
  }
  if (!response.ok()) throw new Error(`request failed: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(check, { timeout = 10 * 60_000, interval = 1000, message = 'condition not met' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(message);
}

function startFixtureServer(state, workDir) {
  const containerName = `newsroom-e2e-fixtures-${process.pid}`;
  try {
    execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  } catch {
    // No previous container with this name; nothing to clean.
  }
  const network = process.env.E2E_FIXTURE_NETWORK || 'newsroom_default';
  const image = process.env.E2E_FIXTURE_IMAGE || 'python:3.12-slim';
  execFileSync('docker', [
    'run', '--rm', '-d',
    '--name', containerName,
    '--network', network,
    '-v', `${workDir}:/srv:ro`,
    image,
    'python', '-m', 'http.server', '8000', '--directory', '/srv',
  ], { stdio: 'pipe' });
  state.containerName = containerName;
  return `http://${containerName}:8000`;
}

test('local mode discovers, drafts with a real LLM, voices, subtitles and renders 720p media', async ({ page }) => {
  test.setTimeout(25 * 60_000);
  const workDir = mkdtempSync(join(tmpdir(), 'newsroom-local-e2e-'));
  const fixture = { containerName: '' };
  const baseFixture = startFixtureServer(fixture, workDir);
  const request = page.request;
  const mutation = { headers: { origin: ORIGIN } };

  try {
    // The renderer downloads these fixtures; generate the music bed up front
    // and the still image from the committed demo brand asset.
    const musicPath = join(workDir, 'music.wav');
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-ar', '44100', musicPath]);
    const musicBytes = readFileSync(musicPath);
    writeFileSync(join(workDir, 'music.wav'), musicBytes);
    writeFileSync(join(workDir, 'image.png'), readFileSync('examples/brand/logo-demo.png'));

    await page.goto('/');
    await expect(page.locator('#authGate')).toBeVisible();
    await page.locator('#authUser').fill(EDITOR_EMAIL);
    await page.locator('#authPass').fill(EDITOR_PASSWORD);
    await page.locator('#authForm button[type="submit"]').click();
    await expect(page.locator('#appShell')).toBeVisible();

    const pending = await json(await request.get('/panel/read-models/approval/pending'));
    expect(Array.isArray(pending.items)).toBe(true);
    expect(pending.items.length).toBeGreaterThan(0);
    const clusterId = pending.items[0].cluster_id;
    const topic = await json(await request.get(`/webhook/approval/topic/supabase/v2?cluster_id=${encodeURIComponent(clusterId)}`));
    const sourceId = topic.item?.sources?.[0]?.id_noticia;
    expect(sourceId).toBeTruthy();

    const decision = await json(await request.post('/webhook/approval/decision/supabase/v2', {
      ...mutation,
      data: { cluster_id: clusterId, id_noticia: sourceId, action: 'approve' },
    }));
    expect(decision.enqueued).toBe(true);

    const draft = await waitFor(async () => {
      const payload = await json(await request.get('/panel/read-models/scripts/drafts'));
      return (payload.drafts || []).find((item) => item.cluster_id === clusterId) || null;
    }, { timeout: 10 * 60_000, message: 'the real LLM did not produce a script draft' });
    const draftText = String(draft.guion_editado || draft.guion_draft || '').trim();
    expect(draftText.split(/\s+/).length).toBeGreaterThan(40);

    const tts = await json(await request.post('/tts/api/tts/jobs', {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: { text: SCRIPT_TEXT, voice_profile: 'balanced_default', title: 'e2e local' },
    }));
    const ttsStatus = await waitFor(async () => {
      const job = await json(await request.get(`/tts/api/tts/jobs/${encodeURIComponent(tts.job_id)}`));
      return ['done', 'succeeded', 'completed'].includes(String(job.status).toLowerCase()) ? job : null;
    }, { message: 'Piper did not synthesize the voice' });
    expect(ttsStatus.status).toBeTruthy();

    const wavResponse = await waitFor(async () => {
      const response = await request.get(`/tts/api/tts/jobs/${encodeURIComponent(tts.job_id)}/download`);
      return response.ok() ? response : null;
    }, { message: 'the synthesized WAV was not downloadable' });
    const voicePath = join(workDir, 'voice.wav');
    writeFileSync(voicePath, await wavResponse.body());
    const voiceProbe = ffprobe(voicePath);
    expect(Number(voiceProbe.format.duration)).toBeGreaterThanOrEqual(3);
    expect(meanVolumeDb(voicePath)).toBeGreaterThan(-60);
    writeFileSync(join(workDir, 'voice.wav'), readFileSync(voicePath));

    const subtitleSource = join(workDir, 'subtitle-source.mp4');
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=8', '-i', voicePath, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', subtitleSource]);
    const subtitles = await json(await request.post('/subtitles/api/subtitles/sessions', {
      ...mutation,
      multipart: {
        source_language: 'auto',
        target_language: 'es',
        video: { name: 'local-e2e.mp4', mimeType: 'video/mp4', buffer: readFileSync(subtitleSource) },
      },
    }));
    const segmentsPayload = await waitFor(async () => {
      const response = await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/segments`);
      if (!response.ok()) return null;
      const payload = await response.json();
      return (payload.segments || payload.items || []).length >= 3 ? payload : null;
    }, { message: 'faster-whisper did not produce at least three subtitle cues' });
    const cues = segmentsPayload.segments || segmentsPayload.items;
    expect(cues.length).toBeGreaterThanOrEqual(3);
    const cueText = cues.map((cue) => String(cue.translated_text || cue.text || cue.source_text || '')).join(' ').toLowerCase();
    const scriptWords = new Set(draftText.toLowerCase().split(/\W+/).filter((word) => word.length >= 4));
    expect([...scriptWords].some((word) => cueText.includes(word))).toBe(true);

    const session = await json(await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}`));
    const subtitleRender = await json(await request.post(
      `/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/render`,
      { ...mutation, headers: { ...mutation.headers, 'content-type': 'application/json' }, data: { base_version: session.current_snapshot_version } },
    ));
    expect(subtitleRender.job).toBeTruthy();
    await waitFor(async () => {
      const payload = await json(await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/render`));
      return String(payload.job?.status).toLowerCase() === 'succeeded';
    }, { message: 'Remotion did not render the subtitles video' });
    const subtitlesVideo = await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/download/file`);
    expect(subtitlesVideo.ok()).toBeTruthy();
    const subtitlesVideoPath = join(workDir, 'subtitles.mp4');
    writeFileSync(subtitlesVideoPath, await subtitlesVideo.body());
    expect(ffprobe(subtitlesVideoPath).streams.some((stream) => stream.codec_name === 'h264')).toBe(true);

    const created = await json(await request.post('/remotion/api/projects/create-from-approval', {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: {
        draft_id: draft.draft_id,
        title: draft.titulo_noticia || 'Local E2E',
        segments: SEGMENTS.map((phrase, index) => ({ id: `segment-${index + 1}`, phrase })),
        voice_audio: { public_url: `${baseFixture}/voice.wav`, name: 'voice.wav', mime_type: 'audio/wav' },
        background_audio: { public_url: `${baseFixture}/music.wav`, name: 'music.wav', mime_type: 'audio/wav' },
        selected_images: SEGMENTS.map((_phrase, index) => ({
          id: `image-${index + 1}`,
          label: `Demo still ${index + 1}`,
          public_url: `${baseFixture}/image.png`,
          width: 1080,
          height: 1080,
        })),
      },
    }));
    const project = created.data || created;
    const projectId = project.projectId || project.project_id;
    expect(projectId).toBeTruthy();
    expect(project.snapshotHash).toBeTruthy();
    await json(await request.post(`/remotion/api/projects/${encodeURIComponent(projectId)}/render-final`, {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: { snapshotHash: project.snapshotHash, async: true },
    }));
    await waitFor(async () => {
      const payload = await json(await request.get(`/remotion/api/projects/${encodeURIComponent(projectId)}/status`));
      const status = payload.data || payload;
      return String(status.render?.status || status.status).toLowerCase() === 'rendered';
    }, { timeout: 20 * 60_000, message: 'Remotion did not render the final local video' });

    const finalVideo = await request.get(`/remotion/api/projects/${encodeURIComponent(projectId)}/download/final?download=1`);
    expect(finalVideo.ok()).toBeTruthy();
    expect(finalVideo.headers()['content-type']).toContain('video/mp4');
    const finalPath = join(workDir, 'final.mp4');
    writeFileSync(finalPath, await finalVideo.body());
    const finalProbe = ffprobe(finalPath);
    const video = finalProbe.streams.find((stream) => stream.codec_type === 'video');
    const audio = finalProbe.streams.find((stream) => stream.codec_type === 'audio');
    expect(video?.width).toBe(1280);
    expect(video?.height).toBe(720);
    expect(Number(finalProbe.format.duration)).toBeGreaterThanOrEqual(5);
    expect(audio).toBeTruthy();
  } finally {
    try {
      execFileSync('docker', ['rm', '-f', fixture.containerName], { stdio: 'ignore' });
    } catch {
      // Container already gone; nothing to clean.
    }
    rmSync(workDir, { recursive: true, force: true });
  }
});
