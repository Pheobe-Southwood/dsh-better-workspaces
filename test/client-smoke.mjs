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
/* The official right Sidebar is present in this install: the plugin's diff page
   type registers through the service-gated child fiber real cordis starts. */
const tabTypes = [];
const sidebarRightTabs = {
  register(definition) {
    tabTypes.push(definition);
    return () => {};
  },
};
const sidebarRight = { openTab() {} };
/* The trigger pipeline: the forge reference codec registers here. */
const triggerSources = [];
const inputTriggers = {
  registerSource(source) {
    triggerSources.push(source);
    return () => {};
  },
};

const ctx = {
  // a hard inject would make `sidebarRightTabs` a ctx property inside the fiber
  sidebarRightTabs,
  effect(fn, label) {
    const dispose = fn(ctx);
    effects.push({ label, dispose });
    return dispose;
  },
  get(name) {
    if (name === 'sidebarRightTabs') return sidebarRightTabs;
    if (name === 'sidebarRight') return sidebarRight;
    return undefined;
  },
  inject(deps, callback) {
    assert.ok(
      deps.includes('sidebarRightTabs') || deps.includes('inputTriggers'),
      `unexpected service-gated child fiber: ${deps.join(', ')}`,
    );
    if (deps.includes('inputTriggers')) {
      callback({ ...ctx, inputTriggers });
      return { dispose() {} };
    }
    assert.ok(
      deps.includes('sidebarRightTabs'),
      'the diff page waits for the right Sidebar tab registry instead of injecting it',
    );
    callback(ctx);
    return { dispose() {} };
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
assert.equal(dictionaries.dicts.zh['view.diff'], 'diff');
assert.equal(dictionaries.dicts.zh['view.files'], undefined, 'the 文件 conversation view is gone');

const descriptors = registrations.filter((r) => r.descriptor).map((r) => r.descriptor);
const views = descriptors.filter((d) => d.name === 'conversation.view');
const docks = descriptors.filter((d) => d.name === 'conversation.input.dock');
assert.equal(views.length, 0, 'the plugin no longer contributes conversation views');
assert.equal(docks.length, 1, 'one dock occupant');
assert.equal(docks[0].id, 'git-diff-pill');
assert.equal(docks[0].order, 100);
for (const r of registrations.filter((x) => x.component)) {
  assert.equal(typeof r.component, 'function', 'component is a function');
}
// every remaining descriptor carries an inject(sessionId) that yields {sessionId}
for (const d of [...docks, ...descriptors.filter((x) => x.name === 'conversation.input.left')]) {
  assert.equal(typeof d.inject, 'function');
  assert.deepEqual(d.inject('s-1'), { sessionId: 's-1' });
  assert.equal(d.locale, 'better-workspaces');
}

/* ---------------- the composer's forge (issue / PR) control ---------------- */
/* ADR 0008: the two native composer controls are hardcoded in the official
   InputBar and are deliberately untouched; this is the ONLY composer addition,
   and it lands in the one additive slot (which renders after them). */
const leftSlots = descriptors.filter((d) => d.name === 'conversation.input.left');
assert.equal(leftSlots.length, 1, 'exactly one additive composer control');
assert.equal(leftSlots[0].id, 'forge-issue-pr');
assert.equal(leftSlots[0].order, 200);
/* the reference source is what makes a chip carry the full paseo text to the
   model while the composer shows only its label — it must ride the plugin's
   own lifetime, or an inserted chip would block every send */
assert.equal(triggerSources.length, 1, 'the forge reference source is registered');
const forgeSource = triggerSources[0];
assert.equal(forgeSource.trigger, '@');
assert.equal(forgeSource.name, 'better-workspaces-forge');
assert.equal(typeof forgeSource.codec, 'object', 'a codec is what turns a chip into model text');
assert.equal(typeof forgeSource.codec.serialize, 'function');
assert.equal(forgeSource.codec.clipboardText('7'), '@7');
/* NOT `candidates === undefined`: the controller's roster loop calls
   `candidates(...)` synchronously on every `@` hit, so an omitted hook throws
   inside the loop and every source ordered after this one stops answering.
   "No candidates of my own" is an empty list, and it must still be a promise. */
assert.equal(typeof forgeSource.candidates, 'function', 'the @ roster loop calls this hook unconditionally');
assert.deepEqual(await forgeSource.candidates({}, { query: '' }), [], 'this source never contributes @ rows');
/* Replay the controller's roster loop shape: EVERY registered source must
   answer synchronously without throwing. This is the assertion that fails when
   a hook is merely omitted (the real menu then loses every source after it),
   so it must not be replaced by a `=== undefined` check. */
for (const source of triggerSources) {
  const pending = source.candidates({ sessionId: 's-1' }, { query: '', position: 0, drilled: false });
  assert.equal(typeof pending.then, 'function', `${source.name}: candidates must return a promise`);
  assert.ok(Array.isArray(await pending), `${source.name}: candidates must resolve to a list`);
}
assert.equal(typeof forgeSource.lexicon, 'function', 'the lexicon decorates a persisted @N draft');
assert.ok(Array.isArray(forgeSource.lexicon()), 'lexicon answers a roll, never undefined');
/* A roll that never changes after warm would leave a freshly attached ref
   undecorated, so the source must publish its invalidation channel too. */
assert.equal(typeof forgeSource.subscribeLexicon, 'function', 'the lexicon roll announces its changes');
let lexiconPings = 0;
const offLexicon = forgeSource.subscribeLexicon({ sessionId: 's-1' }, () => { lexiconPings += 1; });
assert.equal(typeof offLexicon, 'function', 'subscribing the roll returns its disposer');
offLexicon();
assert.equal(lexiconPings, 0, 'nothing is announced before anything is attached');
assert.deepEqual(forgeSource.lexicon(), [], 'nothing is attachable until something was attached');
assert.equal(await forgeSource.codec.serialize('7', { aborted: false }).then(() => 'no', () => 'threw'), 'threw',
  'a ref without a repository fails loudly instead of expanding to nothing');
assert.equal(dictionaries.dicts.zh['forge.addIssuePr'], '添加 issue 或 PR');

/* ---------------- diff as an official right-Sidebar page type ---------------- */
assert.equal(tabTypes.length, 1, 'exactly one right-Sidebar tab type');
const diffType = tabTypes[0];
assert.equal(diffType.id, 'dsh-better-workspaces/diff');
assert.equal(diffType.kind, 'bw-diff');
assert.equal(diffType.priority, 'extension');
assert.equal(diffType.title('sidebar://bw-diff'), 'diff');
// the guide entry is what offers diff beside the official 工作区文件 capsule —
// and it is also what flips defaultSeed to the 开始 chooser, because the seed
// only lands on a type while exactly one guide entry exists (ADR 0006
// Amendment 1)
assert.equal(Array.isArray(diffType.guide), true, 'exactly one guide entry');
assert.equal(diffType.guide.length, 1);
assert.deepEqual(
  Object.keys(diffType.guide[0]).sort(),
  ['description', 'icon', 'order', 'title'],
);
assert.equal(diffType.guide[0].order, 20);
assert.equal(diffType.guide[0].title(), '代码变更');
assert.equal(diffType.guide[0].description(), '查看本会话的代码变更，并提交 / 推送 / 建 PR');
assert.equal(typeof diffType.guide[0].icon, 'function', 'the page glyph doubles as the capsule icon');

const sidebarSlots = registrations.filter(
  (r) => r.descriptor && String(r.descriptor.name).startsWith('sidebar.right.pane.tab'),
);
assert.deepEqual(
  sidebarSlots.map((r) => [r.descriptor.name, r.descriptor.key]).sort(),
  [
    ['sidebar.right.pane.tab', 'dsh-better-workspaces/diff'],
    ['sidebar.right.pane.tab.title', 'dsh-better-workspaces/diff'],
  ].sort(),
  'body and chip title register under the definition id',
);

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

// the retired file view left no icon plumbing behind
assert.equal(T.getFileIconSvg, undefined, 'vendored material icon table removed');
assert.equal(T.desaturateHexColor, undefined, 'Oklab helpers removed with it');
// the page's identity is exported so the definition and the slot keys can be cross-checked
assert.equal(T.SIDEBAR_DIFF_ID, diffType.id);
assert.equal(T.SIDEBAR_DIFF_KIND, diffType.kind);

// the pill is the diff page's only door: it must stay put for every git state
const tr = dictionaries.dicts.zh;
const label = (snapshot) => T.pillLabel(snapshot, (key, params) =>
  (tr[key] ?? key).replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? String(params[name]) : m)));
const statLabel = label({ diffStat: { additions: 3, deletions: 1 }, dirty: true });
assert.equal(statLabel.children[0].props.className, 'dsh-bw-green');
assert.equal(statLabel.children[1], ' ');
assert.equal(statLabel.children[2].props.className, 'dsh-bw-red');
assert.equal(
  label({ diffStat: { additions: 0, deletions: 0 }, dirty: true, changedFileCount: 4 }).children[0],
  '4 个文件有改动',
);
assert.equal(
  label({ diffStat: { additions: 0, deletions: 0 }, dirty: false, upstream: { ahead: 2 } }).children[0],
  '↑2 未推送',
  'a clean tree with unpushed commits still reports them',
);
assert.equal(
  label({ diffStat: { additions: 0, deletions: 0 }, dirty: false, upstream: { ahead: 0 } }).children[0],
  'diff',
  'a clean, pushed tree keeps the pill with the bare page name',
);

// new picker/editor dict keys
assert.equal(dictionaries.dicts.zh['hero.localSuffix'], '（本地）');
assert.equal(dictionaries.dicts.en['hero.localSuffix'], ' (local)');
assert.equal(dictionaries.dicts.en['files.conflict'], 'File changed on disk since load');
assert.equal(dictionaries.dicts.zh['diff.editFile'], '编辑');
assert.equal(dictionaries.dicts.zh['diff.modeSession'], '本会话');
assert.equal(dictionaries.dicts.en['diff.modeTask'], 'Task');
assert.equal(dictionaries.dicts.zh['files.pickHint'], undefined, 'file-tree copy removed');
assert.equal(dictionaries.dicts.zh['files.edit'], undefined, 'file-tree copy removed');
assert.equal(dictionaries.dicts.zh['files.save'], '保存', 'the shared editor copy stays');

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
