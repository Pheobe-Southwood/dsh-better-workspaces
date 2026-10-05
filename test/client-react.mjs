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

/* ------------------------------------------------------------------ *
 * hero cwd resolution when the Session has none yet (ADR 0001/0002)
 *
 * A blank Session can belong to a Workspace while its own `cwd` is still
 * undefined, and that is precisely the state the hero control exists for.
 * Reading the path off the owning Workspace is what the official picker does;
 * with no fallback the control rendered nothing at all.
 * ------------------------------------------------------------------ */
const { heroCwdFor, heroControlKey } = mod.__bwTest;
{
  const items = [{ workspaceId: 'w1', path: '/repo-w1', title: 'W1', sessionIds: ['s1', 's2'] }];
  assert.equal(heroCwdFor({ cwd: '/repo-bound' }, 's1', items), '/repo-bound',
    'a Session-carried cwd wins over membership');
  assert.equal(heroCwdFor({}, 's1', items), '/repo-w1',
    'a Session with no cwd resolves through its owning Workspace');
  assert.equal(heroCwdFor(undefined, 's1', items), '/repo-w1',
    'membership is still enough when the summary is missing');
  assert.equal(heroCwdFor({}, 's9', items), null,
    'a Session owned by no Workspace resolves to nothing rather than guessing');
  assert.equal(heroCwdFor({}, undefined, items), null, 'no current Session resolves to nothing');
  assert.equal(heroCwdFor({}, 's1', null), null, 'an absent Workspace store resolves to nothing');
  assert.equal(heroCwdFor({ cwd: '' }, 's1', items), '/repo-w1', 'an empty cwd falls through to membership');

  // the Workspace row shapes that must be skipped, not crashed on
  const odd = [
    { workspaceId: 'x', path: '', sessionIds: ['s1'] },
    { workspaceId: 'y', sessionIds: ['s1'] },
    { workspaceId: 'z', path: '/repo-z' },
    { workspaceId: 'w', path: '/repo-w', sessionIds: 's1' },
  ];
  assert.equal(heroCwdFor({}, 's1', odd), null, 'malformed Workspace rows are skipped');

  assert.notEqual(heroControlKey('s1', '/a'), heroControlKey('s1', '/b'),
    'the control key moves when the resolved cwd moves');
  assert.equal(heroControlKey('s1', '/a'), heroControlKey('s1', '/a'), 'the key is stable otherwise');

  // The source is what makes a report legible: "hidden although the session
  // carries this cwd" and "hidden because nothing resolved" are different bugs.
  const { heroResolve } = mod.__bwTest;
  const resolveCases = [
    [{ cwd: '/repo-bound' }, 's1', { cwd: '/repo-bound', source: 'session' }, 'a session cwd reports itself as the source'],
    [{}, 's1', { cwd: '/repo-w1', source: 'workspace' }, 'a workspace-derived cwd reports the workspace as the source'],
    [{}, 's9', { cwd: null, source: null }, 'an unresolved cwd names no source'],
    [{ cwd: '/elsewhere' }, 's1', { cwd: '/elsewhere', source: 'session' }, 'a bound session cwd outranks workspace membership'],
  ];
  for (const [summary, id, expected, label] of resolveCases) {
    const actual = heroResolve(summary, id, items);
    assert.equal(actual.cwd, expected.cwd, `${label} (cwd)`);
    assert.equal(actual.source, expected.source, `${label} (source)`);
  }

  // projection must be total and must not leak the stores' own objects
  const { projectSessionSnapshot, projectWorkspaceSnapshot } = mod.__bwTest;
  assert.equal(projectSessionSnapshot(null), null, 'a missing session snapshot projects to null');
  assert.equal(projectSessionSnapshot(undefined), null, 'an undefined session snapshot projects to null');
  const projected = projectSessionSnapshot({ current: 's1', ids: ['s1'], phase: 'ready', byId: { s1: { title: 'T' } } });
  assert.equal(projected.current, 's1');
  assert.equal(projected.ids.length, 1, 'ids project through');
  assert.equal(projected.ids[0], 's1');
  assert.equal(projected.phase, 'ready');
  assert.equal(projected.byId.s1.cwd, null,
    'a session without cwd projects an explicit null rather than dropping the field');
  assert.equal(projected.byId.s1.title, 'T');
  assert.equal(projectWorkspaceSnapshot(null), null, 'a missing Workspace snapshot projects to null');
  const oddWorkspace = projectWorkspaceSnapshot({ items: [{ workspaceId: 'w' }] }).items[0];
  assert.equal(oddWorkspace.workspaceId, 'w');
  assert.equal(oddWorkspace.sessionIds.length, 0,
    'malformed Workspace rows project safely instead of throwing');
  assert.equal(projectWorkspaceSnapshot({ items: [{ workspaceId: 'w', sessionIds: ['a'] }] }).items[0].sessionIds[0], 'a',
    'Workspace session membership projects through');
}

/* The real component, in the state that matters: a blank Session whose cwd
   comes only from its Workspace membership. */
{
  const blankSnapshot = { byId: { s1: { title: 'blank' } }, ids: ['s1'], current: 's1', phase: 'ready' };
  const workspaceListeners = new Set();
  // `useSyncExternalStore` requires a stable snapshot identity: a store that
  // builds a fresh object per read would re-render forever, so this stand-in
  // owns one object exactly as the real controller does.
  let workspaceSnapshot = { items: [], phase: 'ready' };
  const setWorkspaces = (items) => {
    workspaceSnapshot = { items, phase: 'ready' };
    for (const listener of workspaceListeners) listener();
  };
  const restoreBlank = mod.__bwTest.setTestRuntime({
    get: () => undefined,
    sessions: { list: { getSnapshot: () => blankSnapshot, subscribe: () => () => {} } },
    workspaces: {
      list: {
        getSnapshot: () => workspaceSnapshot,
        subscribe(listener) { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener); },
      },
    },
  });
  const previousFetch = window.fetch;
  window.fetch = async (url) => {
    const parsed = new URL(String(url), window.location.href);
    if (parsed.pathname.endsWith('/detect') && parsed.searchParams.get('path') === '/repo-w1') {
      return { json: async () => ({ ok: true, isGit: true, isLinkedWorktree: false, managed: false }) };
    }
    throw new Error(`unexpected blank-hero request: ${parsed.pathname}${parsed.search}`);
  };
  globalThis.fetch = window.fetch;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  // no membership yet → nothing, and no guess
  await act(async () => { root.render(React.createElement(mod.__bwTest.HeroControl)); });
  assert.equal(container.querySelector('.dsh-bw-hero-label'), null,
    'no Workspace membership and no cwd keeps the control hidden');

  // membership arrives, cwd is still absent from the Session
  await act(async () => {
    setWorkspaces([{ workspaceId: 'w1', path: '/repo-w1', title: 'W1', sessionIds: ['s1'] }]);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(container.querySelector('.dsh-bw-hero-label')?.textContent, 'hero.modeLocal',
    'the control appears for a blank Session once its Workspace is known');

  // a linked worktree Workspace must stay hidden even though it resolves
  window.fetch = async (url) => {
    const parsed = new URL(String(url), window.location.href);
    if (parsed.pathname.endsWith('/detect') && parsed.searchParams.get('path') === '/repo-w2') {
      return { json: async () => ({ ok: true, isGit: true, isLinkedWorktree: true, managed: true }) };
    }
    throw new Error(`unexpected blank-hero request: ${parsed.pathname}${parsed.search}`);
  };
  globalThis.fetch = window.fetch;
  await act(async () => {
    setWorkspaces([{ workspaceId: 'w2', path: '/repo-w2', title: 'W2', sessionIds: ['s1'] }]);
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(container.querySelector('.dsh-bw-hero-label'), null,
    'a linked-worktree Workspace keeps hiding the control (staging inside one is not offered)');

  await act(async () => { root.unmount(); });
  container.remove();
  window.fetch = previousFetch;
  globalThis.fetch = window.fetch;
  restoreBlank();
}

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

/* The diagnostic surface must exist while the plugin is mounted: it is the
   only way to separate "never injected" from "injected but hidden" in a bug
   report, so its presence and shape are part of the contract. */
{
  const hook = window.__dshBwDebug;
  assert.ok(hook, 'apply installs window.__dshBwDebug');
  for (const name of ['sessions', 'workspaces', 'hero', 'probe', 'describeOnScreen']) {
    assert.equal(typeof hook[name], 'function', `__dshBwDebug.${name} is callable`);
  }
  // every reader must be total: a diagnostic that throws is worse than none
  assert.doesNotThrow(() => hook.sessions(), 'sessions() is safe before any session is seen');
  assert.doesNotThrow(() => hook.workspaces(), 'workspaces() is safe before any Workspace is seen');
  assert.doesNotThrow(() => hook.hero(), 'hero() is safe');
  assert.doesNotThrow(() => hook.probe(), 'probe() is safe');
  const onScreen = hook.describeOnScreen();
  assert.equal(typeof onScreen.rowFound, 'boolean', 'describeOnScreen reports the DOM verdict');
  assert.ok(Object.hasOwn(onScreen, 'source'), 'the resolution source is reported');
  assert.ok(Object.hasOwn(onScreen, 'resolvedCwd'), 'the resolved cwd is reported');
}

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

/* ------------------------------------------------------------------ *
 * hero injection anchors (ADR 0001 Amendment 1)
 *
 * Every slot is wrapped by the slot framework in an anchor div carrying
 * `data-slot` and `style="display: contents"`, so that wrapper — not the
 * layout row — is the slot's parentElement. Reading the row off
 * `parentElement` silently degraded the worktree control while every guard
 * still looked satisfied. This case renders the REAL production nesting
 * inside the live `apply` window.
 * ------------------------------------------------------------------ */
{
  const { isHeroRow, nearestLayoutAncestor } = mod.__bwTest;
  const row = document.createElement('div');
  row.className = 'wSkVaW_heroWorkspaceRow';
  const chip = document.createElement('button');
  chip.className = 'wSkVaW_chip';
  row.appendChild(chip);
  const outlet = document.createElement('div');
  outlet.setAttribute('data-slot', 'conversation.hero.agentPreset');
  outlet.style.display = 'contents';
  row.appendChild(outlet);
  document.body.appendChild(row);

  assert.equal(isHeroRow(nearestLayoutAncestor(outlet)), true,
    'climbing from the preset slot past the display:contents outlet reaches the hero row');

  // pass() runs on a 300 ms debounce behind the MutationObserver; poll so the
  // assertion is about the anchor logic, not about timing.
  await act(async () => {
    const heroDeadline = Date.now() + 2000;
    while (!row.querySelector(':scope > .dsh-bw-hero') && Date.now() < heroDeadline) {
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
  });
  const injected = row.querySelector(':scope > .dsh-bw-hero');
  assert.ok(injected, 'the worktree control is injected into the hero row despite the slot outlet wrapper');
  assert.equal(row.querySelectorAll('.dsh-bw-hero').length, 1, 'exactly one control instance');
  assert.equal(injected.parentElement, row,
    'the control is a direct child of the layout row, not of the display:contents wrapper');

  const before = injected;
  await act(async () => {
    const settleDeadline = Date.now() + 1200;
    while (Date.now() < settleDeadline) await new Promise((resolve) => { setTimeout(resolve, 50); });
  });
  assert.equal(row.querySelector('.dsh-bw-hero'), before,
    'later passes reuse the same control element instead of remounting it');

  row.remove();
  assert.equal(document.querySelectorAll('.dsh-bw-hero').length, 0, 'removing the row drops the control');
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
assert.equal(window.__dshBwDebug, undefined,
  'disposing every effect removes the diagnostic global (no residue on window)');
assert.equal(document.querySelectorAll('style[data-plugin-css="dsh-better-workspaces/client.css"]').length, 1,
  'releasing the applied package keeps the surviving stylesheet reference');
await act(async () => { rowRoot.unmount(); });
rowHost.remove();
window.fetch = previousFetch;
globalThis.fetch = window.fetch;

releaseSecondCss();
assert.equal(document.querySelectorAll('style[data-plugin-css="dsh-better-workspaces/client.css"]').length, 0,
  'the final package cleanup removes the shared style');

/* ------------------------------------------------------------------ *
 * hero anchor helpers, off the live window (no app runtime needed —
 * these exercise the climb and the degrade path, not HeroControl).
 * ------------------------------------------------------------------ */
const { createHeroInjector, nearestLayoutAncestor: climb, isHeroRow: heroRowish } = mod.__bwTest;

// a display:contents outlet is skipped; the layout row behind it is returned
{
  const row = document.createElement('div');
  row.className = 'wSkVaW_heroWorkspaceRow';
  const outlet = document.createElement('div');
  outlet.style.display = 'contents';
  row.appendChild(outlet);
  document.body.appendChild(row);
  assert.equal(climb(outlet), row, 'the climb skips a display:contents wrapper');
  assert.equal(heroRowish(climb(outlet)), true, 'the climb lands on the hero row');

  // a wrapper that renders nothing owns no box either
  const empty = document.createElement('div');
  outlet.appendChild(empty);
  assert.equal(climb(empty), row, 'an empty emission wrapper is skipped too');

  // the depth cap stops a pathological tree instead of walking to document.body
  let deep = outlet;
  for (let i = 0; i < 12; i += 1) {
    const wrap = document.createElement('div');
    wrap.style.display = 'contents';
    deep.appendChild(wrap);
    deep = wrap;
  }
  assert.equal(climb(deep), null, 'the climb gives up past the depth cap rather than returning a wrong node');
  row.remove();
}

// negative: a hero row that is structurally unrecognizable must not receive a control
{
  const stray = document.createElement('div');
  stray.setAttribute('data-slot', 'conversation.hero.agentPreset');
  document.body.appendChild(stray);
  const injector = createHeroInjector();
  assert.doesNotThrow(() => injector.start(), 'a missing hero row degrades silently');
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  assert.equal(document.querySelectorAll('.dsh-bw-hero').length, 0, 'nothing is injected without a hero row');
  await act(async () => { injector.dispose(); });
  stray.remove();
}

dom.window.close();
console.log('CLIENT REACT: ALL PASS');
