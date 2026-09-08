# dsh-better-workspaces

Git workspace enhancements for the DeepSeek Harness Web GUI, inspired by
[paseo](https://github.com/paseo-dev/paseo)'s worktree/diff/PR model.

## What it adds

1. **Hero worktree staging** — when the current (blank) session's workspace is
   a git repo, a dropdown appears in the hero row between the workspace chip
   and the 模式 control: `本地` (default) / `新建 worktree`. Picking the
   latter stages the intent and reveals a base-branch dropdown (default =
   repo default branch, all local+origin branches, plus “＋ 新建分支…” for
   an explicit name). **Picking a base creates immediately and jumps**
   (create-on-arm): the worktree is cut from the base with a mnemonic
   placeholder branch, registered as a Workspace titled `<repo> · <branch>`,
   and the new blank session opens inside it — session cwd can never be
   migrated later, so the session is born in the worktree (ADR 0004
   Amendment 2). Opening the menu or browsing branches stays
   side-effect-free; on the first user message one LLM call renames the
   branch to a task slug AND titles the session (hosts after the restart),
   and the workspace title follows. Abandoned staging leftovers are swept
   automatically (boot + hourly) or via `POST /worktrees/cleanup`.
2. **Sidebar git badges** — session rows stretch vertically; below the title:
   `branch · #PR (green open / purple merged / red closed) · checks pie ring ·
   +N/−N · ↑a↓b (only when non-zero)`. Missing items are omitted.
3. **Diff pill + tabs** — a `± +N/−N` pill above the composer (click → jumps
   to the diff tab) and two new conversation tabs: `文件` (order 20) and
   `diff` (order 30) beside 对话/轨迹.
4. **Diff view** — uncommitted mode (working tree incl. untracked vs HEAD) and
   committed mode (merge-base(base, HEAD) vs HEAD) with commit list, per-file
   hunks, whitespace/wrap toggles, plus the paseo action ladder:
   Commit / Pull / Push / Create PR / Merge PR (squash|merge|rebase, auto) /
   Merge-to-base / Update-from-base / Discard / Archive — every disabled
   action carries a precise localized reason. PR + checks come from one
   batched `gh` GraphQL call (30 s TTL, last-good fallback); PRs poll
   adaptively (20 s pending / 120 s idle).
5. **Files view** — lazy directory tree + read-only viewer (text with line
   numbers, images, binary/too-large notices). No manual editing in v1.

## Architecture

- **Host** (`lib/index.js` → `git.js`, `worktree.js`, `autoname.js`,
  `cleanup.js`, `forge.js`, `diff.js`, `actions.js`, `state.js`, `api.js`):
  git-CLI primitives behind an 8-way concurrency scheduler; managed worktrees under
  `~/.dsh/worktrees/<8-char base36 sha256(mainRepoRoot)>/<slug>` with
  `<gitdir>/dsh-worktree/worktree.json` metadata; first-message branch
  auto-rename via `ctx.llm.stream` + `ctx.agentDefaultModel` (both optional —
  absent services keep placeholders); snapshot hub with fs
  watchers (1 s debounce, degraded 5 s polling), 180 s background fetch and
  fingerprint-deduped SSE; HTTP+SSE API on the harness webServer under
  `/better-workspaces/api`.
- **Client** (`lib/client.js`, hand-written `__ModuleLoader__` bundle):
  slot-registered tabs/dock pill; DOM injection (MutationObserver + React
  portals + anchor self-check with silent degradation, ADR 0001) for the hero
  dropdown and sidebar badges, which have no fine-grained slots.

See `CONTEXT.md` for the glossary and `docs/adr/` for the design records.

## Install (web profile)

```bash
# 1. add the dependency to the profile package (link: keeps source edits live)
dsh plugin --profile web add link:/path/to/dsh-better-workspaces

# 2. mount the plugin row via the patch layer (cordis.patch.yml)
#    - insert:
#        - id: better-workspaces
#          name: dsh-better-workspaces

# 3. install (usually done by step 1)
dsh plugin --profile web install
```

The host half hot-mounts on first patch load, but **host code edits need a
`dsh` restart** (Node's ESM cache survives patch reloads — ADR 0003);
client-bundle edits hot-rebuild in the module graph and only need a page
refresh. Requires `git` ≥ 2.31; `gh` (authenticated) enables PR/checks
features and degrades gracefully when absent.

## Test

```bash
npm test   # standalone host-layer smoke suite (scratch repo + real HTTP)
```
