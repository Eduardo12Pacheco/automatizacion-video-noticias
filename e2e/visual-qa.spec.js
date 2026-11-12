import { expect, test } from '@playwright/test';
import { PHRASES } from '../apps/panel/js/modules/core/i18n/phrases.js';
import fs from 'node:fs';
import path from 'node:path';

const AXE_PATH = path.resolve(process.cwd(), 'e2e', 'vendor', 'axe-core', 'axe.min.js');
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'docs', 'images', 'screens');

const VIEWS = [
  { key: 'radar', container: '#viewRadar', data: true },
  { key: 'approval', container: '#viewApproval', data: true },
  { key: 'audio', container: '#viewAudio', data: false },
  { key: 'subtitulos2', container: '#viewSubtitulos2', data: false },
  { key: 'scripts', container: '#viewScripts', data: true },
  { key: 'admin-users', container: '#viewAdminUsers', data: true },
  { key: 'connectors', container: '#viewConnectors', data: true },
  { key: 'errors-audit', container: '#viewErrorsAudit', data: true },
  { key: 'active-users', container: '#viewActiveUsers', data: true },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const LANGUAGES = ['es', 'en'];
const FORBIDDEN_TEXT = ['<!DOCTYPE', '<html', 'undefined', 'NaN', '[object Object]'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(text, phrase) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function foreignPhrases(language) {
  return PHRASES
    .filter(([es, en]) => es !== en && !es.includes('{') && !en.includes('{'))
    .map(([, en, es]) => (language === 'en' ? es : en))
    .filter(Boolean);
}

async function openView(page, view, viewport) {
  if (viewport.name === 'mobile') {
    await page.locator('#mobileNavToggle').click();
  }
  await page.locator(`.nav-item[data-view="${view.key}"]`).click({ force: true });
  await expect(page.locator(view.container)).toBeVisible();
  await page.waitForTimeout(250);
}

function attachTelemetry(page, telemetry) {
  page.on('console', (message) => {
    if (message.type() === 'error') telemetry.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => telemetry.pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) telemetry.failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => telemetry.failedRequests.push(`${request.url()} ${request.failure()?.errorText || ''}`));
}

async function measureView(page, view) {
  return page.evaluate(({ container, forbidden }) => {
    const bodyOverflow = document.body.scrollWidth - window.innerWidth;
    const main = document.querySelector('.app-content');
    const overflowing = main
      ? [...main.children]
        .filter((node) => node.offsetParent !== null || node === document.querySelector(container))
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .map((node) => node.className || node.tagName)
      : [];
    const text = document.body.innerText || '';
    const forbiddenHits = forbidden.filter((token) => text.includes(token));
    return { bodyOverflow, overflowing, forbiddenHits, text };
  }, { container: view.container, forbidden: FORBIDDEN_TEXT });
}

for (const language of LANGUAGES) {
  for (const viewport of VIEWPORTS) {
    test(`visual QA ${language}/${viewport.name}`, async ({ page }) => {
      const telemetry = { consoleErrors: [], pageErrors: [], failedResponses: [], failedRequests: [] };
      attachTelemetry(page, telemetry);
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(({ lang }) => {
        localStorage.setItem('newsroom-panel-language-v1', lang);
        localStorage.setItem('newsroom-panel-theme-v1', 'dark');
      }, { lang: language });
      await page.goto('/?showcase=1');
      await expect(page.locator('#appShell')).toBeVisible();
      await page.addScriptTag({ path: AXE_PATH });

      const foreign = foreignPhrases(language);
      for (const view of VIEWS) {
        await openView(page, view, viewport);
        const measured = await measureView(page, view);
        expect(measured.bodyOverflow, `${view.key} overflows the body at ${viewport.name}`).toBeLessThanOrEqual(1);
        expect(measured.overflowing, `${view.key} overflows the main layout at ${viewport.name}`).toEqual([]);
        expect(measured.forbiddenHits, `${view.key} renders debug/fallback text at ${viewport.name}`).toEqual([]);
        for (const phrase of foreign) {
          expect(containsPhrase(measured.text, phrase), `${view.key} leaks "${phrase}" in ${language}`).toBe(false);
        }

        const violations = await page.evaluate(async () => {
          const result = await globalThis.axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
          });
          return result.violations
            .filter((violation) => ['serious', 'critical'].includes(violation.impact))
            .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
        });
        expect(violations, `${view.key} has serious accessibility violations`).toEqual([]);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${view.key}-${language}-${viewport.name}.png`) });
      }

      expect(telemetry.failedResponses, 'failed responses').toEqual([]);
      expect(telemetry.failedRequests, 'failed requests').toEqual([]);
      expect(telemetry.pageErrors, 'page errors').toEqual([]);
      expect(telemetry.consoleErrors, 'console errors').toEqual([]);
    });
  }
}

for (const language of LANGUAGES) {
  for (const viewport of VIEWPORTS) {
    test(`login screen ${language}/${viewport.name}`, async ({ page }) => {
      const telemetry = { consoleErrors: [], pageErrors: [], failedResponses: [], failedRequests: [] };
      attachTelemetry(page, telemetry);
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(({ lang }) => {
        localStorage.setItem('newsroom-panel-language-v1', lang);
        localStorage.setItem('newsroom-panel-theme-v1', 'dark');
      }, { lang: language });
      await page.goto('/?showcase=1&login=error');
      await expect(page.locator('#authGate')).toBeVisible();
      await expect(page.locator('#authGate')).not.toContainText('Operations Studio');
      await expect(page.locator('.auth-card__product')).toHaveText('Newsroom Video Automation');
      await expect(page.locator('.auth-card__mark svg')).toBeVisible();
      await page.fill('#authUser', 'demo');
      await page.fill('#authPass', 'not-the-password');
      await page.locator('#authForm button[type="submit"]').click();
      await expect(page.locator('#authError')).toBeVisible();
      await expect(page.locator('#authError')).toContainText(language === 'es' ? 'Usuario o contraseña incorrectos' : 'Incorrect username or password');
      const measured = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
      expect(measured).toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `login-${language}-${viewport.name}.png`) });
      expect(telemetry.pageErrors, 'page errors').toEqual([]);
    });
  }
}

for (const language of LANGUAGES) {
  for (const viewport of VIEWPORTS) {
    test(`settings screen ${language}/${viewport.name}`, async ({ page }) => {
      const telemetry = { consoleErrors: [], pageErrors: [], failedResponses: [], failedRequests: [] };
      attachTelemetry(page, telemetry);
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(({ lang }) => {
        localStorage.setItem('newsroom-panel-language-v1', lang);
        localStorage.setItem('newsroom-panel-theme-v1', 'dark');
      }, { lang: language });
      await page.goto('/?showcase=1');
      await expect(page.locator('#appShell')).toBeVisible();
      if (viewport.name === 'desktop') await page.locator('.sidebar--rail').hover();
      await page.locator('#settingsBtn').click();
      await expect(page.locator('#settingsDialog')).toBeVisible();
      await page.addScriptTag({ path: AXE_PATH });

      const measured = await page.evaluate(() => ({
        bodyOverflow: document.body.scrollWidth - window.innerWidth,
        text: document.querySelector('#settingsDialog')?.innerText || '',
      }));
      expect(measured.bodyOverflow).toBeLessThanOrEqual(1);
      for (const token of FORBIDDEN_TEXT) expect(measured.text).not.toContain(token);
      for (const phrase of foreignPhrases(language)) {
        expect(containsPhrase(measured.text, phrase), `settings leaks "${phrase}" in ${language}`).toBe(false);
      }
      const violations = await page.evaluate(async () => {
        const context = document.querySelector('#settingsDialog');
        const result = await globalThis.axe.run(context || document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
        });
        return result.violations
          .filter((violation) => ['serious', 'critical'].includes(violation.impact))
          .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
      });
      expect(violations).toEqual([]);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `settings-${language}-${viewport.name}.png`) });
      expect(telemetry.failedResponses, 'failed responses').toEqual([]);
      expect(telemetry.pageErrors, 'page errors').toEqual([]);
      expect(telemetry.consoleErrors, 'console errors').toEqual([]);
    });
  }
}

test('designed empty and error states are reachable in every data view', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('newsroom-panel-language-v1', 'es'));
  const dataViews = VIEWS.filter((view) => view.data);

  for (const scenario of ['empty', 'error']) {
    await page.goto(`/?showcase=1&state=${scenario}`);
    await expect(page.locator('#appShell')).toBeVisible();
    for (const view of dataViews) {
      await page.locator(`.nav-item[data-view="${view.key}"]`).click({ force: true });
      await page.waitForTimeout(350);
      const state = page.locator(`${view.container} .screen-state--${scenario === 'empty' ? 'empty' : 'error'}`);
      await expect(state.first(), `${view.key} should show a designed ${scenario} state`).toBeVisible();
      if (scenario === 'error') {
        const text = await state.first().innerText();
        expect(text).not.toContain('<html');
        expect(text).not.toContain('Showcase error scenario');
        if (view.key === 'approval' || view.key === 'admin-users' || view.key === 'connectors') {
          await expect(state.first().locator('details')).toHaveCount(1);
        }
      }
    }
  }
});

test('loading skeletons appear while data is in flight', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('newsroom-panel-language-v1', 'es'));
  await page.goto('/?showcase=1&state=slow');
  await expect(page.locator('#appShell')).toBeVisible();
  for (const view of VIEWS.filter((item) => item.data || item.key === 'subtitulos2')) {
    await page.locator(`.nav-item[data-view="${view.key}"]`).click({ force: true });
    const skeleton = page.locator(`${view.container} .skeleton-block`).first();
    await expect(skeleton, `${view.key} should show a loading skeleton`).toBeVisible({ timeout: 5_000 });
  }
});
