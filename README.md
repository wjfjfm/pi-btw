# pi-btw

从当前会话派生独立分支，并行探索，按需合并回主线。

```text
main ────────────────◀── merge
       ╰── BTW 1 ──────╯
            ╰── BTW 2
```

## 使用

```text
/btw 检查另一种实现方案
```

新分支继承当前上下文，在独立进程中运行，不打断原会话；也可以从 BTW 继续派生。首次提问时附带分支提示：除非用户明确要求，否则不继续原任务，避免并发冲突。只有显式合并才回注结果。

| 操作 | 命令 / 快捷键 |
| --- | --- |
| 返回 main | `Esc` |
| 查看分支 | `/btw list`；Enter 切换，**m** 合并，**c** 关闭高亮分支 |
| 合并当前分支 | `/btw merge` |
| 关闭当前分支并返回 main | `/btw close`（直接执行） |
| 中断当前 BTW | `Ctrl+C` |

列表保留树形层级，按分支及所有后代的最新更新时间倒序排列，main 置顶。列表与状态栏显示分支正文摘要，不调用模型。重开同一主会话后，可通过 `/btw list` 恢复分支。

## 合并

`/btw merge` 与列表中的 **m** 打开同一个弹窗：

```text
Merge to:           main
Close current btw:  Yes
Summary:            Yes
Conversation:       Strip

[OK]  Cancel
```

默认聚焦 OK。Tab / ↑↓ 移动焦点，←→ 修改选项，Enter 确认，Esc 取消。

- **Merge to**：main 或其他 BTW；`/btw merge source` 预选直接来源。
- **Summary**：是否生成摘要。
- **Conversation**：Full 保留正文、thinking、工具调用与结果；Strip 只保留正文、图片和可见消息；None 不附对话。Full/Strip 均按角色分段，去掉存储元数据，图片作为原生图片传递。
- **Close current btw**：目标确认落盘后才关闭源分支，始终保留原始会话文件。

目标忙时通过 steer 排队，在当前工具批次结束后进入下一次 API 请求。失败或两分钟未确认，源分支保留；等待期间源有新消息、运行任务或草稿，也不会自动关闭。超时不代表队列已取消，重试前请检查目标。

分支共享工作目录，**不隔离文件修改**。新会话文件存入 `btw-sessions/`，不参与原生 `--continue`；旧版顶层文件需手动指定主会话恢复。更多见[行为与限制](docs/behavior.md)、[大会话性能与基准](docs/performance.md)。

## 本地运行

Pi 1.3.0，Node.js ≥22.19.0。

```sh
cd /path/to/pi-btw
npm ci --ignore-scripts
npm run build
pi -e ./src/index.ts
```
