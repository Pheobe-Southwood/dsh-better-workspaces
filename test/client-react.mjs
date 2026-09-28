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

/* ---------------- sidebar badge row vs the late-mounted time cell ---------------- */
/* A blank session row renders only slot+title: DSH gates `.time`, the pin marker
   and `.rowActions` on `!row.blank`, so they mount only after the first message.
   React appends those freshly mounted cells at the row's actual end — behind the
   badge container the injector appended earlier — which made the 100%-wide badge
   row own the first line and pushed the timestamp onto the next line at the
   content start. The fix is two-part: the badge rule carries `order: 1` so the
   visual line cannot depend on DOM order, and pass() moves the injected node
   back so the DOM order agrees too. This drives the real apply() wiring. */
const rowHost = document.createElement('div');
document.body.appendChild(rowHost);
function BlankableRow({ node, blank }) {
  return React.createElement('div', { className: 'Rows_sessionRow__t bw-blank-row', 'data-session': node.id },
    React.createElement('span', { className: 'Rows_slot__t' }),
    React.createElement('span', { className: 'Rows_title__t' }, 'scratch'),
    blank ? null : React.createElement('span', { className: 'Rows_time__t' }, '1h'),
    blank ? null : React.createElement('span', { className: 'Rows_pinIndicator__t' }),
    blank ? null : React.createElement('span', { className: 'Rows_rowActions__t' }),
  );
}
function AnchorlessRow() {
  return React.createElement('div', { className: 'Rows_sessionRow__t bw-anchorless-row' },
    React.createElement('span', { className: 'Rows_slot__t' }),
  );
}

const appliedEffects = [];
const sidebarSessions = {
  byId: { 'bw-regression-sess': { title: 'scratch' } },
  ids: ['bw-regression-sess'], current: 'bw-regression-sess', phase: 'ready',
};
const rowSidebarRightTabs = { register: () => () => {} };
const mockCtx = {
  sidebarRightTabs: rowSidebarRightTabs,
  effect(fn, label) {
    const dispose = fn(mockCtx);
    appliedEffects.push({ label, dispose });
    return dispose;
  },
  get(name) {
    if (name === 'sidebarRightTabs') return rowSidebarRightTabs;
    if (name === 'sidebarRight') return { openTab() {} };
    return undefined;
  },
  inject(deps, callback) {
    if (deps.includes('inputTriggers')) callback({ ...mockCtx, inputTriggers: { registerSource: () => () => {} } });
    else callback(mockCtx);
    return { dispose() {} };
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: { inject(_name, registerFn) { registerFn(); return () => {}; }, register: () => () => {} },
  sessions: { list: { getSnapshot: () => sidebarSessions, subscribe: () => () => {} } },
  workspaces: { items: [], list: { subscribe: () => () => {} } },
};

const previousFetch = window.fetch;
window.fetch = async () => { throw new Error('offline: the row scenario has no host'); };
globalThis.fetch = window.fetch;
const rowRoot = createRoot(rowHost);
await act(async () => {
  rowRoot.render(React.createElement(React.Fragment, null,
    React.createElement(BlankableRow, { node: { id: 'bw-regression-sess' }, blank: true }),
    React.createElement(AnchorlessRow),
  ));
});
await act(async () => { mod.apply(mockCtx); });

const blankRow = rowHost.querySelector('.bw-blank-row');
const anchorlessRow = rowHost.querySelector('.bw-anchorless-row');
assert.ok(blankRow && anchorlessRow, 'both session rows rendered');
const badges = blankRow.querySelector('.dsh-bw-badges');
assert.ok(badges, 'the injector appended a badge row to the session row');
/* DOM nodes are compared through cheap strings: assert.equal on two jsdom
   elements deep-inspects both on failure, which is what makes a failing run
   explode instead of reporting. */
const lastChildClass = (row) => (row.lastElementChild ? row.lastElementChild.className : null);
assert.equal(lastChildClass(blankRow), 'dsh-bw-badges', 'a blank row ends with the badge row');
assert.ok(!anchorlessRow.querySelector('.dsh-bw-badges'),
  'a row without the title anchor degrades without injecting');

/* First message: DSH mounts the trailing cells, React appends them behind the
   injected node — reproduce that exact DOM before asserting the fix. */
await act(async () => {
  rowRoot.render(React.createElement(React.Fragment, null,
    React.createElement(BlankableRow, { node: { id: 'bw-regression-sess' }, blank: false }),
    React.createElement(AnchorlessRow),
  ));
});
const timeCell = blankRow.querySelector('.Rows_time__t');
const pinCell = blankRow.querySelector('.Rows_pinIndicator__t');
const actionCell = blankRow.querySelector('.Rows_rowActions__t');
assert.ok(timeCell && pinCell && actionCell, 'the first message mounts the trailing cells');
assert.notEqual(lastChildClass(blankRow), 'dsh-bw-badges',
  'reproduced: React mounted the trailing cells behind the injected badge row');
assert.ok((badges.compareDocumentPosition(timeCell) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  'reproduced: the time cell follows the badge row in DOM order');

/* pass() runs on a 300 ms debounce behind the MutationObserver; poll so the
   assertion is about the self-heal, not about timing. */
const healDeadline = Date.now() + 2000;
while (lastChildClass(blankRow) !== 'dsh-bw-badges' && Date.now() < healDeadline) {
  await new Promise((resolve) => { setTimeout(resolve, 25); });
}
assert.equal(lastChildClass(blankRow), 'dsh-bw-badges',
  'pass() moved the badge row behind the late-mounted trailing cells');
for (const cell of [timeCell, pinCell, actionCell]) {
  assert.ok((cell.compareDocumentPosition(badges) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    'every native cell precedes the badge row once healed');
}

const pluginStyle = document.querySelector('style[data-plugin-css="dsh-better-workspaces/client.css"]');
assert.ok(pluginStyle, 'the plugin stylesheet is mounted');
const badgesRule = /\.dsh-bw-badges\s*\{([^{}]*)\}/.exec(pluginStyle.textContent);
assert.ok(badgesRule, 'the badge row rule is present');
assert.ok(/(^|[;\s])order:\s*1\b/.test(badgesRule[1]),
  'the badge row carries order:1 so its line cannot depend on DOM order');

const domEffect = appliedEffects.find((entry) => entry.label === 'better-workspaces: dom injection');
assert.ok(domEffect, 'the DOM injection effect is registered');
await act(async () => { domEffect.dispose(); });
assert.equal(document.querySelectorAll('.dsh-bw-badges').length, 0,
  'dispose removes every injected badge row (ADR 0001)');
for (const entry of [...appliedEffects].reverse()) {
  if (entry === domEffect) continue;
  if (entry.dispose) entry.dispose();
}
assert.equal(document.querySelectorAll('style[data-plugin-css="dsh-better-workspaces/client.css"]').length, 1,
  'releasing the applied package keeps the surviving stylesheet reference');
await act(async () => { rowRoot.unmount(); });
rowHost.remove();
window.fetch = previousFetch;
globalThis.fetch = window.fetch;

releaseSecondCss();
assert.equal(document.querySelectorAll('style[data-plugin-css="dsh-better-workspaces/client.css"]').length, 0,
  'the final package cleanup removes the shared style');

dom.window.close();
console.log('CLIENT REACT: ALL PASS');
