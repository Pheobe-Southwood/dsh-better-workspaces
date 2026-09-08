# dsh-better-workspaces 上下文

DSH Web GUI 的 git 增强插件：为新会话做 worktree 预备、在侧栏呈现每个会话的 git 徽章、并提供「文件」「diff」两个会话视图。本文件是项目领域语言的术语表。

## 会话与工作区

**工作区（Workspace）**：
DSH 的持久实体，以一个根目录路径归组会话。本插件让每个受管 git 工作树恰好对应一个工作区。
_Avoid_: 项目、目录

**会话工作目录（cwd）**：
会话不可变的根目录，继承自绑定的工作区；创建后不能更换（harness 硬约束）。
_Avoid_: 工作路径

**预备区（hero）**：
空白会话在首条消息之前的暂存状态：在此选定工作区、worktree 策略与 agent 预设。worktree 下拉仅出现在这里。
_Avoid_: 首页、欢迎页

**本地检出（「本地」）**：
工作区根目录就是仓库自身工作副本（而非链接 worktree）的状态，也是 worktree 下拉的默认选项。
_Avoid_: 主目录、原目录

**托管 worktree**：
由本插件在其 worktrees 根下创建、并写有元数据记录的 git 链接工作树；只有托管 worktree 允许从界面归档（Archive）。
_Avoid_: 临时目录、副本

**基线分支（base branch）**：
托管 worktree 被切出时所依据的精确 ref，记录在元数据里；是已提交 diff 与超前/落后的比较基线。无记录时回退默认分支。
_Avoid_: 上游（那是另一个概念）

**基分支选择**：
hero 分支下拉的语义：所选分支只作为切出的基（base），「新建 worktree」永远切出一个新分支，从不检出既有分支（paseo 语义）。
_Avoid_: 分支切换

**占位分支（placeholder branch）**：
未显式命名时新建 worktree 自动切出的助记临时分支名（形容词-名词-4位hex，如 amber-otter-3f2a）；由客户端 slug 播种、服务端兜底生成，记录在元数据 autoName 字段中，是自动重命名的唯一候选。
_Avoid_: 临时分支、默认分支

**自动重命名（auto-rename）**：
worktree 会话首条真实用户消息触发的一次性 LLM 辅助命名：把占位分支重命名为任务语义 slug（如 fix-login-bug）。守护链：托管 worktree + autoName 为 pending + 当前分支仍等于占位名 + 非子会话；用户显式命名的分支（ineligible）、已手动改名的分支、任何生成失败都保留占位名且不再重试（一次性 attempted）。重命名成功经 hub 失效由 SSE 推送，徽章与 hero 秒级刷新。
_Avoid_: 智能命名、自动分支

**上游（upstream）**：
当前分支配置的远端跟踪分支；决定「未推送」计数与 pull/push 目标。
_Avoid_: 基线、远端

**默认分支**：
仓库默认分支：origin/HEAD 可解析时用之，否则 main，否则 master。

## Git 状态

**未提交变更（uncommitted diff）**：
工作树对 HEAD 的差异，含未跟踪文件；不区分已暂存/未暂存。
_Avoid_: 脏 diff

**已提交变更（committed diff）**：
merge-base(基线分支, HEAD) 对 HEAD 的差异，即 PR 视角的分支全量变更。
_Avoid_: 已推送 diff

**超前/落后（ahead/behind，↑a↓b）**：
当前 HEAD 与比较基线之间双方独有提交的数量。

**未推送（unpushed）**：
上游（或 origin/<当前分支>）上尚不存在的提交状态；驱动 Push 动作晋升与归档风险提示。

**脏（dirty）**：
git status --porcelain 非空的状态；驱动 Commit 动作晋升与归档警告。

**DiffStat（+N/−N）**：
按当前比较范围合并统计的绿色新增行数与红色删除行数（compact 数字格式）。

**Checks（CI 状态）**：
PR 的 CI 状态汇总，fail-fast 折叠：任一 failure→失败；否则任一 pending→运行中（含完成度）；否则成功。徽章呈四格 pie 环，完成度向下取整到四分之一。

**PR 状态**：
open（绿）/ merged（紫）/ closed（红）三态；序号自 PR URL 解析。

**Forge**：
通过其官方 CLI 访问的代码托管平台（GitHub 经 gh）；认证状态即 CLI 登录状态，本插件不持有 token。

**git 快照**：
按工作区根目录折叠出的最小 git 状态（分支、脏、超前/落后、DiffStat、PR、checks），供徽章行与各视图消费；指纹相同的快照不重复下发。

## 界面词汇

**徽章行**：
侧栏会话标题下方的一行 git 徽章：分支名（超长省略号）· #PR号 · checks · +N/−N · ↑a↓b；缺失项整个不显示，数值项为零不显示。
_Avoid_: 状态栏、标签行

**diff pill**：
输入框上方的 DiffStat 胶囊；点击跳转 diff 视图；无任何变更时隐藏。

**文件视图（「文件」tab）**：
以会话 cwd 为根的只读文件树与文件查看器。

**diff 视图（「diff」tab）**：
承载未提交/已提交两模式 diff、commit 列表与操作面板的会话视图。

**操作阶梯**：
diff 视图主操作按状态晋升的顺序：Commit（脏时）→ Pull（落后上游时）→ Push（未推送时）→ Merge PR → auto-merge → Create PR → Merge-to-base → Update-from-base → Archive；未晋升者入溢出菜单，禁用项必须携带精确原因文案。
_Avoid_: 按钮组

**Merge-to-base / Update-from-base**：
把当前分支合入基线分支（基线被其他 worktree 检出时在其 worktree 内执行）/ 把最超前的基线合入当前分支（要求干净工作树）。
