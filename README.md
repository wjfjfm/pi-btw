# pi-btw

从当前 Pi 会话 fork 出独立子会话。首版使用全屏浮层和快捷切换，尚未实现分屏。

## 原则

- 未使用时零上下文注入：不注册模型工具，不修改主会话 prompt/context。
- 创建、切换和执行 BTW 不向主会话自动回注；只有用户显式 merge 才发送消息。
- 独立 session 文件、独立 SDK 子进程；切换视图不暂停主会话或 BTW。
- 复用原生 `SessionManager.createBranchedSession()`，不自行重建有效历史。

## 试用

已在 Pi 1.3.0、Node 22 上测试。需要先构建子进程入口：

```sh
cd /path/to/pi-btw
npm ci --ignore-scripts
npm run build
pi -e /path/to/pi-btw/src/index.ts
```

| 操作 | 用途 |
| --- | --- |
| `/btw` | 首次 fork 并打开，之后打开已有 BTW |
| `/btw <问题>` | 向 BTW 提问并打开 |
| `Ctrl+Alt+B` / `Ctrl+Alt+F` | 主界面与全屏 BTW 切换；首次使用会创建 BTW |
| BTW 内 `Esc` / `/main` | 返回主界面，后台继续执行 |
| BTW 内 `Ctrl+C` | 仅取消 BTW 当前执行 |
| `PageUp` / `PageDown` | 滚动 BTW 对话 |
| `/btw merge full` | 合并 fork 后当前分支的完整原文 JSONL |
| `/btw merge summary` | 复用 Pi `/tree` 的 `generateBranchSummary()` |
| BTW 内 `/merge full` / `/merge summary` | 同上 |
| `/btw close` | 结束 BTW 子进程，保留 session 文件 |
| `/btw new` | 创建新 BTW（已有 BTW 时需先 close） |

快捷键需要终端支持相应按键编码。当前每个主会话最多打开一个 BTW。

## 快照与合并

同步捕获当前分支，在独立 SessionManager 上原生 fork，保留 compaction、context edits、标签和扩展持久化记录。继承模型、thinking、system prompt、设置和可发现的工具/扩展。

主 Agent 正在执行时也可以 fork。未完成工具在子会话内补明确的快照边界错误结果，不重放、不取消父工具；未完成流式响应作为观察记录附加到子会话。

`full` 不截断，包含新增消息、工具结果、图片原始数据及摘要记录，不重复带入 fork 前历史。`summary` 使用原生 tree prompt、预算和文件清单策略；原生摘要预处理会省略工具结果，并可能按预算舍弃较旧消息。摘要失败或取消不合并。

合并以可见 custom message 发送到父会话，使用 follow-up 排队，不中断父任务。同一 BTW revision 禁止重复合并；后续再次合并包含 fork 后全部对话，而非增量。

## 当前边界

**这是持久化会话 fork，不是整个运行时的完整克隆。**

- Pi 扩展 API 无法导出任意扩展内存、待发送队列、运行中工具进程和所有临时资源配置。仅注册 hook 的临时 CLI 扩展也可能无法被发现；自定义运行时工具无法恢复时拒绝启动，不默默降级。
- 扩展在子进程重新加载；有自身恢复策略的扩展可能改变状态（例如 goal 恢复为 paused）。内置工具扩展由子进程重新初始化。
- 子会话扩展以 print 模式绑定，尚未代理扩展对话框；全屏视图不是完整 Pi TUI，图片暂显示占位符。
- 父子共享工作目录和文件系统，写文件、bash、外部服务等副作用不隔离。进程隔离不等于工作区隔离。
- 退出父 Pi 会结束子进程；session 文件仍保留，可用 `pi --session <文件>` 独立恢复，但尚无重新挂接 BTW 的功能。
- 尚未完成真实交互终端的人工验收；自动化测试使用模拟模型，不调用在线模型。

严格的运行时克隆需要宿主提供快照导出与扩展状态恢复协议，不能仅靠本扩展保证。

## 测试

```sh
npm test
```

覆盖原生 fork、context edits/compaction、运行中父工具隔离、独立进程全局状态、显式 merge、原生摘要失败处理、全屏渲染，以及启用但不使用 BTW 时模型请求与基线完全相同（忽略时间戳）。
