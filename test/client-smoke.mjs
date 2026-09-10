/**
 * Client-bundle smoke test (Node): simulates window.__ModuleLoader__,
 * materializes the factory with the real react/react-dom from the dsh
 * install, runs apply() against a mock ctx, and validates the slot
 * registrations + locale dictionary parity. No browser needed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// resolve react from the dsh root and react-dom from a bundle that carries it
const dshRequire = createRequire(
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-trajectory/seed.js',
);

// A dsh install whose react/react-dom links are pruned or dangling would make
// this suite unrunnable even though it never RENDERS a component. Keep the
// real runtime when it resolves; otherwise fall back to the minimal surface
// the bundle touches at module scope (createElement + hook names) and say so.
let runtimeRequire = dshRequire;
try {
  dshRequire('react');
  dshRequire('react-dom/client');
} catch {
  console.warn('[client-smoke] real react/react-dom not resolvable from the dsh install — using a stub (no component rendering in this suite)');
  const stubReact = {
    createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useSyncExternalStore: () => null,
    Fragment: Symbol('Fragment'),
  };
  const stubReactDomClient = { createRoot: () => ({ render() {}, unmount() {} }) };
  runtimeRequire = (spec) => {
    if (spec === 'react') return stubReact;
    if (spec === 'react-dom/client') return stubReactDomClient;
    return dshRequire(spec);
  };
}

globalThis.window = globalThis;
let loadedEntry = null;
globalThis.__ModuleLoader__ = {
  load(entry) {
    loadedEntry = entry;
  },
};

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
(0, eval)(source);

assert.ok(loadedEntry, 'bundle called __ModuleLoader__.load');
assert.equal(loadedEntry.id, 'dsh-better-workspaces');
assert.equal(typeof loadedEntry.factory, 'function');

const mod = loadedEntry.factory((spec) => runtimeRequire(spec));
assert.equal(typeof mod.apply, 'function', 'exports.apply');
assert.deepEqual(mod.inject, ['slots', 'locale', 'sessions', 'workspaces']);

/* ---------------- dictionary parity + interpolation ---------------- */
let dictionaries = null;
const registrations = [];
const effects = [];
const ctx = {
  effect(fn, label) {
    const dispose = fn(ctx);
    effects.push({ label, dispose });
    return dispose;
  },
  get() {
    return undefined;
  },
  locale: {
    register(ns, dicts) {
      dictionaries = { ns, dicts };
      return () => {};
    },
    bind(ns) {
      return (key, params) => {
        let template = dictionaries.dicts.zh[key] ?? key;
        if (params) {
          template = template.replace(/\{(\w+)\}/g, (match, name) =>
            name in params ? String(params[name]) : match,
          );
        }
        return template;
      };
    },
  },
  slots: {
    inject(slotName, registerFn) {
      const dispose = registerFn();
      registrations.push({ slotName, dispose });
    },
    register(descriptor, component) {
      registrations.push({ descriptor, component });
      return () => {};
    },
  },
  sessions: {
    list: {
      getSnapshot: () => ({ byId: {}, ids: [], current: undefined, phase: 'ready' }),
      subscribe: () => () => {},
    },
    open() {},
  },
  workspaces: { items: [], create: async () => ({ ok: false }) },
};

mod.apply(ctx);

assert.ok(dictionaries, 'locale dictionaries registered');
assert.equal(dictionaries.ns, 'better-workspaces');
const zhKeys = Object.keys(dictionaries.dicts.zh).sort();
const enKeys = Object.keys(dictionaries.dicts.en).sort();
assert.deepEqual(enKeys, zhKeys, 'zh/en key parity');
assert.equal(dictionaries.dicts.zh['view.files'], '文件');
assert.equal(dictionaries.dicts.zh['view.diff'], 'diff');

const descriptors = registrations.filter((r) => r.descriptor).map((r) => r.descriptor);
const views = descriptors.filter((d) => d.name === 'conversation.view');
const docks = descriptors.filter((d) => d.name === 'conversation.input.dock');
assert.equal(views.length, 2, 'two conversation views');
assert.deepEqual(
  views.map((v) => [v.id, v.order]).sort(),
  [['diff', 30], ['files', 20]].sort(),
);
assert.equal(docks.length, 1, 'one dock occupant');
assert.equal(docks[0].id, 'git-diff-pill');
assert.equal(docks[0].order, 100);
for (const r of registrations.filter((x) => x.component)) {
  assert.equal(typeof r.component, 'function', 'component is a function');
}
// every descriptor carries an inject(sessionId) that yields {sessionId}
for (const d of descriptors) {
  assert.equal(typeof d.inject, 'function');
  assert.deepEqual(d.inject('s-1'), { sessionId: 's-1' });
  assert.equal(d.locale, 'better-workspaces');
}

// label thunks resolve through the bound locale
const filesView = views.find((v) => v.id === 'files');
const diffView = views.find((v) => v.id === 'diff');
assert.equal(filesView.label(), '文件');
assert.equal(diffView.label(), 'diff');

/* ---------------- first-send interception helpers (pure) ---------------- */
const T = mod.__bwTest;
assert.ok(T, '__bwTest helpers exported');

assert.equal(T.failureMessage({ message: 'm' }), 'm');
assert.equal(T.failureMessage({ ok: false, error: 'cwd required' }), 'cwd required');
assert.equal(T.failureMessage({ ok: false, error: { message: 'deep' } }), 'deep');
assert.equal(T.failureMessage({ ok: false }), null);
assert.equal(T.basenameOf('/a/b/repo/'), 'repo');
assert.equal(T.basenameOf('/a/b/repo'), 'repo');
assert.match(T.mnemonicSlug(), /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);

// file icon resolver (vendored table + Oklab tone)
const tsIcon = T.getFileIconSvg('app.ts');
assert.ok(tsIcon.includes('<svg'), 'ts icon renders svg');
assert.notEqual(tsIcon, T.getFileIconSvg('no-such-file.xyz'), 'extension maps to its own icon');
assert.equal(T.getFileIconSvg('README'), T.getFileIconSvg('no-such-file.xyz'), 'unknown falls back to default');
assert.match(T.desaturateHexColor('#ff0000', 0.65), /^#[0-9a-f]{6}$/);
assert.notEqual(T.desaturateHexColor('#ff0000', 0.65), '#ff0000');

// new picker/editor dict keys
assert.equal(dictionaries.dicts.zh['hero.localSuffix'], '（本地）');
assert.equal(dictionaries.dicts.en['hero.localSuffix'], ' (local)');
assert.equal(dictionaries.dicts.en['files.conflict'], 'File changed on disk since load');
assert.equal(dictionaries.dicts.zh['diff.editFile'], '编辑');
assert.equal(dictionaries.dicts.zh['diff.modeSession'], '本会话');
assert.equal(dictionaries.dicts.en['diff.modeTask'], 'Task');

// per-session touched-path extraction helpers
const found = new Set();
T.collectTouched([{ type: 'tool_use', name: 'Edit', input: { file_path: '/ws/a/b.txt' } }, { type: 'tool_use', name: 'bash', input: { command: 'rm x' } }], found, 0);
assert.deepEqual([...found], ['/ws/a/b.txt']);
const norm = T.normalizeTouchedPaths(new Set(['/ws/a/b.txt', 'rel/c.txt', '/other/d.txt']), '/ws');
assert.deepEqual([...norm].sort(), ['a/b.txt', 'rel/c.txt']);

/* ---------------- hero mode menu (UI regression) ---------------- */
const fakeT = (key) => dictionaries.dicts.zh[key] ?? key;
assert.deepEqual(T.heroModeItems(false, fakeT), [
  { id: 'local', label: '本地', active: true },
  { id: 'new', label: '新建 worktree', active: false },
], 'local mode: 本地 is offered and active, 新建 worktree is offered');
assert.deepEqual(T.heroModeItems(true, fakeT), [
  { id: 'local', label: '本地', active: false },
  { id: 'new', label: '新建 worktree', active: true },
], 'staging mode: the 本地 escape hatch stays selectable');

/* ---------------- cwd-tagged detection (cross-workspace rename) ---------------- */
const detectValue = { ok: true, isGit: true, isLinkedWorktree: true, managed: true };
assert.equal(T.liveDetect(null, '/a'), null, 'no detection yet');
assert.equal(T.liveDetect(undefined, '/a'), null, 'no detection yet');
assert.equal(T.liveDetect({ cwd: '/a', value: detectValue }, '/a'), detectValue, 'same-cwd detection is readable');
// the reported bug: switching sessions rendered the NEW cwd with the OLD
// detection, whose sourceWorkspaceTitle then renamed an unrelated workspace
assert.equal(T.liveDetect({ cwd: '/a', value: detectValue }, '/b'), null, 'a detection never crosses cwd');
assert.equal(T.liveDetect({ cwd: '/a', value: detectValue }, null), null, 'no cwd → no detection');
assert.equal(T.liveDetect({ cwd: null, value: detectValue }, '/a'), null, 'untagged detection is unusable');

// staging dictionary keys present in both locales
assert.equal(dictionaries.dicts.zh['hero.stageHint'], '选定基分支即创建并跳转，草稿随迁');
assert.equal(dictionaries.dicts.zh['hero.blockReason'], '正在创建隔离 Worktree…');
assert.equal(dictionaries.dicts.en['hero.stageCreateFallback'], 'Create now');
assert.equal(dictionaries.dicts.zh['hero.modeWorktreePick'], undefined, 'two-item menu: pick variant removed');
assert.equal(dictionaries.dicts.zh['hero.stageAttachWarn'], undefined, 'attach warning removed with the intercept');
assert.equal(dictionaries.dicts.zh['hero.modeLocal'], '本地');
assert.equal(dictionaries.dicts.en['hero.modeLocal'], 'Local');
assert.equal(dictionaries.dicts.zh['hero.modeWorktree'], '新建 worktree');
assert.equal(dictionaries.dicts.en['hero.modeWorktree'], 'New worktree');

console.log('CLIENT SMOKE: ALL PASS');
process.exit(0);
