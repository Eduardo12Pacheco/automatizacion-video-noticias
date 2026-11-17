import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const AXE_PATH = path.resolve(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js');
const AXE_SOURCE = fs.readFileSync(AXE_PATH, 'utf8');

// Inline <script> injection is blocked by the panel CSP (script-src 'self').
async function injectAxe(page) {
  await page.evaluate(AXE_SOURCE);
  await expect(page.evaluate(() => typeof window.axe)).resolves.toBe('object');
}
const VIEWS = ['radar', 'approval', 'audio', 'subtitulos2', 'scripts', 'admin-users', 'connectors', 'errors-audit', 'active-users'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const THEMES = ['dark', 'light'];
const LANGUAGES = ['es', 'en'];

for (const language of LANGUAGES) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`axe has no serious violations in ${language}/${theme}/${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addInitScript(({ lang, mode }) => {
          localStorage.setItem('newsroom-panel-language-v1', lang);
          localStorage.setItem('newsroom-panel-theme-v1', mode);
        }, { lang: language, mode: theme });
        await page.goto('/?showcase=1');
        await expect(page.locator('#appShell')).toBeVisible();
        await injectAxe(page);

        for (const view of VIEWS) {
          if (viewport.name === 'mobile') {
            await page.locator('#mobileNavToggle').click();
          }
          await page.locator(`.nav-item[data-view="${view}"]`).click({ force: true });
          await page.waitForTimeout(150);
          const violations = await page.evaluate(async () => {
            const result = await globalThis.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
            });
            return result.violations
              .filter((violation) => ['serious', 'critical'].includes(violation.impact))
              .map((violation) => ({
                id: violation.id,
                impact: violation.impact,
                nodes: violation.nodes.map((node) => node.target.join(' ')),
              }));
          });
          expect(violations, `view ${view} has serious accessibility violations`).toEqual([]);
        }
      });
    }
  }
}
