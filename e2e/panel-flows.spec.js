import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

/**
 * Behavioural coverage for the flows a visitor actually uses in demo mode.
 * These tests drive the panel UI (no direct API calls for the actions under
 * test) so the DOM, the event wiring and the API contract stay connected.
 */

const EDITOR_EMAIL = process.env.E2E_EDITOR_EMAIL || 'editor@example.local';
const EDITOR_PASSWORD = process.env.E2E_EDITOR_PASSWORD || 'e2e-demo-password';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@example.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'e2e-admin-password';
const ORIGIN = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080';

async function json(response) {
  const body = await response.json();
  if (!response.ok()) throw new Error(`request failed: ${response.status()} ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(check, { timeout = 30_000, interval = 500, message = 'condition not met' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(message);
}

async function login(page, email, password) {
  await page.goto('/');
  await expect(page.locator('#authGate')).toBeVisible();
  await page.locator('#authUser').fill(email);
  await page.locator('#authPass').fill(password);
  await page.locator('#authForm button[type="submit"]').click();
  await expect(page.locator('#appShell')).toBeVisible();
}

const VIEW_CONTAINERS = {
  audio: '#viewAudio',
  subtitulos2: '#viewSubtitulos2',
  scripts: '#viewScripts',
  'admin-users': '#viewAdminUsers',
  connectors: '#viewConnectors',
};

async function openView(page, view) {
  await page.locator(`.nav-item[data-view="${view}"]`).click();
  await expect(page.locator(VIEW_CONTAINERS[view])).toBeVisible({ timeout: 20_000 });
}

test.describe.serial('demo panel flows', () => {
  test.beforeAll(async () => {
    // The suite must pass twice on the same stack: reset only the seeded story
    // and make sure the administrator account exists.
    execFileSync('docker', ['compose', 'run', '--rm', 'seed', 'node', 'scripts/seed-demo.js', '--reset'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    execFileSync('docker', [
      'compose', 'run', '--rm', '-T', 'api', 'node', 'scripts/create-admin.js',
      '--email', ADMIN_EMAIL, '--display-name', 'Demo Admin', '--password-stdin',
    ], {
      encoding: 'utf8',
      input: ADMIN_PASSWORD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  });

  test('editor logs in, approves a cluster, edits and saves the draft, voices it and subtitles a video', async ({ page }) => {
    test.setTimeout(150_000);
    const request = page.request;
    const mutation = { headers: { origin: ORIGIN } };

    await login(page, EDITOR_EMAIL, EDITOR_PASSWORD);
    await expect(page.locator('#runModeBadge')).toContainText(/demo/i);

    const before = await json(await request.get('/panel/read-models/scripts/drafts'));
    const beforeIds = new Set((before.drafts || []).map((draft) => draft.draft_id));

    await expect(page.locator('#cards .card--approval').first()).toBeVisible();
    await page.locator('#cards .card--approval').first().click();
    await expect(page.locator('#topicDialog')).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/webhook/approval/decision') && response.request().method() === 'POST'),
      page.locator('#topicDialog [data-action="approve-source"]').first().click(),
    ]);

    let draft = null;
    await waitFor(async () => {
      const payload = await json(await request.get('/panel/read-models/scripts/drafts'));
      draft = (payload.drafts || []).find((row) => !beforeIds.has(row.draft_id)) || null;
      return Boolean(draft);
    }, { message: 'approval did not enqueue a draft' });
    await page.locator('#closeDialog').click();

    // Reload so the new draft is rendered from the API, not from stale state.
    await page.reload();
    await expect(page.locator('#appShell')).toBeVisible();
    const card = page.locator(`.script-selection-card[data-script-id="${draft.draft_id}"]`);
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.locator('#scriptEditedArea')).toBeEnabled();

    const marker = `Cierre editorial ${Date.now()}`;
    const edited = `${(draft.guion_editado || draft.guion_draft || '').trim()} ${marker}`;
    await page.locator('#scriptEditedArea').fill(edited);
    await page.locator('#publishDraftBtn').click();
    await expect(page.locator('#publishConfirmDialog')).toBeVisible();
    await page.locator('#confirmPublishBtn').click();

    await waitFor(async () => {
      const payload = await json(await request.get('/panel/read-models/scripts/drafts'));
      const saved = (payload.drafts || []).find((row) => row.draft_id === draft.draft_id);
      return Boolean(saved && String(saved.guion_editado || '').includes(marker));
    }, { message: 'edited draft was not saved through the UI' });
    await expect(page.locator('#publishConfirmDialog')).toBeHidden({ timeout: 30_000 });

    // Voice job through the Voz screen.
    await openView(page, 'audio');
    await page.locator('#audioTextArea').fill(edited.split(' ').slice(0, 24).join(' '));
    await page.locator('#audioRunBtn').click();
    await expect(page.locator('#audioQueueList')).toContainText('Completado', { timeout: 20_000 });
    await expect(page.locator('#audioQueueList')).toContainText('Progreso 100%', { timeout: 20_000 });

    // Subtitle session + render through the Subtítulos screen.
    await openView(page, 'subtitulos2');
    await page.locator('#subtitle2UploadInput').setInputFiles({
      name: 'demo-flow.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.alloc(2048, 7),
    });
    await expect(page.locator('#subtitle2PhaseEdition')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#subtitle2RowsBody tr').first()).toBeVisible();
    expect(await page.locator('#subtitle2RowsBody tr').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#subtitle2RowsBody')).toContainText('Aurenia ajusta su mediocampo');
    await expect(page.locator('#subtitle2ReadyBtn')).toBeEnabled({ timeout: 15_000 });
    await page.locator('#subtitle2ReadyBtn').click();
    await expect(page.locator('#subtitle2DownloadBtn')).toBeEnabled({ timeout: 20_000 });
  });

  test('editor creates a manual video project from the Proyectos screen', async ({ page }) => {
    test.setTimeout(90_000);
    const title = `Proyecto de flujo ${Date.now()}`;

    await login(page, EDITOR_EMAIL, EDITOR_PASSWORD);
    await openView(page, 'scripts');
    await page.locator('#videoProjectsNewBtn').click();
    await expect(page.locator('#manualVideoProjectDialog')).toBeVisible();
    await page.locator('#manualVideoProjectTitleInput').fill(title);
    await page.locator('#manualVideoProjectCountryInput').selectOption('Aurenia');
    await page.locator('#manualVideoProjectPlayerInput').selectOption({ index: 1 });
    await page.locator('#manualVideoProjectScriptInput').fill('Primera frase del proyecto. | Segunda frase del proyecto.');
    await expect(page.locator('#manualVideoProjectValidation')).toContainText('2 segmentos');
    await page.locator('#manualVideoProjectSubmitBtn').click();
    await expect(page.locator('#manualVideoProjectDialog')).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('#videoProjectsList')).toContainText(title, { timeout: 30_000 });
  });

  test('admin creates a user from the Usuarios screen', async ({ page }) => {
    const email = `flow-${Date.now()}@example.local`;
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openView(page, 'admin-users');
    await expect(page.locator('#adminUsersForm')).toBeVisible();
    await page.locator('#adminUserName').fill('Flow Viewer');
    await page.locator('#adminUserEmail').fill(email);
    await page.locator('#adminUserPassword').fill('flow-password-123');
    await page.locator('#adminUserRole').selectOption('viewer');
    await page.locator('#adminUsersCreateBtn').click();
    await expect(page.locator('#adminUsersList')).toContainText(email, { timeout: 20_000 });
  });

  test('admin tests a local connector from the Conectores screen', async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await openView(page, 'connectors');
    const card = page.locator('[data-connector-id="article-extractor"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    const button = card.locator('[data-connector-test]');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(card.locator('.connector-card__message')).toContainText('Conexión correcta', { timeout: 20_000 });
  });
});
