import { expect, test } from '@playwright/test';

test('theme switch applies immediately and survives a reload', async ({ page }) => {
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.selectOption('#themeSelect', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('newsroom-panel-theme-v1'))).toBe('light');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(12, 12, 12)');

  await page.evaluate(() => document.getElementById('settingsBtn').click());
  await page.selectOption('#themeSelect', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('the mobile top bar exposes a menu that opens, navigates and closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  const toggle = page.locator('#mobileNavToggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const bar = await page.locator('.sidebar--rail').boundingBox();
  expect(bar.height, 'mobile top bar must stay <= 64px').toBeLessThanOrEqual(64);
  await expect(page.locator('#settingsBtn')).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#sidebarNav')).toBeVisible();
  // Footer actions live inside the drawer on mobile.
  await expect(page.locator('#sidebarNav #settingsBtn')).toBeVisible();
  await expect(page.locator('#sidebarNav #logoutBtn')).toBeVisible();
  await page.locator('.nav-item[data-view="audio"]').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#viewAudio')).toBeVisible();
});

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`layout reflows without horizontal clipping at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/?showcase=1');
    await expect(page.locator('#appShell')).toBeVisible();
    for (const view of ['radar', 'approval', 'audio', 'subtitulos2', 'scripts', 'connectors']) {
      if (viewport.name === 'mobile') await page.locator('#mobileNavToggle').click();
      await page.locator(`.nav-item[data-view="${view}"]`).click({ force: true });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('.app-content');
        const tooWide = [...document.querySelectorAll('.app-content > *')].filter(
          (node) => node.scrollWidth > node.clientWidth + 1,
        ).map((node) => node.className || node.tagName);
        return {
          body: document.body.scrollWidth - window.innerWidth,
          main: main ? main.scrollWidth - main.clientWidth : 0,
          children: tooWide,
        };
      });
      expect(overflow.body, `body overflows on ${view}`).toBeLessThanOrEqual(1);
      expect(overflow.main, `main overflows on ${view}`).toBeLessThanOrEqual(1);
      expect(overflow.children, `direct children overflow on ${view}`).toEqual([]);
    }
  });
}
