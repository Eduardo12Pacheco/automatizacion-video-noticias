import { expect, test } from '@playwright/test';
import esCatalog from '../apps/panel/js/modules/core/i18n/es.json' with { type: 'json' };
import enCatalog from '../apps/panel/js/modules/core/i18n/en.json' with { type: 'json' };

const VIEWS = ['radar', 'approval', 'audio', 'subtitulos2', 'scripts', 'admin-users', 'connectors', 'errors-audit', 'active-users'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsPhrase(text, phrase) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function exactPhrases(side) {
  return Object.keys(esCatalog)
    .filter((key) => esCatalog[key] !== enCatalog[key])
    .map((key) => (side === 'en' ? esCatalog[key] : enCatalog[key]))
    .filter((value) => value && !value.includes('{'));
}

test.describe.configure({ mode: 'serial' });

for (const language of ['es', 'en']) {
  test(`every view stays in ${language} without leaking the other catalog`, async ({ page }) => {
    await page.addInitScript((lang) => localStorage.setItem('newsroom-panel-language-v1', lang), language);
    await page.goto('/?showcase=1');
    await expect(page.locator('#appShell')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', language);

    const foreign = exactPhrases(language);
    for (const view of VIEWS) {
      await page.locator(`.nav-item[data-view="${view}"]`).click({ force: true });
      await page.waitForTimeout(250);
      const text = await page.locator('body').innerText();
      for (const phrase of foreign) {
        expect(containsPhrase(text, phrase), `view ${view} leaks "${phrase}" in ${language}`).toBe(false);
      }
    }
  });
}

test('the language switch relocalises the rendered shell immediately', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('newsroom-panel-language-v1', 'es'));
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  await expect(page.locator('.nav-item[data-view="radar"] .nav-item__title')).toHaveText('Prensa');

  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.selectOption('#languageSelect', 'en');
  await page.waitForTimeout(150);
  await expect(page.locator('.nav-item[data-view="radar"] .nav-item__title')).toHaveText('Press');

  await page.selectOption('#languageSelect', 'es');
  await page.waitForTimeout(150);
  await expect(page.locator('.nav-item[data-view="radar"] .nav-item__title')).toHaveText('Prensa');
});
