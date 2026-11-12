import { expect, test } from '@playwright/test';

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

test('login -> approve -> script -> voice -> subtitles -> render on the default stack', async ({ page }) => {
  const request = page.request;
  const mutation = { headers: { origin: ORIGIN } };

  await page.goto('/');
  await expect(page.locator('#authGate')).toBeVisible();
  await page.locator('#authUser').fill(EDITOR_EMAIL);
  await page.locator('#authPass').fill(EDITOR_PASSWORD);
  await page.locator('#authForm button[type="submit"]').click();
  await expect(page.locator('#appShell')).toBeVisible();
  await expect(page.locator('#runModeBadge')).toBeVisible();
  await expect(page.locator('#runModeBadge')).toHaveText(/demo/i);
  await expect(page.locator('#runModeBanner')).toBeVisible();
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

  await page.locator('[data-view="audio"]').click();
  await expect(page.locator('#audioTextArea')).toBeVisible();
  await page.locator('#audioTextArea').fill('Aurenia ajusta su mediocampo para el próximo partido y Nicolás Andrade vuelve a ser el eje del equipo.');
  await page.locator('#audioRunBtn').click();
  await expect(page.locator('#audioQueueList')).toContainText(/Completado|Procesando|En cola/, { timeout: 20_000 });

  const tts = await json(await request.post('/tts/api/tts/jobs', {
    ...mutation,
    headers: { ...mutation.headers, 'content-type': 'application/json' },
    data: {
      text: 'Aurenia ajusta su mediocampo para el próximo partido y Nicolás Andrade vuelve a ser el eje del equipo.',
      voice_profile: 'balanced_default',
      title: 'e2e',
    },
  }));
  const wav = await request.get(`/tts/api/tts/jobs/${encodeURIComponent(tts.job_id)}/download`);
  expect(wav.ok()).toBeTruthy();
  expect(wav.headers()['content-type']).toContain('audio/wav');
  expect((await wav.body()).byteLength).toBeGreaterThan(1000);

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
  const subtitleRender = await json(await request.post(
    `/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/render`,
    { ...mutation, headers: { ...mutation.headers, 'content-type': 'application/json' }, data: { base_version: 1 } },
  ));
  expect(subtitleRender.job.status).toBe('succeeded');
  const subtitleVideo = await request.get(`/subtitles/api/subtitles/sessions/${encodeURIComponent(subtitles.session_id)}/download/file`);
  expect(subtitleVideo.ok()).toBeTruthy();
  expect((await subtitleVideo.body()).byteLength).toBeGreaterThan(1000);

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
  expect((await video.body()).byteLength).toBeGreaterThan(1000);
});
