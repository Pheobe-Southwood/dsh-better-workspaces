# 0006. diff 迁入官方右侧栏，会话「文件」视图下线

Date: 2026-09-10

## Context

dsh 0.1.5 给 Web GUI 的官方右侧栏加了「文件」面板
（`dsh-client-ui-sidebar-files`：注册 kind `files` 的 page 类型，配
`sidebar.right.pane.tab` 视图体）。本插件此前在**会话顶部 Tab** 里自带
`文件`（order 20）与 `diff`（order 30）两个 `conversation.view`：

- `文件` 与被官方取代的能力重合——同一棵 cwd 文件树、同一个 `POST /file`
  sha1 CAS 编辑器，还额外背着从 paseo 转录的 material 图标表与 Oklab 去饱和
  工具（NOTICE 第 1 项）与只服务它的 `GET /tree` 路由；
- `diff`（四模式 diff、提交列表、操作阶梯、编辑器）没有官方等价物，但它挂在
  会话 Tab 里，与 dsh 把「右侧栏」当成内容面板的布局方向相反。

迁移的约束来自官方右侧栏自己的契约：

- 一个页签类型分两段注册：定义进 `ctx.sidebarRightTabs`，视图体与页签标题分别
  进 keyed 槽 `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`，
  key 必须等于定义的 `id`。
- `ctx.slots.register` 对**未声明**的槽直接抛错；`ctx.slots.inject(name, fn)`
  会等到槽被声明（并在声明塌缩后重跑）。也就是说视图体/标题的注册天然可以
  「先注册、后声明」，但**没有**右侧栏时注册会永久挂起而不是报错。
- `ctx.sidebarRightTabs` 是另一个插件在 apply 期提供的服务。cordis v4 的
  `inject` 没有 optional 语义：把 `sidebarRightTabs` 写进本插件的 `inject`
  会让「没有右侧栏的 dsh」上整行 pending——hero、徽章、worktree 预备全部
  陪葬（ADR 0005 记录过同型的宿主侧事故）；而 apply 期 `ctx.get` 探测又存在
  竞态。
- 官方 `defaultSeed(tabs)` 只在**恰好一个** guide 条目时把新会话的右侧栏直接
  落在那个类型上；多于一个就回落到 guide 选择页。

## Decision

1. **删除会话「文件」视图**：`conversation.view` 的 `files` 注册、`FilesView`
   组件、material 图标表与 Oklab 工具、只服务它的文案与 CSS，以及宿主侧
   `GET /tree` 路由一并移除；NOTICE 第 1 项删除。`GET/POST /file`（编辑器
   读与 CAS 写）保留——diff 视图的「编辑」仍用它。
2. **diff 成为官方右侧栏的 page 类型**：`id = dsh-better-workspaces/diff`、
   `kind = bw-diff`、`priority = extension`；视图体复用原 `DiffView`，右侧栏内
   改为上下布局（文件列表在 diff 之上）以适配 300 px 起的窄面板，并按
   `tabInfo.tab.visible` 暂停非活动页签的自动重取。
3. **不注册 guide 条目**。多一个条目会把每个会话首次打开右侧栏的默认页从官方
   「文件」改成 guide 选择页，等于本插件改掉 dsh 的默认行为。入口是输入框上方
   的 `±` 胶囊：有变更显示 `+N −N`，仅未提交显示变更文件数，仅未推送显示
   `↑N 未推送`，干净时显示 `diff`——常驻是必要的，因为会话 Tab 里不再有
   diff 页签，旧行为（干净时隐藏胶囊）会让 diff 彻底不可达。
4. **服务依赖用子 fiber 等待，不用硬 inject、也不用 apply 期探测**：
   `ctx.inject(["sidebarRightTabs"], (scoped) => { … })` 让注册推迟到服务出现，
   插件本体立即激活；老版 dsh 上只是没有 diff 页签。视图体/标题再各自走
   `scoped.slots.inject(...)` 等待槽声明。`±` 胶囊在取不到 `ctx.sidebarRight`
   时渲染 `null`（不留死按钮），`openTab` 在没有挂载 seat 时抛错被吞掉。
5. `package.json` 的 `dsh.client.inject` 声明
   `@deepseek-ai/dsh-client-ui-sidebar-right`，保证该客户端模块先被加载；
   导出的 cordis `inject` 名单保持不变。

## Consequences

- 「文件」只有官方一份实现；本插件少 214 行图标表 + 128 行文件树视图与一条
  宿主路由，也不再随 dsh 的文件面板漂移。
- diff 与会话 Tab 解耦：右侧栏的页签条、浮动/分屏、宽度拖动都是官方能力，
  插件只贡献一个 page 类型。
- 老版 dsh（无右侧栏）上 diff 页签与 `±` 胶囊都不出现，其余功能完好——这是
  相对硬 inject（整行 pending）的取舍，也是本 ADR 复述 ADR 0005 教训的地方。
- 官方若将来支持 optional inject，第 4 条可以简化为一次声明；若官方把
  `defaultSeed` 改成「多个条目时优先某个默认类型」，guide 条目可以再加回来。
- `test/client-smoke.mjs` 现在断言：0 个 `conversation.view`、类型定义不带
  guide、`sidebar.right.pane.tab(.title)` 以定义 id 为 key、`inject` 名单未变。

## Amendment 1 (field request): diff also ships a guide entry

用户要求 diff 与官方「工作区文件」平级，因此 `sidebarDiffDefinition()` 增补了
`guide: [{ order: 20, title, description, icon }]`：右侧栏「开始」页多出一张
「代码变更」卡片，点它即在当前 pane 打开 diff（官方的 `+` 控制同样是打开
「开始」）。

这推翻了本文第 3 条「不注册 guide 条目」的取舍，并明确接受它的代价：
`defaultSeed` 只在 guide 条目恰好唯一时把某会话首次打开的右侧栏直落该类型，
现在有两个条目，于是没有历史布局状态的会话会落在「开始」选择页，而不是官方
「文件」。取舍理由是可发现性——`±` 胶囊藏在输入框上方，「找不到 diff 入口」是
真实反馈；而选择页本身是官方的导航面，不算破坏性改变。

输入框上方的 `±` 胶囊保留：卡片负责“被看见”，胶囊负责“一键”。
