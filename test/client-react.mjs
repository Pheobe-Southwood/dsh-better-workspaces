import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:3080/',
  runScripts: 'outside-only',
  virtualConsole: new VirtualConsole(),
});
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'AbortController']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const ReactModule = await import('react');
const React = ReactModule.default;
const { act } = ReactModule;
const { createRoot } = await import('react-dom/client');

let loadedEntry = null;
window.__ModuleLoader__ = { load(entry) { loadedEntry = entry; } };
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
window.eval(source);
assert.ok(loadedEntry, 'the browser bundle registers with ModuleLoader');
const mod = loadedEntry.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom/client') return { createRoot };
  throw new Error(`unexpected client dependency: ${specifier}`);
});

const secondMod = loadedEntry.factory((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react-dom/client') return { createRoot };
  throw new Error(`unexpected client dependency: ${specifier}`);
});

// Two independently materialized client packages model an HMR overlap. Both
// must share one adopted style tag, and releasing the older package must not
// remove CSS still owned by the newer one.
const legacyStyle = document.createElement('style');
legacyStyle.dataset.pluginCss = 'dsh-better-workspaces/client.css';
legacyStyle.textContent = 'legacy';
document.head.appendChild(legacyStyle);
const releaseFirstCss = mod.__bwTest.mountCss();
const releaseSecondCss = secondMod.__bwTest.mountCss();
let styles = document.querySelectorAll('style[data-plugin-css="dsh-better-workspaces/client.css"]');
assert.equal(styles.length, 1, 'overlapping packages adopt one shared style element');
assert.notEqual(styles[0].textContent, 'legacy', 'the adopted style receives current CSS');
releaseFirstCss();
releaseFirstCss();
styles = document.querySelectorAll('style[data-plugin-css="dsh-better-workspaces/client.css"]');
assert.equal(styles.length, 1, 'releasing an older package retains CSS for the live package');

// Keyed Hero resources must abort and ignore the old cwd when the session store
// switches before detection settles.
let sessionSnapshot = {
  byId: { a: { cwd: '/repo-a', title: 'A' } }, ids: ['a'], current: 'a', phase: 'ready',
};
const sessionListeners = new Set();
const restoreRuntime = mod.__bwTest.setTestRuntime({
  get: () => undefined,
  sessions: {
    list: {
      getSnapshot: () => sessionSnapshot,
      subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
    },
  },
  workspaces: { items: [] },
});
let resolveDetectA;
let detectASignal = null;
window.fetch = (url, options = {}) => {
  const parsed = new URL(String(url), window.location.href);
  if (parsed.pathname.endsWith('/detect') && parsed.searchParams.get('path') === '/repo-a') {
    detectASignal = options.signal;
    return new Promise((resolve) => { resolveDetectA = () => resolve({ json: async () => ({ ok: true, isGit: true, isLinkedWorktree: true, managed: true }) }); });
  }
  if (parsed.pathname.endsWith('/detect') && parsed.searchParams.get('path') === '/repo-b') {
    return Promise.resolve({ json: async () => ({ ok: true, isGit: true, isLinkedWorktree: false, managed: false }) });
  }
  throw new Error(`unexpected Hero request: ${parsed.pathname}${parsed.search}`);
};
globalThis.fetch = window.fetch;
const heroContainer = document.createElement('div');
document.body.appendChild(heroContainer);
const heroRoot = createRoot(heroContainer);
await act(async () => { heroRoot.render(React.createElement(mod.__bwTest.HeroControl)); });
assert.equal(typeof resolveDetectA, 'function', 'session A starts detection');
sessionSnapshot = {
  byId: { b: { cwd: '/repo-b', title: 'B' } }, ids: ['b'], current: 'b', phase: 'ready',
};
await act(async () => {
  for (const listener of sessionListeners) listener();
  await Promise.resolve();
  await Promise.resolve();
});
assert.equal(detectASignal?.aborted, true, 'switching cwd aborts session A detection');
assert.equal(heroContainer.querySelector('.dsh-bw-hero-label')?.textContent, 'hero.modeLocal', 'session B renders its local Git mode');
await act(async () => {
  resolveDetectA();
  await Promise.resolve();
  await Promise.resolve();
});
assert.equal(heroContainer.querySelector('.dsh-bw-hero-label')?.textContent, 'hero.modeLocal', 'late session A detection cannot hide session B');
await act(async () => { heroRoot.unmount(); });
heroContainer.remove();
restoreRuntime();

// Mount a real hook-using component. This covers effect setup/cleanup, request
// cancellation, modal semantics, focus trapping and focus restoration with the
// same React runtime used by package consumers.
const prior = document.createElement('button');
prior.textContent = 'before picker';
document.body.appendChild(prior);
prior.focus();
let requestSignal = null;
window.fetch = async (_url, options = {}) => {
  requestSignal = options.signal;
  return {
    json: async () => ({
      ok: true,
      authState: 'authenticated',
      items: [{
        host: 'github.com', owner: 'acme', repo: 'widget', kind: 'change_request',
        number: 7, title: 'Fix focus', state: 'OPEN', fork: false,
      }],
    }),
  };
};
globalThis.fetch = window.fetch;
const attached = mod.__bwTest.encodeForgeRef({
  host: 'github.com', owner: 'acme', repo: 'widget', kind: 'change_request', number: 7,
});
let closeCount = 0;
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => {
  root.render(React.createElement(mod.__bwTest.ForgePicker, {
    cwd: '/repo',
    attached: [attached],
    onClose: () => { closeCount += 1; },
    onPick: () => assert.fail('an attached row must not be selectable'),
  }));
  await Promise.resolve();
  await Promise.resolve();
});
const dialog = container.querySelector('[role="dialog"]');
assert.ok(dialog, 'the picker renders a dialog');
assert.equal(dialog.getAttribute('aria-modal'), 'true');
const search = dialog.querySelector('input');
const close = dialog.querySelector('.dsh-bw-forge-close');
const row = dialog.querySelector('.dsh-bw-forge-row');
assert.equal(document.activeElement, search, 'opening moves focus into the search field');
assert.equal(row.disabled, true, 'an attached forge row is disabled');
close.focus();
close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
assert.equal(document.activeElement, search, 'Tab wraps from the last enabled control to the first');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
assert.equal(closeCount, 1, 'Escape requests picker closure');
await act(async () => { root.unmount(); });
assert.equal(requestSignal?.aborted, true, 'unmount aborts the picker request owner');
assert.equal(document.activeElement, prior, 'unmount restores the previously focused element');
container.remove();

releaseSecondCss();
assert.equal(document.querySelectorAll('style[data-plugin-css="dsh-better-workspaces/client.css"]').length, 0,
  'the final package cleanup removes the shared style');

dom.window.close();
console.log('CLIENT REACT: ALL PASS');
