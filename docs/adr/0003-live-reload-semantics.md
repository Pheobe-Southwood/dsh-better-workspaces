# 0003. Live-reload semantics for the linked repo plugin

Date: 2025-09-08 (v1 development)

## Context

`dsh-better-workspaces` is mounted into the `web` profile as a `link:`
dependency plus one `insert` row in `cordis.patch.yml` (`patchReload: live`).
During development we edit `lib/*.js` in place and expect the running server
at http://127.0.0.1:3080 to pick changes up. The two halves reload very
differently, and conflating them wastes acceptance cycles.

Empirically verified against the live server:

- **Host half — frozen per process.** The cordis loader imports the row's
  package through plain `import(name)`; Node's ESM cache returns the same
  module instances for the process lifetime. `patchReload: live` re-applies
  the patch layer when `cordis.patch.yml` *content* changes, but re-imports
  a row only when its `name` field is part of the diff — and even then the
  ESM cache serves the original modules. Evidence: an edited refusal-message
  template in `lib/worktree.js` still produced the old string from the live
  API after touching the patch file.
- **Client half — hot.** `@deepseek-ai/dsh-client-modules` watches each
  mounted entry's `clientPath`; any edit to `lib/client.js` recomputes the
  artifact revision (`sha1("plugin-artifact\0" + len + ":" + bytes)[0:12]`)
  and rebuilds the served combo graph within ~2 s. Evidence: appending a
  comment marker produced a new valid `rev` and `GET
  /plugins/??dsh-better-workspaces/client.js&rev=<new>` returned HTTP 200
  with the new bytes. Browsers see it on the next page load (or via the HMR
  receiver when a dev watcher feeds it).

## Decision

Treat the two halves with different iteration loops:

1. **Client fixes**: edit `lib/client.js`, commit, ask for a page refresh.
   No server restart, ever.
2. **Host fixes**: edit, commit, and *state explicitly* that they activate
   on the next `dsh` restart. Never restart the server mid-session — it
   hosts the agent session itself.
3. Design host code so a stale-but-running version remains **functionally
   correct**: freshness races are self-healed by SSE snapshot pushes
   (~1 s), so a frozen host degrades UX latency, not correctness.
4. Verification without a browser is allowed to rely on: the standalone
   smoke suites (`npm test`), live HTTP probes against `/better-workspaces/api`,
   and the computed-rev combo probe for the client graph.

## Consequences

- The currently live host may lag the repo by a few commits; `git log` is
  the source of truth for what the *next* boot runs. README carries the note.
- Combo `rev` probing gives a browser-free way to prove the client bundle is
  composed and served — used as the mount gate before asking for refreshes.
- If a future host change is genuinely urgent mid-session, the only levers
  are additive (new routes/behavior cannot appear without re-import), so
  urgency must be scheduled against a restart window instead.
