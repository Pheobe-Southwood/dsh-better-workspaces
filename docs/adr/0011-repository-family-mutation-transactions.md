# ADR 0011：仓库族变更串行化与可恢复事务

- 状态：Accepted
- 日期：2026-09-11

## 背景

同一 Git 仓库的主 checkout 与 linked worktree 共享 refs、配置和 worktree 管理区。分别按 cwd 或文件路径加锁，不能阻止 create/create、create/archive、action/action、后台 fetch 与自动改名互相穿插；失败路径里的无条件 `merge --abort` 或先删 branch 再确认 worktree 消失还可能破坏不属于本次调用的状态。Cordis 更新期间旧实例也可能仍在排空异步操作。

## 决策

1. 宿主进程使用一个模块级 FIFO mutation coordinator。所有 Git 变更按 `git:<canonical-main-root>` 串行，普通非 Git 工作区按 `workspace:<canonical-root>` 串行；不同 key 可并行。
2. key 只能来自授权阶段返回的规范主仓库身份，不得在排队后通过带 cwd fallback 的探测重新推导。获得 gate 后重新授权，并同时核对目标 root 与 main repo 的 dev/inode；Linux 复合事务自持目录 fd，Git 文件保存固定按「仓库/工作区 gate → 文件 mutex」取锁。
3. create 的 fetch、命名、路径选择、`worktree add`、元数据提交、postcondition 与 rollback 全部位于同一仓库 gate。branch-off 从预先解析的完整 OID 创建，不再使用可移动 ref。
4. 仓库专属受管根以 fsync owner record 绑定 main repo dev/inode，路径被另一仓库复用时拒绝恢复。`worktree add` 前写入并 fsync `prepared` create journal；此阶段绝不声称分支所有权。add 通过 parent-death guardian 执行，Host 被 SIGKILL 时 guardian 会终止 Git 进程组。只有 add 成功且 worktree row、branch、HEAD、path inode 与 gitdir inode 均验证后，才把 journal 原子升级为 `added` 并记录分支所有权。自动恢复不删除任何仍存在的 path 或 row（ignored/事后文件无法被竞态前的 status 完整证明），只在两者都已由人工移除后以 expected OID 做 CAS branch 删除；证据不足保留现场。有效元数据代表提交完成，只清 journal。插件专属 PR 临时 ref 同样被验证删除并在恢复时清扫。
5. archive 返回成功前证明路径不存在且 Git worktree row 不存在。此后 prune 只是 maintenance warning，不把已经提交的删除伪装成可安全整体重试的失败。Workspace registry 在归档前捕获 ID 并 fsync durable deletion tombstone；同一 repo-family gate 内仅按该 ID 删除，绝不按可能复用的路径重新查询，从而阻止新 create 在旧 generation 收敛前复用路径。删除抛错或进程在跨服务窗口退出时，启动/定时恢复重放 tombstone，确认 path 与 Git row 均已消失后幂等收敛 registry。
6. Merge 使用预先解析的 immutable target OID。冲突后即使 MERGE_HEAD、分支和 HEAD 仍匹配，插件也不自动 `merge --abort`：外部用户/Agent 可能已接管并开始解决冲突，而宿主没有跨进程 lease 可原子证明所有权。接口保留冲突现场并返回显式 recovery 提示。
7. API、Hub、自动命名和 abandoned scheduler 采用 lifecycle generation/AbortSignal。排队中的 mutation 与未完成 request body 可取消；破坏性 commit point 一旦开始就排空到一致终态。disposer 关闭 SSE/定时器并等待 in-flight promise；进程级 coordinator 防止旧、新插件实例重叠。
8. 没有 Session 原子 lease 时，abandoned cleanup 对任何 live session（包括 blank）都失败关闭；定时 sweep 进一步降为仅重放崩溃恢复日志，不自动归档。显式人工清理仍会报告并承认最后一次 session snapshot 与新会话创建之间存在插件外 TOCTOU。

## 后果

- 同一仓库中的 Host 变更吞吐量降低，但行为变成确定的 FIFO；不同仓库不受影响。
- 粗粒度单 gate 避免 merge-to-base 跨两个 worktree 时的多锁死锁，也覆盖共享 refs/config。
- 该边界只约束插件自己的 Host mutator。用户、Agent 或其他进程直接执行 Git 仍是外部并发，因此破坏性操作保留最终 Git 守卫与所有权 postcondition。
- create journal 解决 Host 在 add→metadata 窗口崩溃后的收敛；浏览器在 HTTP 成功响应丢失后的 txId 幂等回滚属于客户端 handoff 事务，另行实现。
