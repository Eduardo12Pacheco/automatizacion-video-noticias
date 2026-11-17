export const THEME_STORAGE_KEY = 'newsroom-panel-theme-v1';
export const SUPPORTED_THEMES = Object.freeze(['dark', 'light']);
export const DEFAULT_THEME = 'dark';

function normalizeTheme(value) {
  const theme = String(value || '').toLowerCase();
  return SUPPORTED_THEMES.includes(theme) ? theme : null;
}

/**
 * Resolves the theme for the first paint: an explicit stored choice wins,
 * otherwise the operating-system preference decides. Dark stays the default
 * when the browser exposes no preference.
 */
export function resolveInitialTheme({
  storage = globalThis.localStorage,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  try {
    const stored = normalizeTheme(storage?.getItem?.(THEME_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // Storage can be unavailable in private contexts; system preference still works.
  }
  try {
    const prefersLight = matchMedia?.('(prefers-color-scheme: light)')?.matches;
    if (prefersLight) return 'light';
  } catch {
    // Fall through to the product default.
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme, documentRef = globalThis.document) {
  const normalized = normalizeTheme(theme) || DEFAULT_THEME;
  documentRef?.documentElement?.setAttribute?.('data-theme', normalized);
  return normalized;
}

export function createThemeController({
  storage = globalThis.localStorage,
  documentRef = globalThis.document,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  let theme = resolveInitialTheme({ storage, matchMedia });

  function getTheme() {
    return theme;
  }

  function setTheme(nextTheme) {
    const normalized = normalizeTheme(nextTheme);
    if (!normalized) return theme;
    theme = normalized;
    applyTheme(theme, documentRef);
    try {
      storage?.setItem?.(THEME_STORAGE_KEY, theme);
    } catch {
      // Persistence is best-effort; the current session keeps the chosen theme.
    }
    return theme;
  }

  function toggleTheme() {
    return setTheme(theme === 'dark' ? 'light' : 'dark');
  }

  applyTheme(theme, documentRef);
  return { getTheme, setTheme, toggleTheme };
}
