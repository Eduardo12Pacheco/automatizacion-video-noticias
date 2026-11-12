import esCatalog from './es.json' with { type: 'json' };
import enCatalog from './en.json' with { type: 'json' };
import { PHRASES } from './phrases.js';

export const SUPPORTED_LANGUAGES = Object.freeze(['es', 'en']);
export const DEFAULT_LANGUAGE = 'es';
export const LANGUAGE_STORAGE_KEY = 'newsroom-panel-language-v1';

const CATALOGS = Object.freeze({ es: esCatalog, en: enCatalog });
const TEXT_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePhrase(template) {
  const slots = [];
  const pattern = String(template).split(/\{(\d+)\}/).map((part, index) => {
    if (index % 2 === 1) {
      slots.push(Number(part));
      return '(.+?)';
    }
    return escapeRegExp(part);
  }).join('');
  return { regex: new RegExp(`^${pattern}$`), slots };
}

const PHRASE_INDEX = PHRASES.map(([es, en]) => ({
  es: String(es),
  en: String(en),
  esMatcher: compilePhrase(es),
  enMatcher: compilePhrase(en),
}));

function fillPhrase(template, matcher, match) {
  return String(template).replace(/\{(\d+)\}/g, (token, index) => {
    const slot = Number(index);
    const position = matcher.slots.indexOf(slot);
    return position >= 0 ? (match[position + 1] ?? token) : token;
  });
}

/**
 * Translates a source string against the phrase catalog. Returns null when no
 * entry matches, so callers can leave unknown/technical text untouched.
 */
export function translateText(text, language) {
  const value = String(text ?? '');
  if (!value.trim()) return null;
  const target = normalizeLanguage(language);
  for (const phrase of PHRASE_INDEX) {
    if (target === 'en') {
      const match = phrase.esMatcher.regex.exec(value);
      if (match) return fillPhrase(phrase.en, phrase.esMatcher, match);
    } else {
      const match = phrase.enMatcher.regex.exec(value);
      if (match) return fillPhrase(phrase.es, phrase.enMatcher, match);
    }
  }
  return null;
}

function localizeAttributes(element, language) {
  for (const attribute of ['placeholder', 'title', 'aria-label', 'alt', 'data-dropdown-label', 'data-dropdown-placeholder']) {
    if (!element.hasAttribute?.(attribute)) continue;
    const current = element.getAttribute(attribute);
    const translated = translateText(current, language);
    if (translated !== null && translated !== current) element.setAttribute(attribute, translated);
  }
}

/** Localises already-rendered DOM against the phrase catalog (gettext-style). */
export function localizeTree(root, language) {
  const target = normalizeLanguage(language);
  if (!root) return;
  const documentRef = root.ownerDocument || globalThis.document;
  const walker = documentRef?.createTreeWalker?.(root, 4); // NodeFilter.SHOW_TEXT
  if (walker) {
    let node = walker.nextNode();
    while (node) {
      const parentTag = node.parentElement?.tagName;
      if (!TEXT_SKIP_TAGS.has(parentTag)) {
        const value = node.nodeValue || '';
        const leading = value.match(/^\s*/)?.[0] || '';
        const trailing = value.match(/\s*$/)?.[0] || '';
        const core = value.trim();
        const translated = core ? translateText(core, target) : null;
        if (translated !== null && translated !== core) {
          node.nodeValue = `${leading}${translated}${trailing}`;
        }
      }
      node = walker.nextNode();
    }
  }
  root.querySelectorAll?.('*').forEach((element) => {
    if (!TEXT_SKIP_TAGS.has(element.tagName)) localizeAttributes(element, target);
  });
}

/**
 * Keeps dynamically rendered feature markup in the active language. The
 * observer disconnects while it edits so its own writes cannot loop.
 */
export function installDomLocalizer({ documentRef = globalThis.document, i18n } = {}) {
  if (!documentRef?.body || !i18n) return () => {};
  let observer = null;
  const apply = (root = documentRef.body) => {
    if (!root) return;
    observer?.disconnect();
    localizeTree(root, i18n.getLanguage());
    observer?.observe(documentRef.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label', 'alt', 'data-dropdown-label', 'data-dropdown-placeholder'],
    });
  };
  if (typeof globalThis.MutationObserver === 'function') {
    observer = new globalThis.MutationObserver((mutations) => {
      const roots = [];
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => roots.push(node));
        } else if (mutation.type === 'characterData') {
          roots.push(mutation.target);
        } else {
          roots.push(mutation.target);
        }
      }
      observer.disconnect();
      for (const root of roots) {
        if (root.nodeType === 3) {
          const parent = root.parentElement;
          if (parent) localizeTree(parent, i18n.getLanguage());
        } else if (root.nodeType === 1) {
          localizeTree(root, i18n.getLanguage());
        }
      }
      observer.observe(documentRef.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['placeholder', 'title', 'aria-label', 'alt', 'data-dropdown-label', 'data-dropdown-placeholder'],
      });
    });
  }
  apply();
  documentRef.addEventListener?.('newsroom:languagechange', () => apply());
  return () => observer?.disconnect();
}
const SELECTOR = '[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria-label]';

function normalizeLanguage(value) {
  const lang = String(value || '').toLowerCase().split('-')[0];
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
}

function interpolate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

/**
 * Dependency-free ES/EN i18n (S5.5). Spanish is the source catalog and the
 * default language. State is persisted in localStorage and `<html lang>` is
 * kept in sync so screen readers and the document outline stay correct.
 */
export function createI18n({
  storage = globalThis.localStorage,
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
    localize: (root = documentRef?.body) => localizeTree(root, language),
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
