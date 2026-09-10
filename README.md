# dsh-better-workspaces

Git workspace enhancements for the DeepSeek Harness Web GUI, inspired by
[paseo](https://github.com/paseo-dev/paseo)'s worktree/diff/PR model.

## What it adds

1. **Hero worktree staging** — when the current (blank) session's workspace is
   a git repo, a mode dropdown appears in the hero row between the workspace
   chip and the 模式 control; it offers `本地` (the workspace root IS the
   repository checkout — the default) and `新建 worktree`, which reveals the
   base-branch picker. Picking `本地` again leaves staging with no side effect,
   so the picker is never a dead end, and the trigger label always shows the
   active mode. **The picker speaks exact refs (paseo parity)**: the
   `origin/<name>` row comes first because it IS the default base — cutting
   from `refs/remotes/origin/<name>` starts at the true GitHub head even when
   the local branch lags; diverged locals appear as `<name>（本地）` rows with
   `+N −M` facts. **Picking a base creates immediately and jumps**
   (create-on-arm, ADR 0004 Amendment 2): creation gives origin refs a
   bounded 4 s `git fetch --prune` head start (on top of the 180 s background
   fetch — paseo itself never fetches at create time), cuts the mnemonic
   placeholder branch, registers a Workspace titled
   `<source workspace> · <branch>` (renamed as the very next call after
   registration, so the row does not linger on the placeholder-branch title),
   creates the target session, migrates the
   typed draft through the official conversation-input API, opens it and
   retires the blank launcher — with full rollback on any failure. On the
   first user message one LLM call renames the branch to a task slug AND
   titles the session (hosts after restart), and the workspace title follows
   as `<source> · <session title>` — only ever for the workspace owning the
   current session's cwd, since every git detection result is tagged with the
   cwd it was resolved for. Inside a worktree workspace the hero
   control hides entirely, and the sidebar row trades its folder icon for a
   branch icon. Abandoned staging leftovers are swept automatically
   (boot + hourly) or via `POST /worktrees/cleanup`.
2. **Sidebar git badges** — session rows stretch vertically; below the title:
   `branch · #PR (green open / purple merged / red closed) · checks pie ring ·
   +N/−N · ↑a↓b (only when non-zero)`. Missing items are omitted.
3. **Diff pill + right-sidebar page** — a `±` pill above the composer opens the
   diff view as a page tab in dsh's official right Sidebar (the column expands,
   and an already-open tab is revealed rather than duplicated). The pill stays
   put for every git session — `+N −N` when there is a diffstat, the changed
   file count when only the tree is dirty, `↑N 未推送` when only unpushed
   commits exist, and the bare `diff` otherwise — because the conversation no
   longer carries a diff tab of its own. In the sidebar the file list sits
   above the diff pane so the 300 px panel stays readable.
   The old `文件`/`diff` conversation tabs are gone: dsh 0.1.5 shipped the
   right Sidebar's own `文件` panel, which supersedes the plugin's file view.
4. **Diff view** — four modes with paseo-parity defaults: `未提交` (working
   tree incl. untracked vs HEAD), `本会话` (default in shared workspaces: the
   uncommitted diff filtered to files this session wrote, attributed from its
   paged session log — git state is per-cwd, the log is the only per-session
   signal), `任务` (default in managed worktree sessions: merge-base(base,
   HEAD) vs the working tree incl. untracked = everything this worktree
   accumulated, i.e. paseo's worktree diff), and `对比基线` (merge-base(base,
   HEAD) vs HEAD) — all with commit list, per-file hunks, whitespace/wrap
   toggles, plus the paseo action ladder:
   Commit / Pull / Push / Create PR / Merge PR (squash|merge|rebase, auto) /
   Merge-to-base / Update-from-base / Discard / Archive — every disabled
   action carries a precise localized reason. PR + checks come from one
   batched `gh` GraphQL call (30 s TTL, last-good fallback); PRs poll
   adaptively (20 s pending / 120 s idle). Each editable file head carries
   an `编辑` button opening the shared **file editor**: monospace textarea,
   dirty marker, Ctrl/Cmd+S, saved through `POST /file` with sha1
   compare-and-swap (concurrent on-disk change → 409 conflict + reload,
   never a silent overwrite; containment/size/binary guards, atomic
   tmp+rename write).

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
  slot-registered right-Sidebar diff page + dock pill; DOM injection
  (MutationObserver + React portals + anchor self-check with silent
  degradation, ADR 0001) for the hero dropdown and sidebar badges, which have
  no fine-grained slots.

See `CONTEXT.md` for the glossary and `docs/adr/` for the design records.

## Install (web profile)

The official `dsh plugin` entry (a thin pnpm forwarder into the profile
directory) installs this package as a plain profile dependency — it declares
`dsh.client`, not `dsh.bundle`, so mounting is one patch-layer row:

```bash
# 1. install into the profile (git spec; plain JS, no build step)
dsh plugin --profile web add github:Pheobe-Southwood/dsh-better-workspaces

# 2. mount the plugin row via the patch layer
#    ($DSH_HOME/profiles/web/cordis.patch.yml):
#    - insert:
#        - id: better-workspaces
#          name: dsh-better-workspaces

# 3. restart dsh for the cold boot (or let patchReload:live hot-insert the
#    row into a running process)
```

Developing from a local checkout? Use a `link:` spec instead of step 1 —
source edits stay live for the client half:

```bash
dsh plugin --profile web add link:/path/to/dsh-better-workspaces
```

Host code edits need a `dsh` restart (Node's ESM cache survives patch
reloads — ADR 0003); client-bundle edits hot-rebuild in the module graph and
only need a page refresh. The row declares `inject: ['webServer']`, so cold
boot waits for the web server instead of racing it (ADR 0005) — if the UI is
missing after a restart, run the self-check in the ops section below.
Requires `git` ≥ 2.31; `gh` (authenticated) enables PR/checks features and
degrades gracefully when absent.

## Test

```bash
npm test   # standalone host-layer smoke suite (scratch repo + real HTTP)
```


## 运维：冷启动挂载与重启自检

**模块解析事实**：dsh 加载器通过 Node 内部 ESM loader 按 **profile 目录**解析
裸包名，所以 `link:` 依赖装在 `$DSH_HOME/profiles/web/node_modules` 即可，
不需要其他锚点（曾误判为「共享锚点」，见 ADR 0005）。

**曾经的冷启动故障**（ADR 0005）：宿主行过去声明 `inject = []`，冷启动时该行
在 web app 提供 `webServer` 服务**之前**就激活，`ctx.get('webServer')` 落空，
走 dormant 分支且永不重试——路由与客户端 bundle 全部 404，GUI 里
hero/徽章/tab 整体消失；而 `patchReload: live` 的热插入发生在 webServer
已就绪的运行中进程里，所以一直正常。修复：`export const inject = ['webServer']`，
Cordis 会等服务出现后再激活该行。

重启后自检三步：

1. `dsh --profile web --dump-config | grep better-workspaces` —— 行在组合树里；
2. `curl -s http://127.0.0.1:3080/better-workspaces/api/worktree-workspaces` ——
   期望 `{"ok":true,...}`（404 = 行未激活：确认 profile `node_modules` 的
   link 依赖存在，且 `lib/index.js` 的 inject 仍含 `webServer`）；
3. 刷新 GUI：非 worktree 工作区出现「本地」hero 控制，worktree 工作区隐藏且行图标为分支。

`npm test` 含 `test/mount-check.mjs`：断言 `inject` 含 `webServer`（防回归），
并以最小假 ctx 跑遍宿主模块 import 与 apply（dormant + webServer 两条路径），
用于在不动 dsh 进程的前提下暴露挂载期抛错。
