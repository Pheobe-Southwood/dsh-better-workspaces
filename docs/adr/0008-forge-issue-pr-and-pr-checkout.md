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
来源只发布 `codec`（`clipboardText` → `#N`，异步 `serialize`）与词表两件套 `lexicon`
+ `subscribeLexicon`；候选钩子**必须存在但回答空列表**（`candidates: async () => []`）：
选择器就是这个来源的门，本来源不给原生 `@` 菜单贡献任何候选行——省掉 hook 则是另一种
后果，见 Consequences 第 4 条。词表只列**本会话真的挂过**的编号，而不是所有见过的条目：
装饰范围因此收敛在本插件自己挂上的引用上，用户手打的编号不会被顺手吞成引用。挂引用会
立刻让装饰扫描重取（`subscribeLexicon` 是词表变化的通知通道）。来源必须与插件同生命周期
（chip 的来源没有序列化器时，发送 fail-loud 而不是降级）。引用写入是**原子操作**：
`insertReference` 因 revision CAS、输入阶段或坐标拒绝时，草稿保持不变并提示重试，理由见 B5。

**B1. 显示形态是 `#N`，而 `trigger` 必须保持 `@`。**
`TriggerChar` 的官方定义是 `'/' | '@'`——`#` **不可能**作为触发符；`trigger` 字段是词表的
键域，候选聚合也按它分桶，塞 `#` 进去会让聚合出错。但用户看到的标记来自
`codec.clipboardText`，官方对该字段的注释写得很明确：
`Clipboard / persistence projection, e.g. /name (never the model form)`——它本就不必等于
触发符。两者故意不同正是本节的要点：`@` 是所有官方 `@` 类来源（文件 / 引用 / cordis）的
唤醒符，`@N` 形态的小片会和官方附件菜单抢同一个按键（用户实际遇到的现象：出现引用片的
同时弹出附件候选）。改成 `#N` 后 `#` 不是任何触发符，既不唤醒官方菜单，也不与 Markdown
的 `#` 标题冲突。

**B2. 服务键是 `conversation`，不是 `uiConversation` —— 这是「点了没反应」的真正原因。**
官方 `dsh-client-ui-conversation` 注册了**两个不同的服务类**，只有一个带 `SessionInputResolver`：

```js
var UiConversation = class extends Service { ... }              // super(ctx, "uiConversation") —— 没有 input 成员
      ConversationController = class extends Service {           // super(ctx, "conversation")
        constructor(ctx, config) { this.input = config.input; }  // ← 解析器在这里
```

`uiConversation` 只是官方 apply 里的**局部变量名**（`const uiConversation = new UiConversation(...)`），
从来不是服务键。因此 `appCtx.get("uiConversation")` 永远返回 undefined，而解析器里的
`if (!conversation || !conversation.input) return null` 会在**任何点击之前**就把整条链短路：
`sessionInput = null` → `insertReference` 被跳过 → 点击表现为完全无事发生。
这个键错误此前**无法被任何静态检查发现**：`ctx.get` 对未知名返回 undefined 而不是抛错，而
`uiConversation` 这个名字在官方源码里到处可见（它是局部变量与另一个真实服务名），看起来完全合理。

同一个键错误还影响一处**既有**代码：hero 的 `prepareStagedWorktree` 用
`appCtx.get("uiConversation")` 拿 `conversation.blocks`，因此「创建 worktree 时锁住输入框」的
提示一直是**静默不生效**的。两处现在都改为 `get("conversation")`。

护栏（`test/client-smoke.mjs`）：mock 的 `ctx.get` 只对 `"conversation"` 回答案例对象的服务，
对 `"uiConversation"` 明确返回 undefined；另有静态断言（先剥注释，因为注释里按名字写了错误键）
要求源码中出现 `.get("conversation")` 且不出现 `.get("uiConversation")`。

**B3. 写入路径的坐标契约（先后踩了两版，见 ADR 0009）。**
命中一行到草稿里出现小片，中间的官方调用要求调用方知道三个事实：
其一，**解析会话输入必须用 `sessions.scope(id)` 拿到的 ctx**——`conversation.input.for(actx)`
内部走 `sessions.scopeOf(ctx)`，读的是 sessions 服务自己打在**每会话 ctx** 上的私有 tag；
会话*binding* 上没有这个 tag，传进去会抛「requires a session scope」，而调用点若把异常
吞掉就变成**完全没反应**。其二，`caretSpan()` 与 `insertReference` 使用 detect 坐标，
`draft` 与 occurrence 的 `offset` / `length` 则**全部使用 clipboard 坐标**（官方
`Occurrence` 类型注释逐项明确），绝不能混算。其三，官方 `$composerLayout()` 把每个 chip
固定投影为 **1 个 `U+FFFC` 对象替代字符**，而不是 0 个字符：

```text
detectEnd = draft.length - Σ(occurrence.length - 1)
```

旧 `draftEnd()` 使用 `offset + draft.length - clipboardText.length`。已有 0 个 chip 时算对 0；
已有 1 个 `#803` chip 时算出 1（实际 2，但仍在合法范围，`caretSpan()` 的实时 2 因宽松的
`>=` 判定被采用）；已有 2 个 chip 时却算出 10（实际 4），于是**恰好从第三次选择开始**把
越界 span 交给 `insertReference`。官方 `$replaceDetectSpanWithNodes` 无法选择该范围，返回
false，随后旧纯文本兜底把模型正文展开到输入框——这就是第三个引用突然展开的完整因果链。

现在 `referenceDetectEnd` 对 occurrence 的排序、重叠、边界与整数性做校验，并按上式换算；
`forgeInsertSpan` 优先读取点击时 `target.snapshot`，revision 取 shell 的 `rev`，且只有
`caretSpan()` 是**严格等于** detect 末尾的塌缩光标时才采用。相关纯函数和三连插入从
`__bwTest` 导出，离线复现不再依赖浏览器。


**B4. 失败必须自己上报，因为官方这条路径用「返回 false」而不是异常。**
从「点中一行」到「屏幕上出现 chip」之间仍有静默出口：`resolveForgeSessionInput` 自己的
catch、投影校验失败，以及 `insertReference` 用 `return false` 表达拒绝（phase 不是
plain/claimed、span 的 `draftRev` 与 shell 的 CAS 不符、或 detect span 无效）。任何一处
生效，点击都会表现为「什么都没有发生」，而调用方无法区分是哪一处。因此失败统一调用官方
输入框提示通道 `shell.notify("error", t("forge.attachFailed", { reason }))`（`notify` 是
`SessionInput` 的公开成员，官方自身也用它报队列/命令失败），并保持 picker 打开供重试。
配套诊断通道：`localStorage.setItem("dsh-bw-debug", "1")` 后刷新页面，`forgeTrace` 会把
`resolve → resolve.shell → caret/span.invalid → insert → done → pick` 每一步的判定值打到
`console.warn("[better-workspaces:forge]", …)`；关闭时零开销，`localStorage` 不可用时
静默关闭（Node 测试里天然关着）。

**B5. 纯文本不是可接受降级——引用插入必须原子化。**
发送路径 `sinkSerialized` 展开的是**编辑器里的 chip 节点**，不是草稿文字：

```js
const occurrences = this.projection.occurrences;         // 只由真实 chip 节点产生
if (occurrences.length === 0) { …原样发出 draft.trim()… }  // 纯文本走这条
Promise.all(occurrences.map(o => ({
  text: await inputTriggers.serializeReference(o.source, o.ref, …)   // 按 source/ref 路由
})));
```

因此 `codec.clipboardText` 是 `#N` **不影响**模型侧全文（路由靠 chip 的 `source`/`ref`，与
投影文字无关）；但反过来，**没有 chip 就没有 codec 展开**。曾有两个逐步补丁：第一版失败时
写裸 `#N`，模型只拿到编号；第二版为了保住模型上下文改写 `renderForgeReferenceText(item)`
正文，却破坏了“草稿中只显示一个小片”的产品契约。本次第三个 chip 的坐标 bug 证明，这种
兜底会把任何内部拒绝变成用户可见的大段正文，不能保留。

最终决定是原子化：`attachForgeReference` 只尝试 `insertReference`；成功才关闭 picker，失败
不调用 `setDraft`、不改草稿、显示原因并保持 picker 打开供重试。模型全文只在真实 chip 成功
进入编辑器后由 codec 生成。

**B6. 插入点由「草稿末尾」决定，而不是当前光标。**
`caretSpan()` 有选区时返回选区：选择器是对话框，用户点它时光标可能停在正文中间，照搬会让
chip 把已有文字切开。本控件的语义因此是「追加」——只有当 `caretSpan()` 给的是与
`referenceDetectEnd(target.snapshot)` **严格相等**的塌缩光标时才采用它，否则使用按 B3
公式重算的实时末尾。span 的 `draftRev` 始终取 shell 自己的 `rev`（`caretSpan()` 不返回
rev），而不是组件渲染期的 `InputState.draftRev`：后者只要比 shell 落后一次编辑，CAS 就会
拒绝。实时 snapshot 不可用时才读 render snapshot；两份投影都无法验证时直接失败并提示，
绝不猜测坐标。

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
