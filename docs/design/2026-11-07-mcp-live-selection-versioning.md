# MCP live 變更：版本化 selection 設計（草案）

Status: **設計中 2026-11-07**（對應 debt round 499–503）。尚未實作。

## 問題

會話進行中新增／修改 MCP server 時：

1. `desktop/mcp/mutate` 會觸發 `plugins.refresh()` → `service.refreshExtensions()` →
   每個 live session 的 `selection.refresh()`；
2. refresh 必須完成 MCP handshake（最長 ~60s），期間該會話 submit 回
   `Gateway plugin refresh pending`；
3. handshake 失敗（即使 server 有效，實測仍失敗）會把該 session selection 標成
   `failed` → 之後 `Gateway plugin refresh requires recovery`，只能重啟；
4. 直接跳過 refresh（defer）也不行：下一次 submit 立即回
   `MCP settings changed after selection`（selection 的 currentness 檢查 MCP 快照）。

根因：MCP 設定、session selection、plugin mount 三者共用**同一份可變快照**，沒有版本切換。

## 設計：兩份快照 + 原子切換

### 狀態

```
committed: McpConfigSnapshot      // 目前 live sessions 使用的版本
pending?:  { snapshot, flight }   // 正在掛載的新版本
```

- `activeWitness()`（給既有 session 的 currentness）永遠回 `committed`；
- 新版本掛載時：
  1. `store.save` 只寫磁碟；
  2. 建立 `pending = { snapshot: 新設定 }`；
  3. 用 **pending 快照**建立新的 plugin mount（不影響 committed）；
  4. 成功 → `committed = pending.snapshot`，並對 live sessions 換上新的 mount；
  5. 失敗 → 丟棄 pending，committed 不變，settings 顯示 applyError，**會話照常可用**。

### 需要的介面調整

1. `captureOwnedGatewaySelection` 增加 `mcpSnapshot` 參數（預設 committed）；
2. `service.refreshExtensions()` 接受「candidate snapshot」，只mount / 更新 extensions，
   不改 selection currentness；
3. `mcp.activeWitness()` 拆成 `committedWitness()`（session 用）與
   `pendingWitness()`（refresh 用）；
4. `desktop/mcp/state` 顯示 `active` 與 `pending` 版本，讓使用者知道新設定要等掛載完成。

### 為什麼不用「放寬 failed」

`owned-plugin-refresh-adoption.test.ts` 要求 refresh 失敗時 selection 必須 poison，
因為舊 mount 的 extension catalog 與新設定不一致時，任意沿用會產生錯誤工具呼叫。
版本化切換讓「舊 mount + 舊設定」保持自洽，才安全。

## 測試計畫

1. unit（desktop-gateway）：mock mount 成功 → committed 版本切換、live session 拿到新工具；
2. unit：mock mount 失敗 → committed 不變、舊 session 下一次 submit 成功、state 有 applyError；
3. unit：refresh 進行中 submit → 不阻塞（用 committed）；
4. app 實測：rc14+ 開會話 → enable valid MCP → 立即 submit 成功 → 新工具可用；
5. app：enable 壞 MCP → submit 成功、舊工具不變、重試 enable 可成功。

## 工作量與風險

- 改動集中在 `desktop-gateway`（mcp-settings / owned-gateway-selection / host）與
  `session-executor` 的 refreshExtensions；
- 風險：plugin extensions 與 selection 的一致性、正在寫入的 turn 與 mount 切換的競態；
- 建議分兩步：先做「失敗不 poison」，再做「背景切換」。
