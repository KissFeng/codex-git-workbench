import assert from 'node:assert/strict';
import { test } from 'node:test';

test('locale switch updates existing UI bindings and leaves Git text and input state intact', async () => {
  const { msg, setPanelMessages, setPanelLocale, uiText, uiAttr } =
    await import('../plugins/source-control-proof/panel-locale.mjs');
  const makeNode = () => ({
    attributes: {},
    value: '',
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
  });
  const button = makeNode();
  const draft = makeNode();
  const commit = makeNode();
  const root = { lang: '' };
  const document = { documentElement: root, querySelectorAll: () => [button, draft, commit] };
  setPanelMessages({ Commit: '提交', 'Message for {branch}': '在 {branch} 提交', '{action}…': '正在{action}…' });
  setPanelLocale('en', document);
  uiText(button, msg('{action}…', { action: msg('Commit') }));
  uiAttr(draft, 'placeholder', msg('Message for {branch}', { branch: 'Commit' }));
  draft.value = 'Keep this draft';
  uiText(commit, 'Commit');
  setPanelLocale('zh-CN', document);
  assert.equal(button.textContent, '正在提交…');
  assert.equal(draft.attributes.placeholder, '在 Commit 提交');
  assert.equal(draft.value, 'Keep this draft');
  assert.equal(commit.textContent, 'Commit');
  assert.equal(root.lang, 'zh-CN');
  setPanelLocale('en', document);
  assert.equal(button.textContent, 'Commit…');
  assert.equal(draft.attributes.placeholder, 'Message for Commit');
  assert.equal(root.lang, 'en');
});

test('locale preference restores from either store and defaults to Simplified Chinese', async () => {
  const { readPanelLanguage, writePanelLanguage } = await import('../plugins/source-control-proof/panel-locale.mjs');
  const items = new Map();
  const storage = { getItem: key => items.get(key), setItem: (key, value) => items.set(key, value) };
  const inaccessible = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readPanelLanguage(storage), 'zh-CN');
  writePanelLanguage('en', storage);
  assert.equal(readPanelLanguage(storage), 'en');
  assert.equal(readPanelLanguage(inaccessible, { language: 'en' }), 'en');
  assert.equal(readPanelLanguage(inaccessible, { language: 'invalid' }), 'zh-CN');
  assert.doesNotThrow(() => writePanelLanguage('zh-CN', inaccessible));
});

test('packaged panel has translations for the static controls and preserves formatter fields', async () => {
  const { panelHtml } = await import('../plugins/source-control-proof/server.mjs');
  const { actionMessages } = await import('../plugins/source-control-proof/panel-messages-actions.mjs');
  const { historyMessages } = await import('../plugins/source-control-proof/panel-messages-history.mjs');
  const { previewMessages } = await import('../plugins/source-control-proof/panel-messages-preview.mjs');
  const { shellMessages } = await import('../plugins/source-control-proof/panel-messages-shell.mjs');
  const messages = { ...shellMessages, ...actionMessages, ...historyMessages, ...previewMessages };
  const html = await panelHtml();
  const markup = html.split('<script type="module">')[0];
  assert.match(markup, /id="panel-language"[\s\S]+value="zh-CN"[\s\S]+value="en"/);
  for (const entry of markup.matchAll(/data-i18n>([^<]+)|(?:placeholder|aria-label|title)="([^"]+)"/g)) {
    const key = (entry[1] || entry[2]).trim();
    assert.ok(Object.hasOwn(messages, key), 'Missing Chinese text for ' + key);
  }
  const params = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [key, translation] of Object.entries(messages)) {
    assert.deepEqual(params(translation), params(key), 'Interpolation fields for ' + key);
  }
});
