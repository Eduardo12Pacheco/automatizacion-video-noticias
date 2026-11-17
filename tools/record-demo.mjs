#!/usr/bin/env node
/**
 * Records the README demo from a running demo-mode stack.
 *
 * The capture is app-viewport only (no desktop, no terminal), stores no
 * personal data and fails when the page logs a console error or throws. It
 * writes docs/images/demo.mp4 and a short docs/images/demo.gif, both with
 * metadata stripped.
 *
 * Usage:
 *   NEWSROOM_DEMO_PASSWORD=... node tools/record-demo.mjs
 *
 * Optional environment:
 *   E2E_BASE_URL             default http://127.0.0.1:8080
 *   NEWSROOM_DEMO_EMAIL      default editor@example.local
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE  system Chromium path
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from '@playwright/test';

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:8080';
const email = process.env.NEWSROOM_DEMO_EMAIL || 'editor@example.local';
const password = process.env.NEWSROOM_DEMO_PASSWORD;
const outputDir = resolve('docs/images');
const videoDir = mkdtempSync(join(tmpdir(), 'newsroom-demo-'));

if (!password) {
  console.error('Set NEWSROOM_DEMO_PASSWORD to the seeded demo account password.');
  process.exit(2);
}

// Full demo story: discovery, approval, voice, subtitles and the final
// project list, with enough hold time to land inside the 60-90 second
// portfolio target while staying under the README limits.
const views = [
  { key: 'radar', hold: 9000 },
  { key: 'approval', hold: 9000 },
  { key: 'audio', hold: 8000 },
  { key: 'subtitulos2', hold: 8000 },
  { key: 'scripts', hold: 9000 },
];

// The panel probes /panel/session before login; a 401 there is expected and is
// not an application error. Any other console error aborts the recording.
function isExpectedConsoleError(message) {
  return /status of 401 \(Unauthorized\)/.test(message);
}

const consoleErrors = [];
const pageErrors = [];

async function parkPointerAndBlur(page, width, height) {
  // Capture hygiene: the rail expands on hover and focus rings would
  // otherwise stay visible for the rest of the recording.
  await page.mouse.move(Math.max(8, width - 8), Math.max(8, height - 8));
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(80);
}
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error' && !isExpectedConsoleError(message.text())) {
    consoleErrors.push(message.text());
  }
});
page.on('pageerror', (error) => pageErrors.push(error.message));

let video;
try {
  await page.addInitScript(() => {
    localStorage.setItem('newsroom-panel-language-v1', 'es');
    localStorage.setItem('newsroom-panel-theme-v1', 'dark');
  });
  await page.goto(baseUrl);
  await page.waitForSelector('#authGate', { state: 'visible' });
  await page.waitForTimeout(3200);
  await page.fill('#authUser', email);
  await page.fill('#authPass', password);
  await page.locator('#authForm button[type="submit"]').click();
  await page.waitForSelector('#appShell', { state: 'visible' });
  await parkPointerAndBlur(page, 1440, 900);
  await page.waitForTimeout(4000);

  for (const view of views) {
    await page.locator(`.nav-item[data-view="${view.key}"]`).click({ force: true });
    await parkPointerAndBlur(page, 1440, 900);
    if (view.key === 'audio') {
      // Show a real demo voice job finishing, not the designed empty state.
      await page.fill('#audioTextArea', 'La selección de Aurenia prepara el partido con una alineación renovada y un mediocampo más vertical.');
      await page.locator('#audioRunBtn').click();
      await page.waitForFunction(
        () => /Completado/.test(document.querySelector('#audioQueueList')?.textContent || ''),
        undefined,
        { timeout: 90_000 },
      );
      await parkPointerAndBlur(page, 1440, 900);
    }
    await page.waitForTimeout(view.hold);
  }

  await page.locator('#settingsBtn').click();
  await page.waitForSelector('#settingsDialog', { state: 'visible' });
  await parkPointerAndBlur(page, 1440, 900);
  await page.waitForTimeout(7000);
  await page.locator('#closeSettings').click();
  await parkPointerAndBlur(page, 1440, 900);

  if (pageErrors.length || consoleErrors.length) {
    throw new Error(
      `refusing to record a broken demo:\nconsole: ${consoleErrors.join('\n')}\npage: ${pageErrors.join('\n')}`,
    );
  }
  video = page.video();
} finally {
  await context.close();
  await browser.close();
}

try {
  const raw = await video.path();
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', raw,
    '-map_metadata', '-1', '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p',
    join(outputDir, 'demo.mp4'),
  ]);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', raw, '-t', '14',
    '-vf', 'fps=7,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=none',
    '-loop', '0',
    join(outputDir, 'demo.gif'),
  ]);
  console.log(`demo.mp4 ${(statSync(join(outputDir, 'demo.mp4')).size / 1024).toFixed(0)} KB`);
  console.log(`demo.gif ${(statSync(join(outputDir, 'demo.gif')).size / 1024).toFixed(0)} KB`);
} finally {
  rmSync(videoDir, { recursive: true, force: true });
}
