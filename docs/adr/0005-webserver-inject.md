# 0005. `webServer` must be a declared inject, not a runtime probe

Date: 2026-09-08

## Context

The host row (`lib/index.js`) registers its HTTP + SSE routes with
`ctx.get('webServer')` and, when that returned `undefined`, logged a warning
and went dormant "for host-only profiles". The row declared `inject = []`,
so Cordis activated it as soon as the composition mounted.

Two mounts of the same code behaved differently:

- **Live insert (worked).** The row entered the old process via
  `patchReload: live` when `cordis.patch.yml` was written. The web app had
  long since provided `webServer`, so `ctx.get` resolved and the routes
  registered. The plugin ran for hours this way.
- **Cold boot (failed twice).** After `systemctl restart dsh-web`, the row
  activated during boot — *before* the web app provided `webServer`. The
  apply took the dormant branch, which never retries. The whole plugin was
  absent for the process lifetime: `/better-workspaces/api/*` and the client
  bundle route both 404 (even authenticated), and every GUI surface
  (hero control, badges, files/diff views) disappeared with it. The dormant
  warning goes to the plugin logger and never reaches the journal, so the
  failure was silent.

Diagnostics that ruled out the earlier hypotheses, kept here so nobody
re-walks them:

- The composed tree contains the row (`dsh --profile web --dump-config`).
- Module resolution is not the problem: the loader resolves bare names
  through Node's internal ESM loader (`node-addon-require-builtin`) with the
  **profile directory** as baseUrl; replaying
  `internal.import('dsh-better-workspaces', 'file:///root/.dsh/profiles/web/')`
  standalone succeeds and exports `apply/inject/name`. A `link:` dependency
  in `profiles/web/node_modules` is necessary and sufficient; the
  `$DSH_HOME/profiles/node_modules` "shared anchor" symlink added mid-incident
  was a wrong turn and has been removed.
- `apply()` itself is clean: `test/mount-check.mjs` runs every host module
  import plus apply against a minimal fake ctx (dormant and webServer paths,
  effect factories and disposers) and nothing throws.

## Decision

`lib/index.js` exports `inject = ['webServer']`. The plugin is a web-plane
extension — without `webServer` it has no surface at all — so the service is
a hard dependency in Cordis terms: the row waits and activates when the
service appears, on cold boot and on live insert alike. The dormant branch
stays only as an unreachable safety net with an "unexpectedly absent"
warning.

`test/mount-check.mjs` asserts `inject` contains `webServer`, so reverting
to a runtime probe fails the suite.

## Consequences

- Cold boots mount deterministically; the live-insert path is unchanged.
- In a hypothetical host-only profile (no `webServer` ever), the row stays
  waiting instead of activating dormant — same observable outcome (no
  routes), but now visible as a waiting row in the loader diagnostics
  rather than a swallowed warn.
- Lesson for future rows in this repo: any service consumed *at apply time*
  must be declared in `inject`; runtime `ctx.get` probes are only safe for
  lazy reads inside handlers that run after activation.
