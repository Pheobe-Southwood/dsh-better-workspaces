/* mount-check.mjs — reproduce the cordis host mount outside dsh.
 *
 * Cold-boot mounts have failed silently once (row rolled back, routes 404);
 * the loader swallows the throw from stdout. This script imports every host
 * module and runs apply() against a minimal fake ctx — first dormant (no
 * webServer), then with a fake webServer — printing any throw verbatim so
 * the exact cold-boot failure mode is visible without restarting dsh.
 */
import assert from 'node:assert/strict';

const MODULES = [
  '../lib/git.js',
  '../lib/diff.js',
  '../lib/worktree.js',
  '../lib/autoname.js',
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

function fakeCtx({ withWebServer }) {
  const effects = [];
  const logs = [];
  const webServer = withWebServer
    ? {
        register(route) {
          assert.equal(route.kind, 'prefix');
          assert.equal(route.path, '/better-workspaces/api');
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

// Cold-boot regression guard: the row MUST declare webServer as a hard
// dependency. With inject:[] the row activated before the web app provided
// the service, took the dormant branch, and never registered its routes —
// every cold boot lost the whole plugin (ADR 0005).
assert.deepEqual(
  [...(plugin.inject ?? [])],
  ['webServer'],
  'host plugin must inject webServer so cordis waits for it on cold boot',
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
          disposer();
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

console.log('MOUNT CHECK: ALL PASS');
