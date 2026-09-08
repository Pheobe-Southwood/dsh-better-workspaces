# worktree 以工作区钉死，会话不换目录

DSH 会话的 cwd 不可变（harness 硬约束：sandbox-policy 在创建时归一化一次，此后只读），与 paseo 的「workspace 记录钉死 worktree、无 per-session 切换」模型同构。曾考虑过「新建 worktree 后把当前会话迁过去」与「仅落盘、让用户手动打开」两种替代。

**决定**：托管 worktree 在预备区（hero）创建，创建成功即注册为新的 DSH 工作区，并由原生 selectWorkspace 流程把当前空白会话绑定过去（草稿与附图自动迁移）；首条消息即在 worktree 中执行。已存在会话永不换目录，其 git 状态按 cwd 由徽章行与文件/diff 视图呈现。「本地」= 工作区根为仓库自身检出；「切换到某个已有 worktree」= 切换工作区（原生工作区下拉天然列出全部 worktree 工作区），因此 worktree 下拉只需提供「本地 / 新建 worktree」两项。

**后果**：worktree 下拉只在新会话预备时出现；Archive 仅作用于托管 worktree；同一仓库被多个会话打开时，git 状态按仓库/worktree 根去重聚合，避免重复子进程。
