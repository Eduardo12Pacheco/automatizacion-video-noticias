import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local-mode data-flow acceptance.
 *
 * Opt-in because it needs the real CPU worker stack: Ollama + Piper +
 * faster-whisper + Remotion. The spec is self-contained on purpose:
 *
 *  - it starts the `e2e` profile fixture service and recreates the API with
 *    NEWS_DISCOVERY_FEED_URL pointing at three invented articles;
 *  - it triggers a real discovery refresh and proves the new clusters come
 *    from those articles;
 *  - it approves one of the new clusters, waits for the real Ollama draft and
 *    uses THAT text for voice, subtitles and the final render (no fixture
 *    script hardcoded in the test);
 *  - it measures the resulting media with ffprobe/ffmpeg: duration, streams,
 *    mean volume and cue/draft word overlap.
 *
 * Run it after `docker compose --profile local --profile e2e up -d` with the
 * local models downloaded (see e2e/README.md), with NEWSROOM_E2E_LOCAL=1.
 */

const EDITOR_EMAIL = process.env.E2E_EDITOR_EMAIL || 'editor@example.local';
const EDITOR_PASSWORD = process.env.E2E_EDITOR_PASSWORD || 'e2e-demo-password';
const ORIGIN = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || 'newsroom';
const FIXTURE_SERVICE = 'e2e-fixtures';
const FIXTURE_FEED_URL = process.env.E2E_DISCOVERY_FEED_URL || `http://${FIXTURE_SERVICE}:8000/discovery.xml`;
const FIXTURE_PLAYER = { seleccion: 'Aurenia', jugador: 'Nicolás Arbelo' };
const FIXTURE_TITLES = [
  'Aurenia ajusta su mediocampo para el próximo partido',
  'Montelia confirma la vuelta de su capitán a los entrenamientos',
  'Valdoria presenta una lista con tres debutantes para el amistoso',
];
const SPANISH_STOPWORDS = new Set([
  'para', 'como', 'sobre', 'entre', 'desde', 'hasta', 'hacia', 'donde', 'cuando', 'porque',
  'este', 'esta', 'estos', 'estas', 'aquel', 'aquella', 'pero', 'sino', 'otra', 'otro',
  'otros', 'otras', 'mismo', 'misma', 'también', 'tambien', 'solo', 'sólo', 'todo', 'toda',
  'todos', 'todas', 'cada', 'tras', 'ante', 'bajo', 'contra', 'durante', 'mediante', 'según',
  'segun', 'será', 'sera', 'serán', 'seran', 'está', 'esta', 'están', 'estan', 'han', 'hay',
  'fue', 'son', 'con', 'por', 'los', 'las', 'del', 'una', 'unos', 'unas', 'que', 'sus', 'más',
  'mas', 'muy', 'sin', 'nos', 'les', 'cuando', 'equipo', 'grupo', 'partido', 'próximo',
  'proximo', 'cuerpo', 'técnico', 'tecnico', 'durante', 'entrenamiento', 'práctica', 'practica',
]);

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

function normalizeWords(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

function contentWords(text) {
  return new Set(normalizeWords(text).filter((word) => word.length >= 4 && !SPANISH_STOPWORDS.has(word)));
}

function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);
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

function composeEnv(overrides = {}) {
  // An exported NEWSROOM_MODE/LLM in the calling shell would silently
  // override the project's .env for Compose interpolation. Remove the keys
  // the project .env owns, then apply the explicit overrides for this run.
  const env = { ...process.env };
  try {
    const dotenv = readFileSync('.env', 'utf8');
    for (const line of dotenv.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
      if (match) delete env[match[1]];
    }
  } catch {
    // No .env in a remote/CI checkout; the parent environment is the config.
  }
  return { ...env, ...overrides };
}

function configureDiscoveryFeed() {
  // Start the opt-in fixture service and recreate only the API with the
  // fixture feed and one invented player. The values are interpolated by
  // Compose from this process environment, so the running stack keeps its
  // models and data while the API switches to the offline feed.
  run('docker', ['compose', '--profile', 'e2e', 'up', '-d', '--no-deps', FIXTURE_SERVICE], {
    env: composeEnv(),
  });
  run('docker', ['compose', 'up', '-d', '--no-deps', '--force-recreate', 'api'], {
    env: composeEnv({
      NEWSROOM_MODE: 'local',
      NEWS_DISCOVERY_FEED_URL: FIXTURE_FEED_URL,
      NEWS_DISCOVERY_PLAYERS: JSON.stringify([FIXTURE_PLAYER]),
    }),
  });
}

function startFixtureServer(state, workDir) {
  const containerName = `newsroom-e2e-fixtures-${process.pid}`;
  try {
    execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  } catch {
    // No previous container with this name; nothing to clean.
  }
  const network = process.env.E2E_FIXTURE_NETWORK || `${COMPOSE_PROJECT}_default`;
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

test('local mode discovers its own feed, drafts with a real LLM and renders audible media from that draft', async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const workDir = mkdtempSync(join(tmpdir(), 'newsroom-local-e2e-'));
  const fixture = { containerName: '' };
  const timings = {};
  let fixtureBase = '';
  const request = page.request;
  const mutation = { headers: { origin: ORIGIN } };

  try {
    const configureStarted = Date.now();
    configureDiscoveryFeed();
    const bootstrap = await waitFor(async () => {
      try {
        return await json(await request.get('/panel/bootstrap'));
      } catch {
        return null;
      }
    }, { timeout: 3 * 60_000, message: 'the recreated API did not become reachable' });
    expect(bootstrap.run_mode).toBe('local');
    timings.configure_api_ms = Date.now() - configureStarted;

    fixtureBase = startFixtureServer(fixture, workDir);

    // The renderer downloads these fixtures; generate the music bed up front
    // and the still image from the committed demo brand asset.
    const musicPath = join(workDir, 'music.wav');
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=12', '-ar', '44100', musicPath]);
    writeFileSync(join(workDir, 'image.png'), readFileSync('examples/brand/logo-demo.png'));

    await page.goto('/');
    await expect(page.locator('#authGate')).toBeVisible();
    await page.locator('#authUser').fill(EDITOR_EMAIL);
    await page.locator('#authPass').fill(EDITOR_PASSWORD);
    await page.locator('#authForm button[type="submit"]').click();
    await expect(page.locator('#appShell')).toBeVisible();

    const refreshStarted = Date.now();
    const refresh = await json(await request.post('/webhook/approval/search-refresh/supabase/v2', {
      ...mutation,
      data: { window: '24h' },
    }));
    expect(refresh.run_id).toBeTruthy();
    const refreshStatus = await waitFor(async () => {
      const payload = await json(await request.get(`/webhook/approval/search-refresh/status/supabase/v1?run_id=${encodeURIComponent(refresh.run_id)}`));
      return String(payload.status).toLowerCase() === 'succeeded' ? payload : null;
    }, { timeout: 8 * 60_000, message: 'the real discovery refresh did not finish' });
    timings.discovery_ms = Date.now() - refreshStarted;

    // The fixture feed has exactly three items and one configured player, so
    // the real discovery run must have received three rows.
    expect(Number(refreshStatus.stats?.received)).toBe(3);
    expect(Number(refreshStatus.stats?.valid)).toBe(3);

    const pendingAfter = await json(await request.get('/panel/read-models/approval/pending'));
    // Clusters promoted by THIS discovery run: the seeded demo cluster has a
    // null run_id, so it can never satisfy this filter.
    const newClusters = (pendingAfter.items || []).filter((item) => item.run_id === refresh.run_id);
    expect(newClusters.length).toBeGreaterThan(0);
    expect(newClusters.every((item) => item.cluster_id !== 'demo-cluster-pending')).toBe(true);

    const newTitles = new Set();
    for (const item of newClusters) {
      const topic = await json(await request.get(`/webhook/approval/topic/supabase/v2?cluster_id=${encodeURIComponent(item.cluster_id)}`));
      for (const source of topic.item?.sources || []) {
        const title = source.source_title_snapshot || source.titular;
        if (title) newTitles.add(String(title));
      }
    }
    // The promoted clusters must come from the offline fixture feed, never
    // from the seeded demo story, and every new cluster needs a source from
    // one of the three fixture articles.
    expect(newTitles.size).toBeGreaterThan(0);
    for (const title of newTitles) {
      expect(FIXTURE_TITLES).toContain(title);
    }

    const chosen = newClusters[0];
    const clusterId = chosen.cluster_id;
    const topic = await json(await request.get(`/webhook/approval/topic/supabase/v2?cluster_id=${encodeURIComponent(clusterId)}`));
    const sourceId = topic.item?.sources?.[0]?.id_noticia;
    expect(sourceId).toBeTruthy();

    const decision = await json(await request.post('/webhook/approval/decision/supabase/v2', {
      ...mutation,
      data: { cluster_id: clusterId, id_noticia: sourceId, action: 'approve' },
    }));
    expect(decision.enqueued).toBe(true);

    const draftStarted = Date.now();
    const draft = await waitFor(async () => {
      const payload = await json(await request.get('/panel/read-models/scripts/drafts'));
      return (payload.drafts || []).find((item) => item.cluster_id === clusterId) || null;
    }, { timeout: 12 * 60_000, message: 'the real LLM did not produce a script draft' });
    timings.ollama_draft_ms = Date.now() - draftStarted;

    const draftText = String(draft.guion_editado || draft.guion_draft || '').trim();
    expect(draftText.split(/\s+/).length).toBeGreaterThan(40);

    // Voice: the draft text from the API is the only script input.
    const ttsStarted = Date.now();
    const tts = await json(await request.post('/tts/api/tts/jobs', {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: { text: draftText, voice_profile: 'balanced_default', title: 'e2e local' },
    }));
    await waitFor(async () => {
      const job = await json(await request.get(`/tts/api/tts/jobs/${encodeURIComponent(tts.job_id)}`));
      return ['done', 'succeeded', 'completed'].includes(String(job.status).toLowerCase()) ? job : null;
    }, { message: 'Piper did not synthesize the voice' });
    const wavResponse = await waitFor(async () => {
      const response = await request.get(`/tts/api/tts/jobs/${encodeURIComponent(tts.job_id)}/download`);
      return response.ok() ? response : null;
    }, { message: 'the synthesized WAV was not downloadable' });
    const voicePath = join(workDir, 'voice.wav');
    writeFileSync(voicePath, await wavResponse.body());
    const voiceProbe = ffprobe(voicePath);
    const voiceSeconds = Number(voiceProbe.format.duration);
    const voiceMeanDb = meanVolumeDb(voicePath);
    timings.tts_ms = Date.now() - ttsStarted;
    expect(voiceSeconds).toBeGreaterThanOrEqual(3);
    expect(voiceMeanDb).toBeGreaterThan(-35);

    // Subtitles: transcribe the synthesized voice, then compare the cues with
    // the same draft text instead of a hardcoded phrase list.
    const subtitleStarted = Date.now();
    const subtitleSource = join(workDir, 'subtitle-source.mp4');
    const sourceSeconds = Math.ceil(voiceSeconds) + 1;
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:s=640x360:d=${sourceSeconds}`, '-i', voicePath, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', subtitleSource]);
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
    const cueText = cues.map((cue) => String(cue.translated_text || cue.text || cue.source_text || '')).join(' ');
    const draftWords = contentWords(draftText);
    const cueWords = contentWords(cueText);
    expect(cueWords.size).toBeGreaterThan(0);
    const overlap = [...cueWords].filter((word) => draftWords.has(word)).length / cueWords.size;
    expect(overlap).toBeGreaterThanOrEqual(0.4);

    const session = await json(await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}`));
    await json(await request.post(
      `/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/render`,
      { ...mutation, headers: { ...mutation.headers, 'content-type': 'application/json' }, data: { base_version: session.current_snapshot_version } },
    ));
    await waitFor(async () => {
      const payload = await json(await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/render`));
      return String(payload.job?.status).toLowerCase() === 'succeeded';
    }, { message: 'Remotion did not render the subtitles video' });
    const subtitlesVideo = await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/download/file`);
    expect(subtitlesVideo.ok()).toBeTruthy();
    const subtitlesVideoPath = join(workDir, 'subtitles.mp4');
    writeFileSync(subtitlesVideoPath, await subtitlesVideo.body());
    const subtitlesProbe = ffprobe(subtitlesVideoPath);
    timings.subtitles_ms = Date.now() - subtitleStarted;
    expect(subtitlesProbe.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')).toBe(true);
    expect(subtitlesProbe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    expect(Number(subtitlesProbe.format.duration)).toBeGreaterThanOrEqual(5);
    const subtitlesMeanDb = meanVolumeDb(subtitlesVideoPath);
    expect(subtitlesMeanDb).toBeGreaterThan(-35);

    // Final render: the segments also come from the real draft, and the
    // renderer receives the same synthesized voice track.
    const renderStarted = Date.now();
    const draftSentences = sentencesOf(draftText).slice(0, 6);
    expect(draftSentences.length).toBeGreaterThanOrEqual(3);
    const created = await json(await request.post('/approval/api/projects/create-from-approval', {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: {
        draft_id: draft.draft_id,
        title: draft.titulo_noticia || 'Local E2E',
        segments: draftSentences.map((phrase, index) => ({ id: `segment-${index + 1}`, phrase })),
        voice_audio: { public_url: `${fixtureBase}/voice.wav`, name: 'voice.wav', mime_type: 'audio/wav' },
        background_audio: { public_url: `${fixtureBase}/music.wav`, name: 'music.wav', mime_type: 'audio/wav' },
        selected_images: draftSentences.map((_phrase, index) => ({
          id: `image-${index + 1}`,
          label: `Demo still ${index + 1}`,
          public_url: `${fixtureBase}/image.png`,
          width: 1080,
          height: 1080,
        })),
      },
    }));
    const project = created.data || created;
    const projectId = project.projectId || project.project_id;
    expect(projectId).toBeTruthy();
    expect(project.snapshotHash).toBeTruthy();
    await json(await request.post(`/approval/api/projects/${encodeURIComponent(projectId)}/render-final`, {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: { snapshotHash: project.snapshotHash, async: true },
    }));
    await waitFor(async () => {
      const payload = await json(await request.get(`/approval/api/projects/${encodeURIComponent(projectId)}/status`));
      const status = payload.data || payload;
      return String(status.render?.status || status.status).toLowerCase() === 'rendered';
    }, { timeout: 25 * 60_000, message: 'Remotion did not render the final local video' });

    const finalVideo = await request.get(`/approval/api/projects/${encodeURIComponent(projectId)}/download/final?download=1`);
    expect(finalVideo.ok()).toBeTruthy();
    expect(finalVideo.headers()['content-type']).toContain('video/mp4');
    const finalPath = join(workDir, 'final.mp4');
    writeFileSync(finalPath, await finalVideo.body());
    const finalProbe = ffprobe(finalPath);
    timings.render_ms = Date.now() - renderStarted;
    const video = finalProbe.streams.find((stream) => stream.codec_type === 'video');
    const audio = finalProbe.streams.find((stream) => stream.codec_type === 'audio');
    expect(video?.width).toBe(1280);
    expect(video?.height).toBe(720);
    expect(Number(finalProbe.format.duration)).toBeGreaterThanOrEqual(5);
    expect(audio).toBeTruthy();
    const finalMeanDb = meanVolumeDb(finalPath);
    expect(finalMeanDb).toBeGreaterThan(-35);

    console.log('LOCAL_E2E_MEDIA', JSON.stringify({
      cluster_id: clusterId,
      draft_words: draftText.split(/\s+/).length,
      draft_sentences: draftSentences.length,
      voice_seconds: voiceSeconds,
      voice_mean_db: voiceMeanDb,
      cues: cues.length,
      cue_word_overlap: Number(overlap.toFixed(3)),
      subtitles_seconds: Number(subtitlesProbe.format.duration),
      subtitles_mean_db: subtitlesMeanDb,
      subtitles_streams: subtitlesProbe.streams.map((stream) => stream.codec_type),
      final_seconds: Number(finalProbe.format.duration),
      final_mean_db: finalMeanDb,
      final_resolution: `${video?.width}x${video?.height}`,
      final_streams: finalProbe.streams.map((stream) => stream.codec_type),
      timings,
    }));
  } finally {
    try {
      execFileSync('docker', ['rm', '-f', fixture.containerName], { stdio: 'ignore' });
    } catch {
      // Container already gone; nothing to clean.
    }
    rmSync(workDir, { recursive: true, force: true });
  }
});
