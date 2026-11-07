# MCP live reload：opencode 的做法與 IH 的修正方向

參考：`D:\ih_reference_project\opencode-2.2.6`。

## opencode 的做法

* `packages/core/src/mcp/pool.ts`：MCP 連線以 **pool + holders** 管理，key 由 server config、cwd、credential 等決定；
  每個 Location（session/workspace）start 時 join 既有連線、stop 時 release，最後一個 holder 離開才關閉。
* `packages/core/src/mcp/index.ts` 依 directory／session 解析當前 MCP server 清單與工具；**設定變更只影響連線池**，
  不需要重建整個 session 的 plugin selection。
* `packages/app/e2e/regression/mcp-workspace-toggle.spec.ts` 直接測 UI toggle → API `disconnect`／`connect`，
  會話不用重啟即可生效。

## IH 目前的耦合

`captureOwnedGatewaySelection` 把 `mcp.configs` 放進 selection witness；MCP 設定一改，所有 live session 的 selection
都失效，只能靠 `plugins.refresh()` 重建 plugin capabilities（mount 失敗就 poison）。這就是 save+enable 會 applyError、
需要重啟的根因。

## 建議重構（對齊 opencode）

1. **把 direct MCP 從 selection 抽離**：selection witness 不再包含 `mcp.configs`；plugin（plugin:）MCP 維持原路徑。
2. **新增 session 級 MCP registry**：每個 session 持有 `mounted: Map<name, {config, handle}>`；
   在每一次 turn 開始（或 tool list 建構時）呼叫 `mcp.active()`：
   - 新 server → `mountMcpClient` 並 `tools.register`；
   - 設定變更／移除 → `handle.dispose()`（含 process tree）＋ `tools.unregister`。
3. **refresh 不再走 selection**：`desktop/mcp/mutate` 只寫檔並更新 in-memory active 快照；下一次 turn 自然 diff。
4. **啟動失敗**：單一 server mount 失敗只影響該 server（回報 `TOOL_FAILED`／警告），不影響 session 或其它 server。

## 測試計畫

* 單元：registry diff mount/unmount、失敗 server 不影響其他工具、舊 turn 進行中不切換工具；
* desktop-gateway：live enable／disable／改 command 後，同一 session 下一個 turn 即見新工具（不需重啟）；
* e2e（照 opencode）：UI toggle → 送出 prompt → 模型可呼叫／不可呼叫對應 MCP 工具。

## 過渡方案

在動工前，UI 可先串行化 save→enable 並等待 refresh settle；但這只是遮蓋 selection 重建的成本，
無法解決 mount 失敗 poison 的問題。建議直接做 session 級 MCP registry。