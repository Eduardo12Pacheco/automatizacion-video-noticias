import { bootCompositionRoot } from './modules/composition-root.js';

async function loadServerBootstrap() {
  try {
    const response = await fetch('/panel/bootstrap', { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return;
    const bootstrap = await response.json();
    const origin = (bootstrap?.api_origin || globalThis.location?.origin || '').toString().replace(/\/+$/, '');
    globalThis.__CONTROL_PANEL_BOOTSTRAP__ = { ...bootstrap, api_origin: origin };
  } catch (error) {
    console.warn('Panel bootstrap unavailable:', error?.message || error);
  }
}

async function boot() {
  try {
    const { isShowcaseRequested, installShowcaseMode } = await import('./modules/core/showcase/showcase-mode.js');
    if (isShowcaseRequested()) installShowcaseMode();
  } catch (error) {
    console.warn('Showcase mode unavailable:', error);
  }
  if (!globalThis.__CONTROL_PANEL_BOOTSTRAP__) await loadServerBootstrap();
  bootCompositionRoot();
}

boot();
