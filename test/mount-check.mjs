/* mount-check.mjs — reproduce the cordis host mount outside dsh.
 *
 * Cold-boot mounts have failed silently once (row rolled back, routes 404);
 * the loader swallows the throw from stdout. This script imports every host
 * module and runs apply() against a minimal fake ctx — first dormant (no
 * webServer), then with a fake webServer — printing any throw verbatim so
 * the exact cold-boot failure mode is visible without restarting dsh.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULES = [
  '../lib/git.js',
  '../lib/diff.js',
  '../lib/worktree.js',
  '../lib/cleanup.js',
  '../lib/state.js',
  '../lib/actions.js',
  '../lib/forge.js',
  '../lib/api.js',
  '../lib/index.js',
];

for (const spec of MODULES) {
  try {
    await import(spec);
    console.log(`import ok: ${spec}`);
  } catch (e) {
    console.log(`IMPORT FAIL: ${spec}\n${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

function fakeCtx({ withWebServer, registerThrows = false }) {
  const effects = [];
  const logs = [];
  const webServer = withWebServer
    ? {
        register(route) {
          assert.equal(route.kind, 'prefix');
          assert.equal(route.path, '/better-workspaces/api');
          if (registerThrows) throw new Error('duplicate route');
          return () => {};
        },
        registerFallback() {
          return () => {};
        },
        tapIndex(fn) {
          assert.equal(typeof fn, 'function');
          return () => {};
        },
      }
    : undefined;
  return {
    ctx: {
      get(name) {
        if (name === 'webServer') return webServer;
        if (name === 'workspaceRegistry') return { list: () => [] };
        return undefined; // every optional service absent → dormant/degraded paths
      },
      on() {
        return () => {};
      },
      effect(fn, label) {
        effects.push({ label, factory: fn });
        return () => {};
      },
      logger: {
        warn: (...a) => logs.push(['warn', ...a]),
        error: (...a) => logs.push(['error', ...a]),
        info: (...a) => logs.push(['info', ...a]),
      },
    },
    effects,
    logs,
  };
}

const plugin = await import('../lib/index.js');

// Cold-boot/security regression guard: routes need both the server and the
// durable Workspace registry. Without either hard dependency the plugin could
// mount dormant or authorize against an empty/fail-open source.
assert.deepEqual(
  [...(plugin.inject ?? [])],
  ['webServer', 'workspaceRegistry'],
  'host plugin must wait for webServer and its authorization registry',
);

/* ---------------- bundle wiring: `dsh plugin add` is the whole install --------
 * The package must declare `dsh.bundle.patch`, or the dsh CLI installs it as a
 * plain profile dependency, prints a warning, and never lists it in
 * `dsh.profile.bundles` — the row never reaches the composition, so every GUI
 * surface silently disappears (the ADR 0005 failure mode, one layer earlier).
 * The row the patch contributes must name this package (module resolution
 * anchors on it) and carry the id the host half exports (one plugin, one row).
 */
const packageRoot = new URL('..', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));

const declaredPatch = manifest.dsh?.bundle?.patch;
assert.ok(
  declaredPatch,
  'package.json must declare dsh.bundle.patch or `dsh plugin --profile <p> add` only installs a plain dependency (no row, no mount)',
);
assert.ok(
  manifest.files?.includes(declaredPatch.replace(/^\.\//, '')),
  `package.json files must ship ${declaredPatch}: an npm publish would otherwise drop the only mount row`,
);

/* ---------------- client inject: a contract, not a comment ----------------
 * `dsh.client.inject` is forwarded verbatim as the browser fiber's cordis
 * `inject` list, so an entry nobody reads is a pure load-order wait edge, while
 * a *missing* entry is a race: the client half resolves `conversation`,
 * `uiSession`, `uiWorkspace` and `sidebarRight` lazily at render time.
 *
 * Packages that only arrive transitively (api-remotes, api-session-controller,
 * api-workspace-controller, client-connection, client-locale, ui-sidebar) are
 * deliberately NOT listed — they are already in the ui-workspace /
 * ui-conversation / ui-session dependency closure, and the loader walks those
 * edges before materializing the consumer.
 */
const clientSource = readFileSync(new URL('lib/client.js', packageRoot), 'utf8');
const resolvedServices = new Set(
  [...clientSource.matchAll(/(?:appCtx|[A-Za-z_$][\w$]*)\.get\("([a-zA-Z]+)"\)/g)].map((m) => m[1]),
);
// A client package registers a service either by extending the Service base
// class (`super(ctx, "<name>")`) or through the context reflector
// (`ctx.reflect.provide("<name>", impl)`). Both forms appear in the official
// packages this plugin injects, so both must be recognized.
const PROVIDES = /super\(\s*[A-Za-z_$][\w$]*\s*,\s*"([a-zA-Z]+)"\)|reflect\.provide\(\s*"([a-zA-Z]+)"/g;

/** Service names a client bundle registers. */
function providedServices(source) {
  return [...source.matchAll(PROVIDES)].map((match) => match[1] ?? match[2]);
}

/**
 * Check one inject list against the client half's service reads. `resolve` maps
 * a package name to its directory, so the negative cases below run on stubs
 * without an installed dsh; an unresolvable entry is skipped, because CI
 * installs only this package.
 */
function checkInject(injectList, resolve) {
  const errors = [];
  const provided = new Set();
  let inspected = 0;
  for (const entry of injectList) {
    const dir = resolve(entry);
    if (dir === null) continue;
    const clientEntry = new URL('lib/client.js', dir);
    if (!existsSync(clientEntry)) continue;
    inspected += 1;
    const services = providedServices(readFileSync(clientEntry, 'utf8'));
    if (!services.some((service) => resolvedServices.has(service))) {
      errors.push(
        `dsh.client.inject lists ${entry}, but it provides none of the services the client half resolves `
          + `(${[...resolvedServices].join(', ')}); a load-order edge nobody reads is dead wiring`,
      );
    }
    // NB: `Set.add` takes one argument — spreading this array would silently keep
    // only its first service and report the rest as unprovided.
    for (const service of services) provided.add(service);
  }
  return { errors, inspected, provided };
}

/**
 * The converse rule: every service the client half reads must be reachable from
 * a declared entry, or the read races that package's arrival. Separate from
 * {@link checkInject} so the per-entry rule can be exercised on a stub covering
 * one service rather than all four.
 */
function missingServiceErrors(provided, inspectable) {
  if (!inspectable) return [];
  return [...resolvedServices]
    .filter((service) => !provided.has(service))
    .map((service) => `the client half resolves "${service}", but no dsh.client.inject entry provides it: `
      + 'the read would race that package\'s arrival');
}

/** Walk up from the repo so the check runs both in CI and inside a dsh install. */
function nodeModulesRoots() {
  const roots = [];
  let dir = new URL('.', packageRoot);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = new URL('node_modules/', dir);
    if (existsSync(candidate)) roots.push(candidate);
    const parent = new URL('../', dir);
    if (parent.href === dir.href) break;
    dir = parent;
  }
  return roots;
}
function packageDir(name) {
  for (const root of nodeModulesRoots()) {
    const candidate = new URL(`${name}/`, root);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const injectList = manifest.dsh?.client?.inject ?? [];
assert.ok(injectList.length > 0, 'dsh.client.inject must declare the services the client half resolves');

const live = checkInject(injectList, packageDir);
assert.deepEqual(live.errors, [], live.errors.join('\n'));
assert.deepEqual(
  missingServiceErrors(live.provided, live.inspected > 0),
  [],
  'every service the client half resolves must be provided by a declared entry',
);
if (live.inspected > 0) {
  console.log(`inject check ok: ${injectList.length} declared, ${live.inspected} inspected, ${resolvedServices.size} services resolved`);
} else {
  console.log('inject check: no client packages installed here; exercising the rule on stubs instead');
}

/* The rule must actually bite, in both directions. Stub one entry that provides
 * a service the client reads, and one that provides nothing it reads: the
 * second is exactly the "comment pretending to be a dependency" this guards. */
{
  const stubRoot = mkdtempSync(join(tmpdir(), 'dsh-bw-inject-'));
  const write = (name, service) => {
    mkdirSync(join(stubRoot, name, 'lib'), { recursive: true });
    writeFileSync(
      join(stubRoot, name, 'lib', 'client.js'),
      `window.__ModuleLoader__.load({ id: "${name}", factory: () => {\n`
        + `\tclass X { constructor(ctx) { super(ctx, "${service}"); } }\n} });\n`,
    );
  };
  write('stub-provider', 'uiSession');
  write('stub-bystander', 'shoppingCart');
  // the reflector form must be recognized too, or a real provider reads as a bystander
  const writeReflector = (name, service) => {
    mkdirSync(join(stubRoot, name, 'lib'), { recursive: true });
    writeFileSync(
      join(stubRoot, name, 'lib', 'client.js'),
      `window.__ModuleLoader__.load({ id: "${name}", factory: (require) => {\n`
        + `\tconst apply = (ctx) => ctx.reflect.provide("${service}", {});\n} });\n`,
    );
  };
  writeReflector('stub-reflector', 'sidebarRight');
  const stubResolve = (name) => (existsSync(join(stubRoot, name)) ? new URL(`file://${join(stubRoot, name)}/`) : null);

  const good = checkInject(['stub-provider'], stubResolve);
  assert.equal(good.inspected, 1, 'the stub package must be found and read');
  assert.deepEqual(good.errors, [], `a provider of a resolved service must pass: ${good.errors.join('; ')}`);

  const reflective = checkInject(['stub-reflector'], stubResolve);
  assert.deepEqual(
    reflective.errors,
    [],
    `ctx.reflect.provide must count as providing a service: ${reflective.errors.join('; ')}`,
  );

  const noisy = checkInject(['stub-provider', 'stub-bystander'], stubResolve);
  assert.equal(noisy.errors.length, 1, 'exactly the unread entry must be reported');
  assert.match(noisy.errors[0], /stub-bystander.*provides none/s);

  const missing = missingServiceErrors(good.provided, true);
  assert.ok(
    missing.some((e) => /resolves "uiWorkspace".*no dsh\.client\.inject entry provides it/s.test(e)),
    'a service no entry provides must be reported as a missing entry',
  );
  assert.deepEqual(missingServiceErrors(good.provided, false), [], 'an uninspectable install reports nothing');

  rmSync(stubRoot, { recursive: true, force: true });
}

const patchSource = readFileSync(new URL(declaredPatch, packageRoot), 'utf8');
assert.match(patchSource, /^\s*-\s*insert:/m, `${declaredPatch} must contribute a top-level insert list`);

/* Exactly one row, and it must not be a second copy of a row a profile layer
 * already carries: the include inserts verbatim and the Loader throws on a
 * repeated entry id, so "bundle layer + hand-written row" is a boot failure
 * rather than a harmless duplicate. */
const rows = [...patchSource.matchAll(/^\s*-\s*id:\s*(\S+)\s*\n\s*name:\s*(\S+)\s*$/gm)].map((match) => ({
  id: match[1],
  name: match[2],
}));
assert.equal(rows.length, 1, `${declaredPatch} must contribute exactly one row, found ${rows.length}`);
assert.equal(rows[0].name, manifest.name, 'the row must mount this package by name');
assert.equal(rows[0].id, plugin.name, 'the row id must match the name the host half exports');

const readme = readFileSync(new URL('README.md', packageRoot), 'utf8');
assert.match(
  readme,
  /duplicate loader entry id/,
  'README must document the pre-bundle upgrade cleanup and its duplicate-id symptom',
);

for (const withWebServer of [false, true]) {
  const { ctx, effects, logs } = fakeCtx({ withWebServer });
  try {
    const dispose = plugin.apply(ctx);
    // run every registered effect body (timers, sweeps, route registration),
    // then its disposer so no boot timer keeps the process alive
    for (const entry of effects) {
      let disposer = null;
      try {
        disposer = entry.factory();
      } catch (e) {
        console.log(`EFFECT FAIL [${entry.label}] webServer=${withWebServer}\n${e && e.stack ? e.stack : e}`);
        process.exit(1);
      }
      if (typeof disposer === 'function') {
        try {
          await disposer();
        } catch (e) {
          console.log(`EFFECT DISPOSE FAIL [${entry.label}]\n${e && e.stack ? e.stack : e}`);
          process.exit(1);
        }
      }
    }
    if (typeof dispose === 'function') dispose();
    console.log(`apply ok (webServer=${withWebServer}); effects=${effects.length}; logs=${JSON.stringify(logs)}`);
  } catch (e) {
    console.log(`APPLY FAIL (webServer=${withWebServer})\n${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

// A duplicate route must dispose the API heartbeat immediately; the simulated
// Cordis rollback then disposes effects registered before the failing one.
{
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = new Set();
  globalThis.setInterval = () => {
    const token = {};
    intervals.add(token);
    return token;
  };
  globalThis.clearInterval = (token) => {
    intervals.delete(token);
  };
  try {
    const { ctx, effects } = fakeCtx({ withWebServer: true, registerThrows: true });
    plugin.apply(ctx);
    const disposers = [];
    let failure = null;
    for (const entry of effects) {
      try {
        const disposer = entry.factory();
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (error) {
        failure = error;
        break;
      }
    }
    assert.match(String(failure?.message || failure), /duplicate route/);
    for (const disposer of disposers.reverse()) await disposer();
    assert.equal(intervals.size, 0, 'failed registration cannot leak hub/API intervals');
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

console.log('MOUNT CHECK: ALL PASS');
