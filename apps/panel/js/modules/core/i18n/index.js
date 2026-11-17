import esCatalog from './es.json' with { type: 'json' };
import enCatalog from './en.json' with { type: 'json' };

export const SUPPORTED_LANGUAGES = Object.freeze(['es', 'en']);
export const DEFAULT_LANGUAGE = 'es';
export const LANGUAGE_STORAGE_KEY = 'newsroom-panel-language-v1';

const CATALOGS = Object.freeze({ es: esCatalog, en: enCatalog });
const SELECTOR = '[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria-label]';

function normalizeLanguage(value) {
  const lang = String(value || '').toLowerCase().split('-')[0];
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
}

function defaultStorage() {
  // Node exposes a localStorage getter that warns when touched without
  // --localstorage-file; browser sessions still use the real store.
  if (typeof process !== 'undefined' && process.versions?.node) return null;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function interpolate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

/**
 * Dependency-free ES/EN i18n. Spanish is the source catalog and the
 * default language. State is persisted in localStorage and `<html lang>` is
 * kept in sync so screen readers and the document outline stay correct.
 */
export function createI18n({
  storage = defaultStorage(),
  storageKey = LANGUAGE_STORAGE_KEY,
  documentRef = globalThis.document,
  defaultLanguage = DEFAULT_LANGUAGE,
} = {}) {
  let language = defaultLanguage;

  try {
    language = normalizeLanguage(storage?.getItem?.(storageKey) || defaultLanguage);
  } catch {
    language = defaultLanguage;
  }

  function getLanguage() {
    return language;
  }

  function t(key, vars = {}) {
    const catalog = CATALOGS[language] || CATALOGS[DEFAULT_LANGUAGE];
    const fallback = CATALOGS[DEFAULT_LANGUAGE];
    const value = catalog?.[key] ?? fallback?.[key] ?? key;
    return interpolate(value, vars);
  }

  function applyAttribute(root, selector, attribute, datasetKey) {
    root.querySelectorAll?.(selector).forEach((node) => {
      const key = node.dataset?.[datasetKey];
      if (!key) return;
      node.setAttribute(attribute, t(key));
    });
  }

  function apply(root = documentRef) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('[data-i18n]').forEach((node) => {
      const key = node.dataset.i18n;
      if (!key) return;
      node.textContent = t(key);
    });
    applyAttribute(root, '[data-i18n-placeholder]', 'placeholder', 'i18nPlaceholder');
    applyAttribute(root, '[data-i18n-title]', 'title', 'i18nTitle');
    applyAttribute(root, '[data-i18n-aria-label]', 'aria-label', 'i18nAriaLabel');
    if (documentRef?.documentElement) documentRef.documentElement.lang = language;
  }

  function setLanguage(nextLanguage, { persist = true } = {}) {
    const normalized = normalizeLanguage(nextLanguage);
    if (normalized === language) {
      apply();
      return language;
    }
    language = normalized;
    if (persist) {
      try {
        storage?.setItem?.(storageKey, language);
      } catch {
        // Language persistence is best-effort; the session keeps working.
      }
    }
    apply();
    documentRef?.dispatchEvent?.(new CustomEvent('newsroom:languagechange', {
      detail: { language },
    }));
    return language;
  }

  return {
    getLanguage,
    t,
    apply,
    setLanguage,
    selector: SELECTOR,
  };
}

/**
 * Lazily created singleton for modules that only need `t()` (feature
 * renderers, dialogs and controllers). Boot wires the same storage key.
 */
let shared = null;
export function getI18n() {
  if (!shared) shared = createI18n();
  return shared;
}

export function setSharedI18n(instance) {
  shared = instance;
  return shared;
}

export function t(key, vars) {
  return getI18n().t(key, vars);
}
