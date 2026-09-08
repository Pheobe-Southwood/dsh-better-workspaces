# 以锚点自检的 DOM 注入扩展原生 UI，而非影子替换槽位

需求要求两处进入原生 UI 内部：侧栏每个会话行标题下方的徽章行，以及预备区「工作目录」「模式」两个下拉之间的 worktree 下拉。这两处都没有细粒度 Cordis Slot——唯一缝隙是 `sidebar.workspaces` 与 `conversation.hero.workspace` 两个单占用者槽，其原生占用者（WorkspaceBrowser 约 1500 行、WorkspacePicker）包含搜索、分组树、拖拽排序、重命名/删除对话框、目录创建流等完整交互；影子替换意味着整体复刻并从此与上游漂移。

**决定**：保留全部原生 UI，用 MutationObserver 锚定的 DOM 注入 + React portal + 作用域 CSS 扩展这两处；会话身份映射以 React fiber 反查行组件 props 为主、标题文本匹配兜底。每个注入器挂载时与每次结构变化时做锚点自检：锚点缺失即静默降级（不注入、console 告警），绝不破坏原生渲染。具备正规加法槽位的界面一律走官方注册而非注入：「文件」「diff」tab 注册进 `conversation.view`（list slot，order 20/30），diff pill 注册进 `conversation.input.dock`。

**后果**：dsh 升级改动 DOM 时，降级表现是「徽章/下拉不可见」而非界面损坏；修复即更新锚点选择器。所有注入代码集中于独立的注入面模块，锚点选择器声明为具名常量，便于升级后逐点核对。
