#!/usr/bin/env node
/**
 * Runs the visual-QA + axe Playwright spec against a local static panel.
 * Shared by `pnpm test:all` locally and the CI `visual-qa` job.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || process.env.VISUAL_QA_PORT || 8155);
const baseUrl = `http://127.0.0.1:${PORT}`;
const playwrightBin = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');

if (!existsSync(playwrightBin)) {
  console.error('Playwright is not installed: run `pnpm install` and `pnpm exec playwright install chromium` first.');
  process.exit(2);
}

function waitForServer(url, attempts = 40) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const tick = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Server is still starting.
      }
      remaining -= 1;
      if (remaining <= 0) {
        reject(new Error(`panel static server did not start at ${url}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

const server = spawn(process.execPath, ['tools/serve-panel.mjs', String(PORT)], { stdio: 'ignore' });

try {
  await waitForServer(`${baseUrl}/?showcase=1`);
  const env = { ...process.env, E2E_BASE_URL: baseUrl };
  if (!env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
      .find((candidate) => existsSync(candidate));
    if (systemChromium) env.PLAYWRIGHT_CHROMIUM_EXECUTABLE = systemChromium;
  }
  const result = await new Promise((resolve) => {
    const child = spawn(playwrightBin, ['test', 'e2e/visual-qa.spec.js'], {
      stdio: 'inherit',
      env,
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = result;
} finally {
  server.kill('SIGTERM');
}
