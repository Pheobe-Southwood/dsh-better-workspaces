# 0009. 槽位 hook 的必填参数，以及「注册 ≠ 挂载」的验证

Date: 2026-09-11

## Context

composer 的 forge 控件（ADR 0008）上线后，宿主半完全正常（`GET /pulls`、`GET /pull` 都返回预期
JSON），但界面上始终没有那个按钮。排查过程本身比结论更值得记下来，因为它暴露了一类**静默失败**：

- 活页面的槽位注册表里**有**这条注册：`conversation.input.left` 的 occupants 列出
  `id: forge-issue-pr`、`order: 200`，位置与顺序都对；
- 同一个 occupant 是 `active: false`，而同插件注册在 `conversation.input.dock` 的
  `git-diff-pill` 是 `active: true`（界面上确实渲染着）；
- 组件返回的**最外层** `<div class="dsh-bw-forge">` 是无条件 return 的，但它也不在 DOM 里。

把「注册在表里 + 组件没挂载」这两件事对上，只剩一种解释：**组件在 render 期间抛了异常，React 把
这棵子树卸载了**，而注册记录与异常无关，所以表面一切正常。真正的原因是一行调用：

```js
props.useInput()             // 塌
props.useInput((s) => s)     // 对
```

槽位声明的 `standardProps` 把 hook 的类型写成 `SnapshotSelectorHook<InputState>`，它的签名是

```ts
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S;
```

**selector 是第一个必填位置参数**，不是可选。官方自己的每个调用点都写 `useInput((s) => s)`
（`dsh-client-ui-conversation` 内即有三处）。我按「hook 通常给整份快照」的直觉写了无参调用，
于是 render 里去执行 `undefined`，抛 `TypeError`。

两点让这个错特别难找：同文件里其他取数的 hook 都是 `useSyncExternalStore(subscribe, getSnapshot, …)`
——**它的签名没有必填位置参数**，无参调用完全合法（本站第 77 行官方代码就这么用），所以「其他
hook 都这么写」的类比在这里恰好是错的；而 `test/client-smoke.mjs` 当时的边界是「验证注册了什么」，
用 stub react 且从不渲染组件，于是这类错误整类落在测试之外。

## Decision

**A. 槽位 hook 一律显式传 selector，不依赖「hook 会给整份快照」的直觉。**
`useInput`/`useSession`/`useSessions`/`useWorkspaces`/`useStore` 全部是
`SnapshotSelectorHook`，selector 必填。取值一律写 `useX((s) => s)` 或更窄的选择器；「更窄的
选择器」本身也是这些 hook 存在的意义（订阅粒度更小、重渲染更少），无参调用即便未来变得合法也
不该写。

**B. 「注册成功」不作为任何验证的终点，验证必须走到组件真的返回了一棵树。**
新控件的渲染路径要有一次真实的挂载断言，而不是只断言 `slots.register` 被调用过。
`test/client-smoke.mjs` 现在的做法是：把 `ForgeAttachControl` 从 `__bwTest` 导出，给它
**忠实实现每一个槽位 hook**（`useInput` 校验入参是函数、`useSyncExternalStore` 调
`getSnapshot()`、并让会话列表里存在带 `cwd` 的会话，否则组件会走它那出于设计考虑的
「没有 cwd 就不渲染」提前返回），然后调用组件并遍历返回的元素树，断言包装元素、按钮、
本地化 `aria-label` 与图标子组件都在。`react-dom/server` 可解析时用真正的
`renderToStaticMarkup`，否则退回直接调用——两种方式都会跑完整个函数体，也就都会跑到每一个
hook 调用点，差别只在是否经过 React 自己的 reconciliation。这条护栏经过反向验证：把
`useInput()` 改回无参写法，它立刻失败在「useInput needs its required selector」。

**C. 定位这类问题时，先用运行时自省，再去猜。**
本次决定性的一步不是读代码，而是主机的客户端 Inspect Provider（`Slots.listSubTree`）读**活页面**
的槽树：一眼就看到「注册在、`active: false`」，并与同插件另一个槽位的 `active: true` 形成对照。
在那之前，所有磁盘侧证据（文件内容、内容哈希、bundle 字节）都已经证明「新代码到了浏览器」，
继续在部署链路上找原因只会是浪费时间。**能读到活运行时的时候，先读运行时。**

## Consequences

- 同类错误的下一次表现仍然会是「注册在表里、界面没东西」，因为这是官方槽位注册表的固有性质：
  occupant 记录与组件挂载是两件事。看到 `active: false` 就该先怀疑 render 抛错，而不是注册位置。
- 护栏依赖槽位 hook 的**签名**：官方若给某个 hook 增加或调整必填参数，这条断言会在 `npm test`
  阶段而不是浏览器里失败。这是本轮想要的次序。
- 护栏需要一个「像真的一样」的会话快照（当前是 `{ cwd: '/tmp' }`）。它的价值在于覆盖组件自己的
  提前返回；代价是它同时把 `cwd` 这个字段名固定成了契约的一部分——官方若改名，护栏会先失败，
  这比它静默不渲染要好。
- 本次修复没有碰宿主半：`pr-checkout`、`GET /pulls`、`GET /pull` 在第一轮就已验证通过，问题完全在
  客户端组件的挂载上。这条 ADR 因此只记「怎么发现和怎么防」，不重复 ADR 0008 的功能设计。
