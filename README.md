# dsh-better-workspaces

Git workspace enhancements for the DeepSeek Harness Web GUI, inspired by
[paseo](https://github.com/paseo-dev/paseo)'s worktree/diff/PR model.

## What it adds

1. **Hero worktree staging** — when the current (blank) session's workspace is
   a git repo, a `本地` dropdown appears in the hero row between the workspace
   chip and the 模式 control; it offers `新建 worktree`, which reveals the
   base-branch picker. **The picker speaks exact refs (paseo parity)**: the
   `origin/<name>` row comes first because it IS the default base — cutting
   from `refs/remotes/origin/<name>` starts at the true GitHub head even when
   the local branch lags; diverged locals appear as `<name>（本地）` rows with
   `+N −M` facts. **Picking a base creates immediately and jumps**
   (create-on-arm, ADR 0004 Amendment 2): creation gives origin refs a
   bounded 4 s `git fetch --prune` head start (on top of the 180 s background
   fetch — paseo itself never fetches at create time), cuts the mnemonic
   placeholder branch, registers a Workspace titled
   `<source workspace> · <branch>`, creates the target session, migrates the
   typed draft through the official conversation-input API, opens it and
   retires the blank launcher — with full rollback on any failure. On the
   first user message one LLM call renames the branch to a task slug AND
   titles the session (hosts after restart), and the workspace title follows
   as `<source> · <session title>`. Inside a worktree workspace the hero
   control hides entirely, and the sidebar row trades its folder icon for a
   branch icon. Abandoned staging leftovers are swept automatically
   (boot + hourly) or via `POST /worktrees/cleanup`.
2. **Sidebar git badges** — session rows stretch vertically; below the title:
   `branch · #PR (green open / purple merged / red closed) · checks pie ring ·
   +N/−N · ↑a↓b (only when non-zero)`. Missing items are omitted.
3. **Diff pill + tabs** — a `± +N/−N` pill above the composer (click → jumps
   to the diff tab) and two new conversation tabs: `文件` (order 20) and
   `diff` (order 30) beside 对话/轨迹.
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
   an `编辑` button opening the shared file editor.
5. **Files view** — lazy directory tree with material file icons by
   extension (vendor table + Oklab desaturation ported from paseo, see
   NOTICE) + viewer (text with line numbers, images, binary/too-large
   notices) + `编辑` button opening the shared **file editor**: monospace
   textarea, dirty marker, Ctrl/Cmd+S, saved through `POST /file` with
   sha1 compare-and-swap (concurrent on-disk change → 409 conflict +
   reload, never a silent overwrite; containment/size/binary guards,
   atomic tmp+rename write).

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
