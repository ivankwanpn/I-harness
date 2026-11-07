# MCP live reload：跨越 opencode／DSH／codex 的設計整理

參考：`D:\ih_reference_project` 的 `opencode-2.2.6`、`deepseek-harness-dsh-v0.2.2-alpha.2`、
`codex-rust-v0.166.0`。

## 1. opencode 2.2.6：pool + holders

* `packages/core/src/mcp/pool.ts`：MCP 連線以 key（config、cwd、credential）放進 pool；
  每個 Location（session/workspace）start 時 join、stop 時 release，最後一個 holder 離開才關閉。
* 設定變更只影響連線池，不會重建 session 的 plugin selection；
  `packages/app/e2e/regression/mcp-workspace-toggle.spec.ts` 直接驗證 UI toggle 後**不需重啟會話**。

## 2. DSH 0.2.2：per-server MCP client plugin

* `docs/subsystems/mcp.md`：「The client is a per-server connection plugin and a consumer of the harness
  tool registry. It does not publish a shared `ctx.mcp` service.」
* 每個 server 是 Cordis scope 中的一個 client plugin；scope disposal 會**移除工具註冊**，
  重新配置＝重新掛載 plugin，不影響 session 的 plugin selection。
* 「A failed refresh retains the previous tool generation」——失敗保留上一代工具。

## 3. codex 0.166：session 級 McpRuntime + 失效旗標

* `core/src/session/mcp_refresh.rs`：`McpRefresh { pending: AtomicBool, gate: Semaphore }`；
  config 變更只 `invalidate()`；下一次 turn 由 `refresh_mcp_if_dirty()` claim + 重建；
  `McpRefreshInvalidationGuard` 在取消時把 dirty 還原。
* `session/config_refresh.rs`：`refresh_mcp_config(expected, next)` 用 **CAS**（`Arc::ptr_eq`）驗證
  expected config 仍是最新，否則回 `Stale` 讓呼叫端重試。
* `session/mcp_runtime.rs`：`publish_mcp_runtime` → `mcp_runtime.replace(input)` 原子替換 runtime；
  新 runtime 只影響**之後的 turn snapshot**，進行中的 turn 保留原 capture policy。
* `mcp_prewarm` 在背景先建立連線，避免 turn 被 handshake 阻塞。

## 4. 三個專案共同結論

1. **MCP 不屬於 session/plugin selection 的一部分**；它是可獨立替換的 runtime。
2. 設定變更只標記失效，**在 turn 邊界**比較 desired/current 並增量 mount/unmount，
   不在設定請求路徑上同步重建。
3. 失敗保留上一代 runtime（工具仍可用），只回報警告，**不 poison session**。
4. 用 CAS／revision 避免重疊變更互相覆蓋；進行中的 turn 不受影響。

## 5. IH 的落地方案（McpRuntime.replace）

### 5.1 移除 selection 耦合

* `captureOwnedGatewaySelection` 不再包含 `mcp.configs`（plugin: MCP 仍走 plugin inputs）；
* `desktop/mcp/mutate` 只寫檔 + 更新 in-memory `active` 快照 + 對 live sessions `invalidate()`。

### 5.2 Session 級 MCP runtime

```ts
interface SessionMcpRuntime {
  mounted: Map<string, { config: McpServerConfig; handle: McpMountHandle }>
  dirty: boolean
  revision: number
  invalidate(revision: number): void
  publish(desired: McpServerConfig[]): Promise<'published' | 'stale' | 'failed'>
}
```

* `publish` 先 diff：移除的 server `handle.dispose()` + `tools.unregister`；
  新增/變更的 server `mountMcpClient` + `tools.register`；名稱與工具名前綴沿用現有規則。
* 任一個 mount 失敗：該 server 記為 `failed`（工具不出現），其他 server 照常發布。

### 5.3 Turn 邊界

* admission／pre-step 檢查 `dirty`，在工具清單建構前 `publish(active())`；
* publish 期間 turn 尚未開始（或使用快照），不影響進行中的工具呼叫；
* `publish` 失敗不阻擋 turn，只寫 diagnostics。

### 5.4 併發

* 每次 mutate 遞增 `revision`；session 記錄 `expectedRevision`；
  publish 時若 revision 已變更 → 回 `stale`，下一 turn 重試（對齊 codex CAS）。

## 6. 測試計畫

* unit：diff mount/unmount、失敗 server 隔離、revision stale、進行中 turn 不換工具；
* desktop-gateway：live enable/disable/改 command → 同一 session 下一個 prompt 即生效；
* e2e（照 opencode）：toggle → prompt → 工具可用／不可用，不需重啟。

## 7. 遷移步驟

1. PR1：session MCP runtime + turn 邊界 publish（feature flag，預設走舊路徑）；
2. PR2：移除 selection 中的 `mcp.configs`，mutate 改 invalidate；
3. PR3：刪除舊的 plugins.refresh 觸發路徑與 poisoning 分支，補 e2e。

## 8. 風險

* plugin: MCP 與 direct MCP 工具命名衝突（沿用 serverName 前綴可避免）；
* 工具註冊／註銷與正在執行的工具呼叫競態（dispose 需等待 in-flight）；
* 快照一致性：publish 後要確保 system prompt 中 MCP instructions 也更新（可延後到下一 turn）。