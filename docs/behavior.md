# pi-btw 行为与限制

[返回 README](../README.md)

从当前 Pi 会话 fork 独立子会话，支持多个 BTW、嵌套派生、全屏切换与显式合并。尚未实现分屏。

## 原则

- 未使用时零上下文注入：不注册模型工具，不修改主会话 prompt/context。
- 创建、切换和执行 BTW 不自动回注。只有用户显式 merge 才发送消息。
- 每个 BTW 有独立 session 文件和 SDK 子进程。切换不暂停后台执行。
- 复用原生 `SessionManager.createBranchedSession()`，不自行重建有效历史。

## 使用

Pi 1.3.0、Node 22：

```sh
cd /path/to/pi-btw
npm ci --ignore-scripts
npm run build
pi -e /path/to/pi-btw/src/index.ts
```

在主界面或 BTW 输入 `/btw [问题]`，从当前聚焦会话创建新的 BTW。也可用 `/btw new [问题]`。原有 BTW 继续运行。

| 快捷键 | 操作 |
| --- | --- |
| `Esc` | 回到主界面；菜单中取消菜单 |
| BTW 内 `Ctrl+C` | 仅取消当前 BTW 执行 |
| `PageUp` / `PageDown` | 滚动当前 BTW 对话 |

BTW 不注册全局快捷键；统一通过 `/btw list` 切换会话，Esc 返回 main。`Ctrl+B/F` 保留原生光标移动行为。

`/btw list` 按 source 关系树状显示 main 和全部 BTW，标注来源、运行状态；选择后切换，取消则留在当前会话。来源已关闭的分支仍列出，并标注 `(closed)`。

会话列表及 merge 的来源/目标列表，在会话信息同一行后方，以暗色显示“第一条 … 最新一条”正文预览，不添加首/末标签。BTW 只取派生后的对话，不混入继承历史；不显示 thinking 或工具输出，不调用模型。长内容截短显示，原始对话不变。

在 `/btw list` 中用 ↑↓ 高亮要合并的 BTW，按 **m** 进入与 `/btw merge` 相同的选项弹窗；Enter 切换会话，**c** 直接关闭高亮 BTW，Esc 取消。main 不可关闭。列表默认高亮当前会话，不再提供 `Merge…` 条目或额外来源选择。目标可选 main 或其他可用 BTW，不包括自身。任一步取消都不合并。

在当前 BTW 中也可使用：

```text
/btw list
/btw merge
/btw merge source
/btw merge main
/btw close
```

`/btw merge` 打开统一弹窗；`/btw merge source` 仅将目标预设为直接来源，仍须确认。

```text
Merge to:           main
Close current btw:  Yes
Summary:            No
Conversation:       Strip

[OK]  Cancel
```

默认聚焦 OK，下一个为 Cancel，再依次进入四个字段。Tab / ↑↓ 移动焦点，←→ 修改值。Merge to 字段只显示 main / BTW 编号，不带树形前缀；在该字段按 Enter 打开带层级、状态和预览的目标列表，默认高亮已选目标，↑↓ 选择、Enter 选中并返回弹窗，Esc 返回且保留原目标。列表支持滚动，不包含源 BTW 或已关闭目标。选择目标不会确认合并。其他字段用 Enter 切换，按钮用 Enter 确认；主弹窗 Esc 取消。每次打开恢复上述默认值。

- **Close current btw**：确认目标当前分支已落盘本次 merge 后，才关闭所选源 BTW 并从列表移除，保留会话文件与其后代；No 则保留源 BTW。
- **Summary**：Yes 使用原生 tree 摘要，No 不请求摘要模型。
- **Conversation**：Full 保留完整对话内容（含 thinking、工具调用与结果）；Strip 仅保留用户/助手正文、图片及可见 custom 消息；None 不附对话。两者均按角色分段，不直接注入会话存储 JSONL。
- Summary No + Conversation None 没有可合并内容，弹窗会阻止确认。取消、摘要失败、投递失败或确认超时均不关闭源 BTW。

不提供 `/merge` 或 `/main` 命令。主界面可通过 `/btw list → 高亮 BTW → m` 合并已有 BTW。

`source` 是直接来源；`main` 是最初主会话。关闭只结束当前 BTW，不关闭其后代。source 已关闭时，合并到 source 明确报错，仍可合并到 main。关闭保留 session 文件。

## 持久化

新建 BTW 的对话文件放在会话目录的 `btw-sessions/` 子目录，嵌套 BTW 复用该目录，不参与 Pi 原生 `--continue` 和 `/resume` 的顶层会话发现。BTW 仍通过 `/btw list` 恢复，也可用 `pi --session <完整路径>` 单独打开。

旧版放在顶层的 BTW 文件不会自动搬动，避免破坏仍在写入的进程和已有工作区引用。因此旧文件仍可能被 `--continue` 选中；迁移前请使用 `pi --session <主会话完整路径>`，不要把 `/reload` 当作旧文件迁移。

BTW 列表按主 session 保存。重新打开同一主会话或 `/reload` 后，`/btw list` 恢复列表、source 关系、已保存草稿与合并去重记录。恢复的条目标记为 `saved`；切换到它时才启动子进程，沿用原 session 文件，不自动发送提示或续跑中断任务。未完成工具不会重放。

列表以权限 `0600` 原子写入主 session 目录下的 `btw-workspaces/<主session-id>.json`，包含恢复所需配置，不进入模型上下文。草稿在切换或正常退出时保存。主会话使用 `--no-session` 时不保存列表；`/btw close` 从列表移除该项，但仍保留子会话文件。新功能不自动导入旧版本未登记的 BTW 文件。

## 显示与网络

BTW 状态栏在当前分支编号与来源后，复用 `/btw list` 的暗色“第一条 … 最新一条”正文摘要；新消息完成后更新，不请求模型，并按终端宽度截断。

使用 Pi 原生用户、助手、custom message 和工具执行组件，保留 Markdown、代码高亮、thinking 和错误显示。IPC 同步后台状态、流式内容与最终回复；切走再返回仍能看到最新内容。进程故障也会显示，不把空正文当作没有消息。

SDK 子进程显式初始化 Pi 的 HTTP 代理及超时配置，支持环境变量 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。此处复用 Pi 1.3.0 内部 `http-dispatcher` 适配器，升级宿主版本时需要回归测试。

## 快照与合并

同步捕获当前分支，在独立 SessionManager 上原生 fork，保留 compaction、context edits、标签和扩展持久化记录。继承模型、thinking、system prompt、设置和可发现的工具/扩展。从 BTW 派生时由源子进程捕获其当前状态，不读取旧缓存替代现场。

运行中也可以 fork。未完成工具在子会话内补明确的快照边界错误结果，不重放、不取消源工具；未完成流式响应作为观察记录附加到子会话。

合并只取 fork 后当前分支，不重复包含继承历史。Full/Strip 将对话格式化为 User、Assistant、Note 等分段，保留正文换行；去除存储 type/id/parentId/timestamp、模型/供应商、usage/费用及系统配置。Full 额外保留 thinking、工具参数/结果及 details、错误状态、隐藏 custom 正文、分支和压缩摘要；工具调用用本次合并内的 #1、#2 编号与结果关联，参数使用缩进 JSON，工具输出使用代码块。图片作为原生 image block 传递，不把 base64 当文本注入。原始 JSONL 留在会话文件，不修改；已有合并消息不会被追溯重写。上述整理不请求模型、不截断对话内容。

Summary Yes 复用 Pi `/tree` 的 `generateBranchSummary()`，使用原生 prompt、预算和文件清单策略；原生摘要预处理省略工具结果，并可能按预算舍弃较旧消息。摘要失败或取消不合并。

合并以可见 custom message 发送，使用 steer 排队，不取消当前工具批次，在其完成后进入下一次 API 请求。每次带唯一 merge ID，只有在目标会话文件当前分支查到该 ID 才确认成功；排队不等于送达。等待期间保留源 BTW，阻止同源同目标重复投递。两分钟未确认会提示超时并保留源，迟到的消息仍可能被目标消费，重试前请检查目标。关闭/重载会停止确认监控，未确认源仍保留在工作区，不自动重发。无持久化目标文件时无法确认，保守地保留源。即使已确认，若源在等待期间新增消息、正在运行或有草稿，也不会自动关闭。每个目标分别防止同一 revision 重复合并；后续合并包含 fork 后全部对话，而非增量。不修改或删除原始对话文件。确认合并并通过校验后立即切换到目标，不等待摘要、投递或落盘确认；失败仍保留源，不自动跳回。后续确认与后台关闭不抢焦点。Close current btw 默认 Yes；关闭当前焦点 BTW 后直接回到 main；关闭后台 BTW 不改变当前焦点。

## 当前边界

**这是持久化会话 fork，不是整个运行时的完整克隆。**

- Pi 扩展 API 无法导出任意扩展内存、待发送队列、运行中工具进程和全部临时资源配置。仅注册 hook/provider 的临时 CLI 扩展可能无法从主会话发现；自定义运行时工具无法恢复时拒绝启动，不默默降级。
- 扩展在子进程重新加载，可能应用自身恢复策略，例如 goal 恢复为 paused。内置工具扩展重新初始化。
- 子会话扩展以 print 模式绑定，尚未代理扩展对话框及跨进程自定义渲染器；工具使用原生通用渲染，图片仍为占位而非终端图像。
- 父子共享工作目录和文件系统，写文件、bash、外部服务等副作用不隔离。进程隔离不等于工作区隔离。
- 退出主 Pi 会结束全部子进程；重新打开同一主会话可恢复 BTW 列表，执行中的进程和未持久化扩展内存不会恢复。也可用 `pi --session <文件>` 单独打开子会话。

## 验证

```sh
npm test
```

覆盖原生 fork、context edits/compaction、运行中父工具隔离、独立进程与嵌套 fork、source 合并、原文与原生摘要、错误/流式渲染、列表切换和关闭、真实 HTTP CONNECT 代理，以及未使用 BTW 时模型请求与基线相同（忽略时间戳）。

此外已在隔离 tmux 终端使用模拟模型验证创建、输入、回复可见性、嵌套创建、会话切换、source merge 和直接关闭；不代表所有终端或在线模型均已验证。
