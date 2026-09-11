# Workspace 选择器采用能力边界，而不是路径自证

DSH 的外层认证只能说明调用者是谁，不能说明一次请求可操作哪个目录；因此 `cwd` / `path` 只作为选择器，宿主必须把它解析到当前 Workspace registry 中的精确规范根，或一个能同时由插件元数据、来源仓库、托管命名空间与 Git worktree 清单证明的托管 worktree。注册仓库的子目录不授予祖先仓库的 Git 权限：它仍可作为文件边界，但仓库级读取与变更要求选择器本身就是 Git 根。

文件选择保持“相对所选 Workspace 根”的产品语义，同时检查词法包含与规范路径包含，并只操作已打开的规范普通文件；这会拒绝指向边界外的软链接与 `.git` 管理路径。文件提交在同一宿主实例内按规范路径串行，以 Linux 原子交换替换并对换出的旧 inode 再验条件；临时或恢复文件只在 inode 仍匹配本事务时删除。Git 的 base/commit/path 也不是自由格式 Git 参数：base 只能是受限分支名或完整 OID，并在服务端解析为完整提交 OID；commit 只能是完整 OID；path 作为 literal pathspec 传递。PR 编号可由客户端选择，但 head、base 与 fork 身份必须由 Forge 在创建时重新给出，客户端副本不能驱动 ref 变更。破坏性 POST 只接受同源 `application/json`，依赖或授权源不可读时一律失败关闭。

## Considered Options

- 仅依赖 DSH 外层认证并信任绝对 `cwd`：兼容最宽，但把整个宿主文件系统和任意仓库暴露给插件 API，否决。
- 允许注册子目录自动提升为祖先 Git 根：方便 monorepo 子目录，但 Workspace 边界会被隐式扩大，且 reset/pull/worktree 无法可靠限域，否决。
- 只允许 registry 行：边界简单，但刚创建、尚未注册或正在回滚的托管 worktree 无法完成生命周期，故保留可验证的托管 worktree 证明路径。

## Consequences

Workspace registry 成为宿主 API 的硬依赖；调用者不能通过传入另一个绝对路径扩大权限。唯一的跨根写入是 Merge-to-base 由已授权 linked worktree 的 Git common-dir 推导出的主 checkout；任意其他 linked worktree 目标仍必须独立授权。托管 worktree 的全局根与仓库 hash 根必须是直接规范目录，创建前、`git worktree add` 前和元数据落盘前都会重验。历史伪造或损坏的 worktree 元数据不会被当作托管资产，清理与归档也不会在所有权未知或会话守卫不可读时删除目录；会话占用包含 worktree 的任意子目录，并在实际归档前刷新。客户端仍可解析原 JSON 结果，但输入、授权、冲突、缺失、过大与依赖故障使用对应的非 2xx HTTP 状态。