const panelLanguageKey = 'codex-git-workbench.language';
const panelLanguages = new Set(['zh-CN', 'en']);
const localeMessage = Symbol('panel message');
const localeBindings = new WeakMap();
const panelDateFormats = new Map();
let panelMessages = {};
let panelLanguage = 'en';

export function setPanelMessages(messages) {
  panelMessages = messages;
}

export function msg(key, params = {}) {
  return key?.[localeMessage] ? key : { [localeMessage]: true, key: String(key ?? ''), params };
}

function renderPanelValue(value) {
  if (value?.[localeMessage]) return t(value.key, value.params);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    if (!panelDateFormats.has(panelLanguage)) {
      panelDateFormats.set(panelLanguage, new Intl.DateTimeFormat(panelLanguage, { dateStyle: 'medium', timeStyle: 'short' }));
    }
    return panelDateFormats.get(panelLanguage).format(value);
  }
  return String(value ?? '');
}

export function t(key, params = {}) {
  const text = panelLanguage === 'zh-CN' && Object.hasOwn(panelMessages, key) ? panelMessages[key] : key;
  return text.replace(/\{(\w+)\}/g, (field, name) => Object.hasOwn(params, name) ? renderPanelValue(params[name]) : field);
}

function writeLocalizedValue(node, attribute, value) {
  const rendered = renderPanelValue(value);
  if (attribute === null) node.textContent = rendered;
  else if (value == null) node.removeAttribute(attribute);
  else node.setAttribute(attribute, rendered);
}

function bindLocaleValue(node, attribute, value) {
  let bindings = localeBindings.get(node);
  if (value?.[localeMessage]) {
    if (!bindings) {
      bindings = new Map();
      localeBindings.set(node, bindings);
      node.setAttribute('data-panel-localized', '');
    }
    bindings.set(attribute, value);
  } else if (bindings) {
    bindings.delete(attribute);
    if (!bindings.size) {
      localeBindings.delete(node);
      node.removeAttribute('data-panel-localized');
    }
  }
  writeLocalizedValue(node, attribute, value);
}

export function uiText(node, value) {
  bindLocaleValue(node, null, value);
}

export function uiAttr(node, attribute, value) {
  bindLocaleValue(node, attribute, value);
}

function currentUiAttr(node, attribute) {
  return localeBindings.get(node)?.get(attribute) ?? node.getAttribute(attribute);
}

export function setPanelLocale(language, root) {
  panelLanguage = panelLanguages.has(language) ? language : 'zh-CN';
  root.documentElement.lang = panelLanguage;
  for (const node of root.querySelectorAll('[data-panel-localized]')) {
    for (const [attribute, value] of localeBindings.get(node) ?? []) {
      writeLocalizedValue(node, attribute, value);
    }
  }
}

export function readPanelLanguage(storage, preferences) {
  let stored;
  try { stored = storage?.getItem(panelLanguageKey); } catch { /* The host can disable storage. */ }
  if (panelLanguages.has(stored)) return stored;
  return panelLanguages.has(preferences?.language) ? preferences.language : 'zh-CN';
}

export function writePanelLanguage(language, storage) {
  if (!panelLanguages.has(language)) return;
  try { storage?.setItem(panelLanguageKey, language); } catch { /* Widget state provides a fallback. */ }
}

function localizePanelMarkup(root) {
  for (const node of root.querySelectorAll('[data-i18n]')) uiText(node, msg(node.textContent.trim()));
  for (const node of root.querySelectorAll('[aria-label], [placeholder], [title]')) {
    for (const attribute of ['aria-label', 'placeholder', 'title']) {
      const value = node.getAttribute(attribute);
      if (value && Object.hasOwn(panelMessages, value)) uiAttr(node, attribute, msg(value));
    }
  }
}

function panelStorage() {
  try { return window.localStorage; } catch { return null; }
}

function initializePanelLanguage(select) {
  const storage = panelStorage();
  const preferences = window.openai?.widgetState;
  select.value = readPanelLanguage(storage, preferences);
  localizePanelMarkup(document);
  setPanelLocale(select.value, document);
  select.addEventListener('change', () => {
    setPanelLocale(select.value, document);
    writePanelLanguage(panelLanguage, storage);
    window.openai?.setWidgetState?.({ ...window.openai.widgetState, language: panelLanguage });
  });
}
