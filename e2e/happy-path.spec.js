import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDITOR_EMAIL = process.env.E2E_EDITOR_EMAIL || 'editor@example.local';
const EDITOR_PASSWORD = process.env.E2E_EDITOR_PASSWORD || 'e2e-demo-password';
const ORIGIN = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080';

async function json(response) {
  const body = await response.json();
  if (!response.ok()) throw new Error(`request failed: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(check, { timeout = 20_000, interval = 500, message = 'condition not met' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(message);
}

function ffprobe(filePath) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], { encoding: 'utf8' }));
}

function meanVolumeDb(filePath) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return Number((output.match(/mean_volume:\s*(-?[\d.]+) dB/) || [])[1] ?? Number.NaN);
}

function reseedDemoStory() {
  // The happy path must pass twice on the same stack. `--reset` removes only
  // the rows the seed owns, so the second run starts with the same pending
  // cluster and no draft from the previous run.
  execFileSync('docker', ['compose', 'run', '--rm', 'seed', 'node', 'scripts/seed-demo.js', '--reset'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

test('login -> approve -> script -> voice -> subtitles -> render on the default stack', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const workDir = mkdtempSync(join(tmpdir(), 'newsroom-demo-e2e-'));
  const request = page.request;
  const mutation = { headers: { origin: ORIGIN } };

  try {
    if (process.env.E2E_SKIP_RESET !== '1') reseedDemoStory();

    await page.goto('/');
    await expect(page.locator('#authGate')).toBeVisible();
    await page.locator('#authUser').fill(EDITOR_EMAIL);
    await page.locator('#authPass').fill(EDITOR_PASSWORD);
    await page.locator('#authForm button[type="submit"]').click();
    await expect(page.locator('#appShell')).toBeVisible();
    await expect(page.locator('#runModeBadge')).toBeVisible();
    await expect(page.locator('#runModeBadge')).toHaveText(/demo/i);
    await expect(page.locator('#runModeBadge')).toHaveCount(1);
    await expect(page.locator('#runModeBanner')).toHaveCount(0);
    const bootstrap = await json(await request.get('/panel/bootstrap'));
    expect(bootstrap.run_mode).toBe('demo');

    const before = await json(await request.get('/panel/read-models/scripts/drafts'));
    const beforeIds = new Set((before.drafts || []).map((draft) => draft.draft_id));

    await expect(page.locator('#cards .card--approval').first()).toBeVisible();
    await page.locator('#cards .card--approval').first().click();
    await expect(page.locator('#topicDialog')).toBeVisible();
    const approveButton = page.locator('#topicDialog [data-action="approve-source"]').first();
    await expect(approveButton).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/webhook/approval/decision') && response.request().method() === 'POST'),
      approveButton.click(),
    ]);

    let approvedDraft = null;
    await waitFor(async () => {
      const payload = await json(await request.get('/panel/read-models/scripts/drafts'));
      approvedDraft = (payload.drafts || []).find((draft) => !beforeIds.has(draft.draft_id)) || null;
      return Boolean(approvedDraft);
    }, { message: 'approval did not enqueue a script draft' });
    expect(approvedDraft.guion_draft.split(/\s+/).length).toBeGreaterThan(119);
    await page.locator('#closeDialog').click();

    const publish = await json(await request.post('/webhook/mvp-script-publish/supabase/v2', {
      ...mutation,
      data: { draft_id: approvedDraft.draft_id, id_noticia: approvedDraft.id_noticia },
    }));
    await waitFor(async () => {
      const status = await json(await request.post('/webhook/mvp-script-publish-status/supabase/v1', {
        ...mutation,
        data: { job_id: publish.job_id },
      }));
      return status.status === 'completed';
    }, { message: 'script publish did not complete' });

    const projects = await json(await request.get('/panel/read-models/video-projects'));
    expect((projects.projects || []).some((project) => project.draft_id === approvedDraft.draft_id)).toBe(true);

    const voiceText = 'Aurenia ajusta su mediocampo para el próximo partido y Nicolás Arbelo vuelve a ser el eje del equipo.';
    await page.locator('[data-view="audio"]').click();
    await expect(page.locator('#audioTextArea')).toBeVisible();
    await page.locator('#audioTextArea').fill(voiceText);
    await page.locator('#audioRunBtn').click();
    await expect(page.locator('#audioQueueList')).toContainText('Completado', { timeout: 20_000 });
    await expect(page.locator('#audioQueueList')).toContainText('Progreso 100%', { timeout: 20_000 });

    const tts = await json(await request.post('/tts/api/tts/jobs', {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: { text: voiceText, voice_profile: 'balanced_default', title: 'e2e' },
    }));
    const wav = await request.get(`/tts/api/tts/jobs/${encodeURIComponent(tts.job_id)}/download`);
    expect(wav.ok()).toBeTruthy();
    expect(wav.headers()['content-type']).toContain('audio/wav');
    const wavPath = join(workDir, 'voice.wav');
    writeFileSync(wavPath, await wav.body());
    const wavProbe = ffprobe(wavPath);
    expect(wavProbe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    expect(Number(wavProbe.format.duration)).toBeGreaterThanOrEqual(1);
    expect(meanVolumeDb(wavPath)).toBeGreaterThan(-35);

    const subtitles = await json(await request.post('/subtitles/api/subtitles/sessions', {
      ...mutation,
      multipart: {
        source_language: 'auto',
        video: {
          name: 'demo.mp4',
          mimeType: 'video/mp4',
          buffer: Buffer.from('demo-video'),
        },
      },
    }));
    expect(subtitles.session_id).toBeTruthy();
    await json(await request.post(
      `/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/render`,
      { ...mutation, headers: { ...mutation.headers, 'content-type': 'application/json' }, data: { base_version: 1 } },
    ));
    const subtitleVideo = await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/download/file`);
    expect(subtitleVideo.ok()).toBeTruthy();
    expect(subtitleVideo.headers()['content-type']).toContain('video/mp4');
    const subtitlePath = join(workDir, 'subtitles.mp4');
    writeFileSync(subtitlePath, await subtitleVideo.body());
    const subtitleProbe = ffprobe(subtitlePath);
    expect(subtitleProbe.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')).toBe(true);
    expect(Number(subtitleProbe.format.duration)).toBeGreaterThanOrEqual(5);

    const render = await json(await request.post('/remotion/api/projects/create-from-approval', {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: { draft_id: approvedDraft.draft_id, guion_editado: approvedDraft.guion_editado },
    }));
    const projectId = render.data.project_id;
    await json(await request.post(`/remotion/api/projects/${encodeURIComponent(projectId)}/render-final`, {
      ...mutation,
      headers: { ...mutation.headers, 'content-type': 'application/json' },
      data: {},
    }));
    const status = await json(await request.get(`/remotion/api/projects/${encodeURIComponent(projectId)}/status`));
    expect(status.data.status).toBe('done');
    const video = await request.get(`/remotion/api/projects/${encodeURIComponent(projectId)}/download/final`);
    expect(video.ok()).toBeTruthy();
    expect(video.headers()['content-type']).toContain('video/mp4');
    const finalPath = join(workDir, 'final.mp4');
    writeFileSync(finalPath, await video.body());
    const finalProbe = ffprobe(finalPath);
    expect(finalProbe.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')).toBe(true);
    expect(Number(finalProbe.format.duration)).toBeGreaterThanOrEqual(5);

    console.log('DEMO_E2E_MEDIA', JSON.stringify({
      draft_words: approvedDraft.guion_draft.split(/\s+/).length,
      voice_seconds: Number(wavProbe.format.duration),
      voice_mean_db: meanVolumeDb(wavPath),
      subtitles_seconds: Number(subtitleProbe.format.duration),
      subtitles_resolution: `${subtitleProbe.streams.find((stream) => stream.codec_type === 'video')?.width}x${subtitleProbe.streams.find((stream) => stream.codec_type === 'video')?.height}`,
      final_seconds: Number(finalProbe.format.duration),
      final_resolution: `${finalProbe.streams.find((stream) => stream.codec_type === 'video')?.width}x${finalProbe.streams.find((stream) => stream.codec_type === 'video')?.height}`,
    }));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
