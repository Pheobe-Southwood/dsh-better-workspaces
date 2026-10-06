# 0015：在线会话只有一个权威来源

## 背景：`sessions.list.current` 是一个从不存在的字段

`dsh-api-session-controller` 发布的会话列表快照只有四个字段：

```js
{ ids, byId, phase, projectionsBySession }
```

**从来没有 `current`**。在线会话（主视图里正在看的那个）属于 `uiSession`（`dsh-client-ui-session`）：它的快照是解析后的会话绑定，`binding.key` 就是 Session id。

本插件曾同时从两个地方读这件事：

| 位置 | 读法 | 结果 |
|---|---|---|
| hero 控件显示（`HeroControl`） | `mainViewKey ?? listState.current` | 主来源对，回退恒空 |
| 行为谓词（`currentSessionId()`） | `sessions.list.getSnapshot().current` | **恒 `undefined`** |

## 后果：不是一个坏判断，而是一整套失效的守卫

`currentSessionId()` 有 **9 个调用点**，全部因为恒 `undefined` 而失去意义：

| 位置 | 代码 | 实际行为 |
|---|---|---|
| `prepareStagedWorktree` 首道门 | `if (!sourceId \|\| currentSessionId() !== sourceId) return;` | **无条件静默 return**，在 `setBusy`/`setError`/`apiPost` 之前 |
| 每个 `await` 之后 | `if (currentSessionId() !== sourceId) throw ownershipError();` | 永不触发：操作丢失会话后仍会写进新的那个 |
| 清理分支 | `if (owns(token) && currentSessionId() === sourceId) setBusy(null)` | 永不执行 |
| `openWorkspaceFor` | `!expectedSessionId \|\| currentSessionId() === expectedSessionId` | 谓词失效 |
| 归档收尾 | `settledCurrent === sourceId` | 恒假，归档后不打开工作区 |

**用户可见症状**：hero 的「新建 worktree」按钮在（显示路径自己的 bug 已先行修好），点进去、填好名字、按钮可点，但点下去**什么都没有** —— 没有请求、没有忙碌态、没有任何错误。

危险之处在于它是**最坏的一种失败**：面板开了、按钮亮着、名字都填好了，唯独没有反馈。在此之前它还以「按钮灰着且无任何文案」的形态出现过（名字为空时 `branchNameProblem` 返回 `"empty"`，而旧文案只渲染 `"invalid"`）。

## 决定

1. **单一权威**：`currentSessionId()` 与 hero 显示路径共用同一个来源 ——
   `mainViewSessionSource ?? mainViewSessionFor(appCtx)`，取 `binding.key`。
2. **不保留回退**：明确删掉 `listState.current` 与 `heroDebugState.legacyCurrent` 的消费。
   第一次修这个 bug 时只改了显示读取点而没有改这个共享谓词，于是它以「创建永远静默失败」的形态存活了下来；再留一条回退，等于给同一类回归留一条暗道。
3. **`setTestRuntime` 连带清空缓存**：`mainViewSessionSource` 是 apply 时的捕获、dispose 时释放。跨运行时复用时必须一并清空，否则第二次物化（另一个测试、HMR、服务替换）会拿着**已死的 uiSession 绑定**，而新绑定就在旁边。
4. **测试桩不得伪造 `current`**：`test/client-react.mjs` 的会话快照一律不带该字段。伪造它会让所有谓词在离线套件里看起来健康，而真实页面一律答 `undefined` —— 这正是本回归能穿过整套测试的原因。

## 同类判据（新增核对项）

**在线会话 = `uiSession.current` 的 `binding.key`。** 任何从 `sessions.list` 上读「当前/在线/主视图」会话的写法都是错的，包括「作为回退读一次」。`sessions` 面提供的是**成员与生命周期**（`create`/`retain`/`using`/`binding`/`archive`），不提供「谁在屏幕上」。

附带同源的契约修正（同一次排查中发现，见 ADR 之外的注释）：

- **`sessions.open()` 不存在**。切换视图是工作区 UI 的职责：`uiWorkspace.openSession(id)`（即 `replaceMain(..., "reveal")`，`dsh-client-ui-workspace` 自己就是这么调的）。旧代码在**工作树已经建好之后**才抛 `sessions.open is not a function`，把一个已创建的工作树留在没有会话指向它的状态。
- **草稿交接需要目标会话被保留**。`conversation.input.for(actx)` 在缺少保留会话作用域时直接抛错（"requires a retained Session scope"），而 `resolveSessionInput` 用 `try/catch` 把它吞成 `null`。`sessions.create` 是**乐观**的（先落占位并返回 id），所以「等 create」永远等不到；必须先 `sessions.retain(targetId, {source})` + `await reference.ready`，交接完再 `release()`（成功的交接本身会切换视图，届时保留关系已由会话自身持有）。
- **交接失败必须自证原因**。七个前置条件原本都只回一个 `false`，调用方只能报「draft handoff was not committed」——既不说明原因，也只能靠一次浏览器往返去缩小范围。现在每个否决点都记录 `lastDraftTransferReason`，错误文本携带原因码与目标草稿状态。
