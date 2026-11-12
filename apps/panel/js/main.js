import { bootCompositionRoot } from './modules/composition-root.js';

async function boot() {
  try {
    const { isShowcaseRequested, installShowcaseMode } = await import('./modules/core/showcase/showcase-mode.js');
    if (isShowcaseRequested()) installShowcaseMode();
  } catch (error) {
    console.warn('Showcase mode unavailable:', error);
  }
  bootCompositionRoot();
}

boot();
