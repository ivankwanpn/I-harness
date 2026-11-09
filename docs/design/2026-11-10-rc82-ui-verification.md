# rc82 UI 驗證（2026-11-10）

## Context 面板

從 sidebar 實際展開 `test` 專案、點擊會話列，開啟 conversation，再點「上下文容量」。

在 popup 開著時送出一次 prompt，popup 顯示：

```text
最近一次模型請求
請求大小  590 KB
首個 token  1542 ms
完整請求  3084 ms
```

這確認 `ContextUsage` 的 request facts 在真實 renderer 中可用。

限制：只顯示 component mount 後完成的新請求；歷史請求不會自動載入。

## Child projection（rc82）

在 rc82 portable 上實際 spawn：

```text
spawn_agent(task_name=verify-rc82) → RC82
close_agent(root/verify-rc82) → succeeded
```

child header 實際寫入：

```json
{"subagentTaskId":"task-16","subagentAgentPath":"root/verify-rc82"}
```

## 版本

- rc82 只在本地；
- 沒有 GitHub release；
- 未合併。