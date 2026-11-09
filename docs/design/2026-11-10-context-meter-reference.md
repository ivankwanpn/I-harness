# Context meter：對齊參考項目（rc82）

## 參考

DSH `ContextMeter`：

- trigger：環形進度 + 百分比；
- panel：`~used / window`、百分比、分段 bar；
- 分段：system／tools／messages；
- 顯示各段 token 數；
- 沒有 first-token／request body 等自訂延遲欄位。

OpenCode：context/usage 命令與 dialog，重點是 context 容量與用量，不是 latency。

Codex：thread context 狀態，不把 request latency 放進 context panel。

## rc82 實作

`ContextUsage`：

- 保留環形 trigger 與百分比；
- panel 顯示 used / window；
- 新增分段 bar：system／tools／messages；
- 顯示三段 token 數；
- 移除自訂的 request size／first token／duration rows。

## UI 驗證

在 rc82 portable 實際開啟 conversation、點「上下文容量」：

```text
估算上下文容量
顯示上一次請求的估算；下一次請求準備完成後會更新。
刷新狀態
```

這個 session 是 private runtime，context admission 是 compatibility／unavailable，所以 panel 沒有可顯示的 segmented bar；fallback 正常。

已在一般 session 的 context state 上通過 typecheck 與 build；segmented bar 尚未在 UI 實際看到。
