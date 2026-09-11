# 0008. composer 的 forge 引用控件与 hero 的 PR 检出（pr-checkout）

Date: 2026-09-10

## Context

两个新需求把 forge（GitHub）从「只读徽章」推成「可操作的数据源」：

1. 会话里要谈某条 issue/PR 时，用户只能手打 `#123`；模型拿不到正文、链接与基线。
   paseo 把两者做成输入框里的可引用附件，模型收到的是完整文段。
2. hero 的「新建 worktree」只能从分支切出新分支。要评审或续写一条既有 PR，用户得先
   自己 `gh pr checkout`；而 DSH 会话的 cwd 创建后不可迁移（ADR 0004 Amendment 2），
   所以这件事只能在创建 worktree 的那一刻做。

composer 这一侧的约束是调研结论，不是偏好：

- 官方 `InputBar` 的附着控件行只有两个按钮，且都是**硬编码的 JSX**：`+`（打开 `/`
  命令菜单）与回形针（打开文件选择）。两者之间没有任何槽位——不是「没找到插入点」，
  而是结构上没有可插入点：插件无法合并、替换，也无法渲染在两者之间。
- 附着行内唯一的加法槽是 `conversation.input.left`（`kind: list`，`scope: session`），
  它渲染在 `+`、回形针与「模式」组之后。影子替换整个 `InputBar` 则要复刻命令菜单、
  文件选择、模式/模型/上下文计量与整条提交流程，等于把上游的输入机器 fork 一份并从此
  随上游漂移。
- 官方已有 `ctx.inputTriggers` 触发源管线：来源用 `codec` 声明剪贴板文本与提交时的
  序列化（按草稿里的出现次数逐个调用），用 `lexicon` 声明纯文本引用的装饰表。提交时
  来源缺失即报错阻断发送（`no serializer for reference source`），绝不静默退回剪贴板
  文本；草稿写入走 `insertReference`，带 `draftRev` 的 revision CAS，拒绝时返回
  `false`。

hero 这一侧的语义来自 paseo 的 `checkout-change-request`：PR 不是基，而是一个检出目标；
它的落地方式、分支命名与上游规则都与 `branch-off` 不同。ADR 0004 的 Deviation 4 曾把
「UI 没有 PR 检出入口」记为当时的取舍，本 ADR 兑现那条被推迟的能力。

## Decision

**A. 官方两个附着控件原样保留，新增第三个控件。**
控件注册进 `conversation.input.left`（`id: forge-issue-pr`，`order: 200`），是 GitHub
圆标按钮，点开一个居中的 forge 选择器。拒绝的两条替代路线：并入官方按钮（附着行没有
可插入点，且两个原生按钮各有一段官方行为，合并等于改写上游 UI）；影子替换 `InputBar`
（复刻输入机器的成本与漂移风险远大于一个新按钮）。新增控件不改动原生控件的 DOM 或
行为，因此官方升级只可能让它「消失」，不会破坏输入框本身（与 ADR 0001 同型的降级面）。

**B. 小片给界面、全文给模型：引用 chip + codec 走官方触发源缝隙。**
选择器选中一行后写入一个 reference（`source: better-workspaces-forge`、`ref: 编号`、
`label: 「PR #N 标题」/「Issue #N 标题」`），草稿里只多一个小片；提交时官方按来源调
`codec.serialize`，展开为 paseo 的 `renderChangeRequestAttachment` /
`renderIssueAttachment` 文本——PR：`GitHub PR #N: <title>`、URL、`Base: <base>`、
`Head: <head>`、空行、正文；issue：`GitHub Issue #N: <title>`、URL、空行、正文。
来源只发布 `codec`（`clipboardText` → `@N`，异步 `serialize`）与词表两件套 `lexicon`
+ `subscribeLexicon`；候选钩子**必须存在但回答空列表**（`candidates: async () => []`）：
选择器就是这个来源的门，本来源不给原生 `@` 菜单贡献任何候选行——省掉 hook 则是另一种
后果，见 Consequences 第 4 条。词表只列**本会话真的挂过**的编号，而不是所有见过的条目：
装饰范围因此收敛在本插件自己挂上的引用上，用户手打的编号不会被顺手吞成引用。挂引用与
退化写入都会立刻让装饰扫描重取（`subscribeLexicon` 是词表变化的通知通道）。来源必须与
插件同生命周期（chip 的来源没有序列化器时，发送 fail-loud 而不是降级）。降级：官方的
`insertReference` 因 revision CAS 或输入阶段拒绝写入时，退回 `setDraft` 追加纯文本
`@N`；装饰扫描按词表把 `@N` 重新渲染成 chip，代价只是光标落在草稿末尾。

**C. PR 行 = 检出 head，绝不是可切的基。**
`pr-checkout` 取 forge 的通用 head ref `refs/pull/<N>/head`（origin 优先、upstream
次之）——这是 fork 贡献唯一存在的 ref；随后用
`git worktree add -b <local> --no-track <sha> <path>` 落地，由 git 自己拥有分支名的
合法性与唯一性（被占用时 `<name>-1`、`-2`…）。本地分支名沿用 paseo 的
`buildPrLocalBranchName`：同仓 PR 用 head 分支名，fork PR 用 `<owner>/<headRef>`，
这样跨仓 head 不会与本地同名分支相撞。该 worktree 的比较基线是 **PR 自己的目标分支**
（`baseRef`/`baseRefName`），不是调用方给的 base；`pull` 体里的 `baseRef` 只用于解析
基线，绝不用于切分支，且解析是宽容的（解析不到就退化成裸名，绝不因为基线而阻断检出）。
上游规则：同仓 PR 跟踪 `origin/<headRef>`，且跟踪 ref 由取回的
SHA 物化，所以贡献者分支从未推送（或已删除）时 `@{upstream}` 仍解析；fork PR 一律不设
上游——那是贡献者的分支，不归我们推送，硬指一个同名远端分支只会让「未推送」计数与
pull/push 阶梯瞄准错分支。PR 检出不写 `autoName`（它属于 `branch-off` 的占位分支链），
所以 PR worktree 从不是首条消息重命名的候选。

**D. 宿主新增 `pr-checkout` 意图与两条 forge 数据路由。**
`createWorktree` 新增 `intent: 'pr-checkout'`；`POST /worktrees` 接受
`pull: {number, headRef, baseRef, forkOwner}`，其中 `number` 与 `headRef` 齐备即为
PR 检出，否则按 `branch-off`/`checkout` 走原路（两条旧路径一行未动）。`GET /pulls`
同时服务选择器与 hero：`gh pr list` 与 `gh issue list` 各取一页（默认 20、上限 50），
合并后按更新时间新→旧，另附 `authState`；`GET /pull` 给单个条目的全文（chip 提交时
展开用）。两条路由的 `--json` 都必须请求 `headRepositoryOwner` 与 `isCrossRepository`：
`fork` 取 gh 的 `isCrossRepository`（比比较 owner 更可靠：同仓的 org 分支不是 fork，
改名也不会翻转判断），而 fork 的 owner 登录名是分支命名 `<owner>/<headRef>` 的唯一来源
——列表页缺了它就等于把每条 fork PR 当成同仓 PR 处理，检出到错误的分支名并配上一个
指向基仓同名分支的上游。两者都走用户自己的 `gh`（30 s 缓存，建 PR 后立刻失效，免得新
PR 落在缓存页之外），插件不持有 token。

## Consequences

- chip 的可见标签是**插入时的一份缓存**：`PR #N 标题` 在挂上那一刻定稿，hero 行上的
  `fork` 标记与 `→ base` 提示同样出自那一刻取回的列表页；URL、Base/Head 与正文则在
  提交时才重新取。PR 标题随后被改，chip 仍显示旧标签——这是「界面一小片、模型全
  上下文」的必然代价，换来的是发送前不再多一次交互。
- 选择器只看到每种 `gh` **一页**（默认 20、上限 50）：翻页与服务端搜索都没有，筛选框
  只在已取回的那一页内做；两种 kind 合并按更新时间排序，不按类型分栏。上游若改
  `gh list` 的默认排序或条数，选择器的可见范围随之变化。
- `gh` 就是传输层：未装 CLI / 未登录 / 无可用远端 / 调用失败都作为 `authState` 原样
  呈现，插件既不代管凭据，也不在缺 `gh` 时隐藏功能——hero 取不到 forge 行时只多一行
  「PR 列表不可用」，分支列表照常可用。
- 同一 trigger 上的来源会进入原生候选管线：登记 `@` 就等于被原生 `@` 菜单的 roster
  无条件索取候选（控制器对 roster 里每个来源**同步**调 `candidates(...)`），所以
  「不参与候选」只能以**回答空列表**表达。省掉 hook 不是「少一栏」而是同步抛错：本
  来源留下一个永不落地的分组，且循环当场中断，order 排在后面的来源（官方 `cordis`
  等）这一轮也拿不到候选。这是「借用官方缝隙」的代价：缝隙的契约比我们只想用的那一
  半更宽，而它的失败模式不是局部降级。
- hero 的基列表与选择器共用同一页 forge 数据，而**只有带 head 的行才能被检出**：
  所以 hero 侧按 `kind` 丢掉 issue 行（不是渲染成禁用行——这个列表唯一的选中结果就是
  创建）。这条边界一旦失守，选中的是一次没有 head 的普通 checkout：落到默认分支的
  副本，用户拿到一个与所选条目毫无关系的 worktree，而且没有任何报错。
- `test/client-smoke.mjs` 与 `test/run.js` 各钉一半契约：前者断言唯一一个
  `conversation.input.left` 注册与引用来源的 trigger/name/codec/lexicon 形状；后者在
  真实裸仓库上覆盖 pr-checkout 的 `refs/pull/<N>/head` 取回、跟踪 ref 从该 SHA 物化、
  同名分支加后缀、fork 的 owner 前缀与「无上游」、origin 优先 / upstream 兜底、守卫与
  容错基线，以及 `POST /worktrees` 的 `pull` 路由。没有用例覆盖的是浏览器里的选择器
  交互与 chip 插入本身。
- 本 ADR 记录的是「在官方 UI 内部借用缝隙」的又一处实例（前例见 ADR 0001、0006）：
  缝隙是官方的内部结构而非承诺，界面回归时的降级表现应是「控件/引用不可用」，不是
  输入框损坏。
