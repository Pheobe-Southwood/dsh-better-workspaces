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

const mod = loadedEntry.factory((spec) => dshRequire(spec));
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

function stubBtn(rect, opts = {}) {
  return {
    disabled: Boolean(opts.disabled),
    getBoundingClientRect: () => rect,
    querySelector: (sel) => (sel === 'svg' ? (opts.svg === false ? null : {}) : null),
  };
}
const btnA = stubBtn({ bottom: 100, right: 300 });
const btnB = stubBtn({ bottom: 120, right: 280 });
const btnDisabled = stubBtn({ bottom: 120, right: 280 }, { disabled: true });
const btnNoSvg = stubBtn({ bottom: 120, right: 280 }, { svg: false });
assert.equal(T.pickSendCandidate([btnA, btnB, btnDisabled, btnNoSvg]), btnB, 'bottom-right enabled svg button wins');
assert.equal(T.pickSendCandidate([btnA]), btnA);
assert.equal(T.pickSendCandidate([]), null);

assert.equal(T.promptTitle('修复 登录\nbug'), '修复 登录');
assert.equal(T.promptTitle('x'.repeat(60)).length, 40);
assert.equal(T.promptTitle('   '), 'worktree');

assert.equal(T.failureMessage({ message: 'm' }), 'm');
assert.equal(T.failureMessage({ ok: false, error: 'cwd required' }), 'cwd required');
assert.equal(T.failureMessage({ ok: false, error: { message: 'deep' } }), 'deep');
assert.equal(T.failureMessage({ ok: false }), null);

const textRef = { textContent: '  hi there  ' };
const blockWithText = { querySelector: (sel) => (sel === '[data-composer-text-ref]' ? textRef : null) };
assert.equal(T.draftTextOf(blockWithText), 'hi there');
assert.equal(T.draftTextOf({ querySelector: () => null }), '');

assert.match(T.mnemonicSlug(), /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);

// hook-order regression guard: no hook call after HeroControl's early return
const heroStart = source.indexOf('function HeroControl()');
const heroEnd = source.indexOf('function createHeroInjector()');
assert.ok(heroStart >= 0 && heroEnd > heroStart, 'HeroControl slice found');
const hero = source.slice(heroStart, heroEnd);
const earlyReturn = hero.indexOf('return null;');
assert.ok(earlyReturn > 0, 'early return present');
const lastHook = Math.max(
  hero.lastIndexOf('useState('),
  hero.lastIndexOf('useEffect('),
  hero.lastIndexOf('useSyncExternalStore('),
  hero.lastIndexOf('react.useRef('),
  hero.lastIndexOf('react.useEffect('),
);
assert.ok(lastHook < earlyReturn, 'HeroControl: every hook runs before the early return');

// staging dictionary keys present in both locales
assert.equal(dictionaries.dicts.zh['hero.stageHint'], '发送首条消息时自动创建');
assert.equal(dictionaries.dicts.en['hero.stageCreateFallback'], 'Create now');
assert.equal(dictionaries.dicts.zh['hero.modeWorktreePick'], undefined, 'two-item menu: pick variant removed');

console.log('CLIENT SMOKE: ALL PASS');
process.exit(0);
