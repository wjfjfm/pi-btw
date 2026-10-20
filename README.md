# pi-btw

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
| `Ctrl+Alt+B` | 上一个会话 |
| `Ctrl+Alt+F` | 下一个会话 |
| `Ctrl+Alt+N` | 从当前会话新建 BTW |
| `Ctrl+Alt+M` | 选择 merge 到 source/main，再选择原文/summary |
| `Ctrl+Alt+X` | 确认后关闭当前 BTW |
| `Esc` | 回到主界面；菜单中取消菜单 |
| BTW 内 `Ctrl+C` | 仅取消当前 BTW 执行 |
| `PageUp` / `PageDown` | 滚动当前 BTW 对话 |

前后切换按创建顺序循环，包含主会话。快捷键显示在 BTW 底栏，需要终端支持相应按键编码。

在当前 BTW 中也可使用：

```text
/btw next
/btw prev
/btw merge
/btw merge source full
/btw merge source summary
/btw merge main full
/btw merge main summary
/btw close
```

`/btw merge full|summary` 默认目标为 source。不提供 `/merge` 或 `/main` 命令。主界面要合并/关闭已有 BTW，请先切换到它。

`source` 是直接来源；`main` 是最初主会话。关闭只结束当前 BTW，不关闭其后代。source 已关闭时，合并到 source 明确报错，仍可合并到 main。关闭保留 session 文件。

## 显示与网络

使用 Pi 原生用户、助手、custom message 和工具执行组件，保留 Markdown、代码高亮、thinking 和错误显示。IPC 同步后台状态、流式内容与最终回复；切走再返回仍能看到最新内容。进程故障也会显示，不把空正文当作没有消息。

SDK 子进程显式初始化 Pi 的 HTTP 代理及超时配置，支持环境变量 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`。此处复用 Pi 1.3.0 内部 `http-dispatcher` 适配器，升级宿主版本时需要回归测试。

## 快照与合并

同步捕获当前分支，在独立 SessionManager 上原生 fork，保留 compaction、context edits、标签和扩展持久化记录。继承模型、thinking、system prompt、设置和可发现的工具/扩展。从 BTW 派生时由源子进程捕获其当前状态，不读取旧缓存替代现场。

运行中也可以 fork。未完成工具在子会话内补明确的快照边界错误结果，不重放、不取消源工具；未完成流式响应作为观察记录附加到子会话。

`full` 包含 fork 后当前分支的完整原文 JSONL，不截断，保留新增消息、工具结果、图片原始数据及摘要记录，不重复包含 fork 前历史。`summary` 复用 Pi `/tree` 的 `generateBranchSummary()`，使用原生 prompt、预算和文件清单策略；原生摘要预处理省略工具结果，并可能按预算舍弃较旧消息。摘要失败或取消不合并。

合并以可见 custom message 发送，使用 follow-up 排队，不中断目标任务。每个目标分别防止同一 revision 重复合并；后续合并包含 fork 后全部对话，而非增量。合并后不关闭 BTW。

## 当前边界

**这是持久化会话 fork，不是整个运行时的完整克隆。**

- Pi 扩展 API 无法导出任意扩展内存、待发送队列、运行中工具进程和全部临时资源配置。仅注册 hook/provider 的临时 CLI 扩展可能无法从主会话发现；自定义运行时工具无法恢复时拒绝启动，不默默降级。
- 扩展在子进程重新加载，可能应用自身恢复策略，例如 goal 恢复为 paused。内置工具扩展重新初始化。
- 子会话扩展以 print 模式绑定，尚未代理扩展对话框及跨进程自定义渲染器；工具使用原生通用渲染，图片仍为占位而非终端图像。
- 父子共享工作目录和文件系统，写文件、bash、外部服务等副作用不隔离。进程隔离不等于工作区隔离。
- 退出主 Pi 会结束全部子进程；文件保留，可用 `pi --session <文件>` 独立恢复，但尚无重新挂接整个工作区的功能。

## 验证

```sh
npm test
```

覆盖原生 fork、context edits/compaction、运行中父工具隔离、独立进程与嵌套 fork、source 合并、原文与原生摘要、错误/流式渲染、双向切换和关闭、真实 HTTP CONNECT 代理，以及未使用 BTW 时模型请求与基线相同（忽略时间戳）。

此外已在隔离 tmux 终端使用模拟模型验证创建、输入、回复可见性、嵌套创建、双向切换、source merge 和关闭确认；不代表所有终端或在线模型均已验证。
