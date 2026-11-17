import { expect, test } from '@playwright/test';
import esCatalog from '../apps/panel/js/modules/core/i18n/es.json' with { type: 'json' };
import enCatalog from '../apps/panel/js/modules/core/i18n/en.json' with { type: 'json' };
import fs from 'node:fs';
import path from 'node:path';

const AXE_PATH = path.resolve(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js');
const AXE_SOURCE = fs.readFileSync(AXE_PATH, 'utf8');

// Inline <script> injection is blocked by the panel CSP (script-src 'self').
// Runtime.evaluate still runs the vendored axe bundle in the page world.
async function injectAxe(page) {
  await page.evaluate(AXE_SOURCE);
  await expect(page.evaluate(() => typeof window.axe)).resolves.toBe('object');
}
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
  return Object.keys(esCatalog)
    .filter((key) => esCatalog[key] !== enCatalog[key])
    .map((key) => (language === 'en' ? esCatalog[key] : enCatalog[key]))
    .filter((value) => value && !value.includes('{'));
}

// Leftover UI copy is not always in the catalog yet (the current
// set), so the spec also scans every visible chrome text node for words that
// only belong to the other language. Data containers are excluded because
// news titles, scripts and player names stay in their source language.
const DATA_SELECTORS = [
  '#cards',
  '.radar-monitor-card__main strong',
  '.radar-monitor-card__meta',
  '.radar-monitor-card__mentions-grid',
  '#radarBasuraList',
  '#radarSummaryBody',
  '#scriptCards',
  '#queueList',
  '#videoProjectsList',
  '#videoProjectDetail',
  '#audioQueueList',
  '#subtitle2RowsBody',
  '#subtitle2SessionHistory',
  '#subtitle2PreviewCue',
  '#adminUsersList',
  '#connectorsList',
  '#errorsAuditList',
  '#errorsAuditDetail',
  '#activeUsersList',
];

const SPANISH_MARKERS = [
  'modo', 'todos', 'todas', 'pendiente', 'transcripción', 'menciones', 'basura',
  'actualizar', 'buscar', 'orden', 'relevancia', 'recientes', 'noticias',
  'fuentes', 'países', 'país', 'guion', 'guiones', 'cola', 'palabras',
  'ejecutar', 'limpiar', 'creado', 'editar', 'seleccioná', 'guardar',
  'descargar', 'procesar', 'vista', 'previa', 'ajustes', 'usuarios',
  'conectores', 'activos', 'errores', 'auditoría', 'título', 'nombre',
  'correo', 'contraseña', 'sesión', 'servidor', 'desconectado', 'cargando',
  'reintentar', 'vacío', 'nuevo', 'proyecto', 'proyectos', 'imágenes',
  'subtítulos', 'voz', 'narración', 'plantilla', 'historial', 'duración',
  'estado', 'listo', 'desde', 'hasta', 'tipo', 'últimas', 'horas', 'rango',
  'búsqueda', 'fuente', 'selección', 'texto', 'quitar', 'copia',
  'cancelar', 'eliminar', 'agregar', 'refrescar', 'actualización', 'sin',
  'todavía', 'primero', 'último', 'evento', 'detalle', 'filtrar', 'fecha',
  'servicio', 'correlación', 'completado', 'progreso', 'descarga', 'trabajo',
];

const ENGLISH_MARKERS = [
  'the', 'and', 'with', 'your', 'this', 'from', 'search', 'refresh', 'order',
  'relevance', 'recent', 'news', 'sources', 'country', 'countries', 'script',
  'queue', 'words', 'clear', 'save', 'download', 'process', 'preview',
  'settings', 'users', 'connectors', 'active', 'errors', 'audit', 'title',
  'name', 'email', 'password', 'session', 'server', 'disconnected', 'loading',
  'retry', 'empty', 'new', 'project', 'projects', 'images', 'subtitles',
  'voice', 'narration', 'preset', 'history', 'duration', 'status', 'ready',
  'upload', 'source', 'link', 'transcript', 'mentions', 'trash', 'all',
  'last', 'hours', 'range', 'type', 'service', 'actor', 'event', 'detail',
  'filter', 'date', 'success', 'failure', 'completed', 'progress', 'failed',
  'offline', 'configured', 'disabled', 'test', 'testing', 'never', 'checked',
];

const NEUTRAL_TEXT = [
  'Newsroom Video Automation',
  'Newsroom',
  'Demo Sports News',
  'Demo Wire',
  'Demo Radio',
  'Demo mode',
  'Modo demo',
  'Google News RSS',
  'YouTube public RSS',
  'OpenAI-compatible',
  'OpenAI',
  'SearXNG',
  'Wikimedia Commons',
  'Mailpit',
  'MinIO',
  'Ollama',
  'Piper',
  'Whisper',
  'Remotion',
  'Postgres',
  'SMTP',
  'Gmail',
  'n8n',
  'TTS',
  'ASR',
  'LLM',
  'RSS',
  'HTTP',
  'HTTPS',
  'JSON',
  'S3',
  'URL',
  'GPU',
  'CPU',
];

function foreignWordHits(text, language) {
  const markers = language === 'en' ? SPANISH_MARKERS : ENGLISH_MARKERS;
  let normalized = text;
  for (const neutral of NEUTRAL_TEXT) {
    normalized = normalized.replace(new RegExp(escapeRegExp(neutral), 'gi'), ' ');
  }
  const hits = new Set();
  for (const marker of markers) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(marker)}($|[^\\p{L}\\p{N}])`, 'iu');
    if (pattern.test(normalized)) hits.add(marker);
  }
  return [...hits];
}

async function parkPointerAndBlur(page, viewport) {
  // Capture hygiene: never leave the pointer over the rail (it would
  // expand on hover) or a focus ring on the last clicked control.
  await page.mouse.move(Math.max(8, viewport.width - 8), Math.max(8, viewport.height - 8));
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(60);
}

async function openView(page, view, viewport) {
  if (viewport.name === 'mobile') {
    await page.locator('#mobileNavToggle').click();
  }
  await page.locator(`.nav-item[data-view="${view.key}"]`).click({ force: true });
  await expect(page.locator(view.container)).toBeVisible();
  await parkPointerAndBlur(page, viewport);
  await page.waitForTimeout(190);
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
    const overlapping = [];
    const overlapTargets = [
      ...document.querySelectorAll(`${container} .news-panel__filters > *`),
    ];
    for (let first = 0; first < overlapTargets.length; first += 1) {
      for (let second = first + 1; second < overlapTargets.length; second += 1) {
        const a = overlapTargets[first].getBoundingClientRect();
        const b = overlapTargets[second].getBoundingClientRect();
        if (a.width === 0 || b.width === 0) continue;
        const intersects = a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        if (intersects) {
          overlapping.push(`${overlapTargets[first].className || overlapTargets[first].tagName} / ${overlapTargets[second].className || overlapTargets[second].tagName}`);
        }
      }
    }
    return { bodyOverflow, overflowing, forbiddenHits, overlapping, text };
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
      await injectAxe(page);

      const foreign = foreignPhrases(language);
      for (const view of VIEWS) {
        await openView(page, view, viewport);
        const measured = await measureView(page, view);
        expect(measured.bodyOverflow, `${view.key} overflows the body at ${viewport.name}`).toBeLessThanOrEqual(1);
        expect(measured.overflowing, `${view.key} overflows the main layout at ${viewport.name}`).toEqual([]);
        expect(measured.forbiddenHits, `${view.key} renders debug/fallback text at ${viewport.name}`).toEqual([]);
        expect(measured.overlapping, `${view.key} overlaps controls at ${viewport.name}`).toEqual([]);
        for (const phrase of foreign) {
          expect(containsPhrase(measured.text, phrase), `${view.key} leaks "${phrase}" in ${language}`).toBe(false);
        }
        const foreignWords = await page.evaluate(
          ({ dataSelectors }) => {
            const root = document.querySelector('.app-content') || document.body;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const chunks = [];
            let node = walker.nextNode();
            while (node) {
              const element = node.parentElement;
              const visible = element
                && element.closest(dataSelectors.join(',')) === null
                && element.closest('[hidden]') === null
                && element.offsetParent !== null;
              if (visible) chunks.push(node.nodeValue || '');
              node = walker.nextNode();
            }
            return chunks.join(' ').replace(/\s+/g, ' ').trim();
          },
          { dataSelectors: DATA_SELECTORS },
        );
        const leaks = foreignWordHits(foreignWords, language);
        expect(leaks, `${view.key} leaks untranslated ${language === 'en' ? 'Spanish' : 'English'} chrome: ${leaks.join(', ')}`).toEqual([]);

        const violations = await page.evaluate(async () => {
          const result = await globalThis.axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
          });
          return result.violations
            .filter((violation) => ['serious', 'critical'].includes(violation.impact))
            .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
        });
        expect(violations, `${view.key} has serious accessibility violations`).toEqual([]);
        await parkPointerAndBlur(page, viewport);
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
      await parkPointerAndBlur(page, viewport);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `login-${language}-${viewport.name}.png`) });
      await page.fill('#authUser', 'demo');
      await page.fill('#authPass', 'not-the-password');
      await page.locator('#authForm button[type="submit"]').click();
      await expect(page.locator('#authError')).toBeVisible();
      await expect(page.locator('#authError')).toContainText(language === 'es' ? 'Usuario o contraseña incorrectos' : 'Incorrect username or password');
      const measured = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
      expect(measured).toBeLessThanOrEqual(1);
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
      if (viewport.name === 'desktop') {
        await page.locator('.sidebar--rail').hover();
      } else {
        await page.locator('#mobileNavToggle').click();
      }
      await page.locator('#settingsBtn').click();
      await expect(page.locator('#settingsDialog')).toBeVisible();
      await injectAxe(page);

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
      await parkPointerAndBlur(page, viewport);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `settings-${language}-${viewport.name}.png`) });
      expect(telemetry.failedResponses, 'failed responses').toEqual([]);
      expect(telemetry.pageErrors, 'page errors').toEqual([]);
      expect(telemetry.consoleErrors, 'console errors').toEqual([]);
    });
  }
}

test('exactly one demo indicator is visible and it is the header badge', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('newsroom-panel-language-v1', 'es'));
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  await expect(page.locator('#runModeBadge')).toBeVisible();
  await expect(page.locator('#runModeBadge')).toHaveCount(1);
  await expect(page.locator('#runModeBanner')).toHaveCount(0);
  await expect(page.locator('.showcase-badge')).toHaveCount(0);
});

for (const width of [1280, 1440]) {
  test(`approval filter row has no overlapping controls at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('newsroom-panel-language-v1', 'es');
      localStorage.setItem('newsroom-panel-theme-v1', 'dark');
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?showcase=1');
    await expect(page.locator('#appShell')).toBeVisible();
    await page.locator('.nav-item[data-view="approval"]').click({ force: true });
    await expect(page.locator('#viewApproval')).toBeVisible();
    const overlaps = await page.evaluate(() => {
      const targets = [...document.querySelectorAll('#viewApproval .news-panel__filters > *')];
      const result = [];
      for (let first = 0; first < targets.length; first += 1) {
        for (let second = first + 1; second < targets.length; second += 1) {
          const a = targets[first].getBoundingClientRect();
          const b = targets[second].getBoundingClientRect();
          if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
            result.push([targets[first].className, targets[second].className]);
          }
        }
      }
      return result;
    });
    expect(overlaps, `filter controls overlap at ${width}px`).toEqual([]);
  });
}

for (const width of [1280, 1440, 1920]) {
  test(`the rail never covers the content column at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('newsroom-panel-language-v1', 'es');
      localStorage.setItem('newsroom-panel-theme-v1', 'dark');
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?showcase=1');
    await expect(page.locator('#appShell')).toBeVisible();
    await expect(page.locator('#viewApproval')).toBeVisible();
    // Park the pointer away from the rail so a hover expansion does not masquerade
    // as the layout's default state.
    await page.mouse.move(width - 8, 8);
    await page.waitForTimeout(260);
    const geometry = await page.evaluate(() => {
      const rail = document.querySelector('.sidebar--rail')?.getBoundingClientRect();
      const content = document.querySelector('.app-content')?.getBoundingClientRect();
      const children = [...document.querySelectorAll('.app-content > *')]
        .filter((node) => node.offsetParent !== null)
        .map((node) => ({ className: node.className || node.tagName, left: node.getBoundingClientRect().left }));
      return { railRight: rail?.right ?? 0, contentLeft: content?.left ?? 0, children };
    });
    expect(geometry.contentLeft, 'content column starts under the rail').toBeGreaterThanOrEqual(geometry.railRight - 1);
    for (const child of geometry.children) {
      expect(child.left, `${child.className} starts under the rail`).toBeGreaterThanOrEqual(geometry.railRight - 1);
    }
  });
}

test('mono typography is reserved for ids, timecodes and counters', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('newsroom-panel-language-v1', 'es');
    localStorage.setItem('newsroom-panel-theme-v1', 'dark');
  });
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  const views = ['radar', 'approval', 'audio', 'subtitulos2', 'scripts', 'admin-users', 'connectors', 'errors-audit', 'active-users'];
  for (const view of views) {
    await page.locator(`.nav-item[data-view="${view}"]`).click({ force: true });
    await page.waitForTimeout(300);
    const offenders = await page.evaluate(() => {
      const allowed = (text) => {
        if (!/\p{L}/u.test(text)) return true;
        if (/\d{1,2}:\d{2}([.,]\d+)?/.test(text)) return true;
        if (/^[A-Za-z0-9_.-]{1,32}$/.test(text)) return true;
        return false;
      };
      const result = [];
      for (const element of document.querySelectorAll('.app-content *')) {
        if (element.offsetParent === null) continue;
        if (element.closest('#cards, #radarBasuraList, #radarSummaryBody, #scriptCards, #queueList, #videoProjectsList, #videoProjectDetail, #audioQueueList, #subtitle2RowsBody, #subtitle2SessionHistory, #subtitle2PreviewCue, #adminUsersList, #connectorsList, #errorsAuditList, #errorsAuditDetail, #activeUsersList')) continue;
        const style = getComputedStyle(element);
        if (!/JetBrains Mono|monospace/.test(style.fontFamily)) continue;
        const text = (element.textContent || '').trim().replace(/\s+/g, ' ');
        if (!text || allowed(text)) continue;
        result.push({ tag: element.tagName, className: String(element.className).slice(0, 80), text: text.slice(0, 80) });
      }
      return result;
    });
    expect(offenders, `${view} renders prose in a mono font`).toEqual([]);
  }
});

test('radar destructive action is labelled, danger-styled and comes last', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('newsroom-panel-language-v1', 'es'));
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  await page.locator('.nav-item[data-view="radar"]').click({ force: true });
  const card = page.locator('.radar-monitor-card').first();
  await expect(card).toBeVisible();
  const remove = card.locator('[data-radar-action="dismiss-monitor-card"]');
  await expect(remove).toHaveText('Eliminar');
  await expect(remove).toHaveClass(/danger/);
  const placement = await card.evaluate((node) => {
    const actions = node.querySelector('.radar-monitor-card__actions');
    const buttons = [...(actions?.querySelectorAll('button') || [])];
    const removeButton = node.querySelector('[data-radar-action="dismiss-monitor-card"]');
    return {
      isLast: buttons[buttons.length - 1] === removeButton,
      isGlyphOnly: (removeButton?.textContent || '').trim() === '×',
      position: getComputedStyle(removeButton).position,
    };
  });
  expect(placement.isLast).toBe(true);
  expect(placement.isGlyphOnly).toBe(false);
  expect(placement.position).not.toBe('absolute');
});

test('radar mobile chips stay on one scrollable row and refresh never wraps', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('newsroom-panel-language-v1', 'es'));
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  await page.locator('#mobileNavToggle').click();
  await page.locator('.nav-item[data-view="radar"]').click({ force: true });
  await expect(page.locator('#viewRadar')).toBeVisible();
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('#radarCountryBar');
    const cards = [...bar.querySelectorAll('.radar-country-card')];
    const tops = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top)));
    const barRect = bar.getBoundingClientRect();
    const refresh = document.querySelector('#radarMonitorRefreshBtn');
    return {
      rows: tops.size,
      allFullWidth: cards.every((card) => card.getBoundingClientRect().width >= barRect.width - 2),
      scrollable: bar.scrollWidth > bar.clientWidth,
      refreshWhiteSpace: getComputedStyle(refresh).whiteSpace,
      refreshLines: refresh.getBoundingClientRect().height,
      refreshText: refresh.textContent.trim(),
    };
  });
  expect(geometry.rows).toBe(1);
  expect(geometry.allFullWidth).toBe(false);
  expect(geometry.scrollable).toBe(true);
  expect(geometry.refreshText).toBe('Refrescar');
  expect(geometry.refreshWhiteSpace).toBe('nowrap');
  expect(geometry.refreshLines).toBeLessThanOrEqual(44);
});

test('subtitles empty preview shows no cue stripes and no duplicated preview title', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('newsroom-panel-language-v1', 'es'));
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  await page.locator('.nav-item[data-view="subtitulos2"]').click({ force: true });
  await expect(page.locator('#subtitle2PreviewEmpty')).toBeVisible();
  const state = await page.evaluate(() => {
    const stage = document.querySelector('#subtitle2PreviewStage');
    const cue = document.querySelector('#subtitle2PreviewCue');
    const visibleStriped = [...stage.querySelectorAll('*')]
      .filter((element) => element.offsetParent !== null)
      .filter((element) => {
        const style = getComputedStyle(element);
        return parseFloat(style.borderTopWidth) > 0 || parseFloat(style.borderBottomWidth) > 0;
      })
      .map((element) => element.className);
    const eyebrow = document.querySelector('.subtitle-preview-frame__header .subtitle2-section-label');
    const heading = document.querySelector('.subtitle-preview-frame__header h3');
    return {
      cueVisible: cue.offsetParent !== null,
      cueText: (cue.textContent || '').trim(),
      visibleStriped,
      eyebrow: eyebrow.textContent.trim(),
      heading: heading.textContent.trim(),
    };
  });
  expect(state.cueVisible).toBe(false);
  expect(state.cueText).toBe('');
  expect(state.visibleStriped).toEqual([]);
  expect(state.eyebrow).not.toBe(state.heading);
  expect(state.eyebrow).toBe('Reproductor');
  expect(state.heading).toBe('Vista previa');
});

test('light theme keeps every view contained and accessible (wcag21aa)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('newsroom-panel-language-v1', 'es');
    localStorage.setItem('newsroom-panel-theme-v1', 'light');
  });
  await page.goto('/?showcase=1');
  await expect(page.locator('#appShell')).toBeVisible();
  await injectAxe(page);
  for (const view of VIEWS) {
    await openView(page, view, { name: 'desktop', width: 1440, height: 900 });
    const measured = await page.evaluate(({ container }) => ({
      bodyOverflow: document.body.scrollWidth - window.innerWidth,
      overlapping: (() => {
        const targets = [...document.querySelectorAll(`${container} .news-panel__filters > *`)];
        const result = [];
        for (let first = 0; first < targets.length; first += 1) {
          for (let second = first + 1; second < targets.length; second += 1) {
            const a = targets[first].getBoundingClientRect();
            const b = targets[second].getBoundingClientRect();
            if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) result.push([first, second]);
          }
        }
        return result;
      })(),
    }), { container: view.container });
    expect(measured.bodyOverflow, `${view.key} light theme overflow`).toBeLessThanOrEqual(1);
    expect(measured.overlapping, `${view.key} light theme overlaps`).toEqual([]);
    const violations = await page.evaluate(async () => {
      const result = await globalThis.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      });
      return result.violations
        .filter((violation) => ['serious', 'critical'].includes(violation.impact))
        .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
    });
    expect(violations, `${view.key} light theme accessibility violations`).toEqual([]);
    if (view.key === 'radar') {
      await parkPointerAndBlur(page, { name: 'desktop', width: 1440, height: 900 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'radar-es-desktop-light.png') });
    }
  }
});

test('admin user input borders meet non-text contrast in both themes', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    await page.addInitScript(({ value }) => {
      localStorage.setItem('newsroom-panel-language-v1', 'es');
      localStorage.setItem('newsroom-panel-theme-v1', value);
    }, { value: theme });
    await page.goto('/?showcase=1');
    await expect(page.locator('#appShell')).toBeVisible();
    await page.locator('.nav-item[data-view="admin-users"]').click({ force: true });
    await expect(page.locator('#adminUsersForm input').first()).toBeVisible();
    const ratios = await page.evaluate(() => {
      function rgb(value) {
        const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return match ? match.slice(1, 4).map(Number) : null;
      }
      function luminance([r, g, b]) {
        const channel = (c) => {
          const value = c / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      }
      return [...document.querySelectorAll('#adminUsersForm input, #adminUsersForm select')].map((input) => {
        const style = getComputedStyle(input);
        const fg = rgb(style.borderTopColor);
        const bg = rgb(style.backgroundColor);
        if (!fg || !bg) return 0;
        const high = Math.max(luminance(fg), luminance(bg));
        const low = Math.min(luminance(fg), luminance(bg));
        return (high + 0.05) / (low + 0.05);
      });
    });
    expect(ratios.length).toBeGreaterThan(0);
    expect(Math.min(...ratios), `${theme} input border contrast`).toBeGreaterThanOrEqual(3);
  }
});

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
