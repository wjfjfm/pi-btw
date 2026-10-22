# pi-btw

从当前对话开一个分支，并行探索，按需合并回来。

```text
/btw 检查另一种实现方案
```

| 操作 | 命令 / 快捷键 |
| --- | --- |
| 返回主会话 | `Esc` |
| 查看分支 | `/btw list`；Enter 切换，**m** 合并，**c** 关闭 |
| 合并当前分支 | `/btw merge` |
| 关闭当前分支 | `/btw close` |
| 中断当前分支 | `Ctrl+C` |

合并时可选择目标、摘要、对话内容，以及是否关闭当前分支。

只有主动合并才会回传结果。**分支共享文件，请避免并发修改。**

## 本地运行

需要 Pi 1.3.0、Node.js ≥22.19.0。

```sh
npm ci --ignore-scripts
npm run build
pi -e ./src/index.ts
```
