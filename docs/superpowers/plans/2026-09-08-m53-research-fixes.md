# M53：研究線修復（G1 / G4 / MCP OAuth 重連切片）

日期：2026-09-08 · 分支 `m53`（自 `main` @ `0d9bebc`）
源：`docs/research/2026-09-08-m52-rewind-cold-start.md`（G1/G4）、`docs/research/2026-09-08-m52-mcp-oauth-live-refresh.md`（Option 1）

**目的**：修掉研究線發現的兩個 rewind 缺陷（G1 為 CRITICAL，controller 已獨立複現）與 MCP OAuth 的「刷新失敗無恢復」缺口。

## Global Constraints

- 工作目錄 `D:\I-harness-main\.worktrees\m53`，分支 `m53`。永不碰主 checkout 與其他 worktree。
- 每項 RED-first（T4 文檔除外）：先寫在 pre-fix 代碼上失敗的測試。
- 結果形狀/線協議只可加性擴展；**不得**改 on-disk 或 wire 格式（G1 的 marker 已在日誌中）；不新增外部依賴。
- 命令環境：`pnpm` = `'/c/Program Files/nodejs/corepack' pnpm`；node 在 `C:\Program Files\nodejs`；探針用 `--experimental-transform-types`。`ERR_MODULE_NOT_FOUND @i-harness/tui-core` → `rm -rf apps/tui/node_modules && pnpm install`。
- 推送需用戶明確同意。

## T1 [CRITICAL] G1 — `rewind/point` 未註冊事件型別 → 做過 rewind 的 session 重啟即無法載入

- 症狀（controller 實測）：`SessionFormatUnsupportedError - unknown event type 'rewind/point' without ignorable marker`。波及 TUI resume、CLI headless、`--attach`、`session/history`、fork。
- 根因：`packages/session-persistence/src/index.ts` 的模組初始化 `registerEventType(...)` 清單缺 `"rewind/point"`（`:178-214`），而 `guardIgnorable`（`:384-395`）對未知型別且無 `ignorable` 標記者 fail-closed 拋錯。
- 修法（研究報告 §G1）：在 `:214`（`command/done` 之後）加一行 `registerEventType("rewind/point")`。**不得**改用 `ignorable: true` 寫入（研究報告 probe D2 證明那會讓 `loadOwned` 的 seq 不變式失敗）。
- 測試：
  1. 新 `packages/session-persistence/test/rewind-event.test.ts`：coordinator + jsonl 往返——enqueue 該 marker → close → 重開 → `load()` 與 `loadOwned()` 都保留它，且 `rewindCuts(session)` 解析出 `[{cutFrom, markerSeq}]`。
  2. 擴充 `packages/tui/test/rewind-bridge.test.ts` 的 durable-factory 測試：`execute(0,"all")` + `close()` 後**第三次** resume → `points()` 為 `[]`、marker 仍以 `rewind` TuiEvent 回放、被 rewind 的輪次仍隱藏。
- 驗收（手動端到端，報告附輸出）：真 TUI durable session 記錄 ≥1 個寫檔 turn → rewind → 退出 → resume → 載入成功、`points()` 反映截斷後 journal、scrollback 隱藏被 rewind 的輪次、且能再執行一次 rewind。

## T2 [LOW] G4 — `session-rewind` capability 無條件宣告

- 位置：`packages/sdk/src/server.ts:284`（initialize 的 capabilities 固定含 `"session-rewind": ["1"]`），而 `rewindFactory` 僅在 `--session-dir` 時注入（`apps/cli/src/index.ts`）。
- 症狀：無 rewind 能力的伺服器仍宣告該 capability → TUI 顯示 rewind UI 但每次 `-32603`。
- 修法：capability 行改為**有 `rewindFactory` 才宣告**（`session-rewind` 缺席 → 客戶端照既有契約不顯示）。
- 測試：`packages/sdk/test/server.test.ts` —— 無 factory 時 initialize 不含該行；有 factory 時含。

## T3 [MED] MCP OAuth — 刷新失敗無恢復（Option 1 切片）

- 現況（研究報告）：refresh_token 授權本身已活著（SDK 401 反應式刷新）；缺口是**刷新失敗後無恢復/可見性**——transport 開著、supervisor 仍 `ready`、每次呼叫 `Error: Unauthorized`、印出的授權 URL 已失效。
- 修法（Option 1）：在 `packages/mcp-client/src/client.ts` 的請求路徑對 **auth-class 錯誤**（SDK `UnauthorizedError` / `McpOAuthError`）觸發既有的 disconnect 扇出（`:138-141`）+ `await client.close()`，使 supervisor 走 `generationDown → failCycle → connect`（`supervisor.ts:216-222, 253-262`）→ `connectWithAuth`（`client.ts:81-105`）重印 URL 並等待回調。
- 硬規：
  - **只**對 SDK 的 auth 錯誤類別觸發；**絕不**對一般 5xx/網路錯誤觸發（避免拆除健康連線）。
  - 保留既有的 double-death 守衛（`supervisor.ts:216-222, 283-286`）。
  - 若 mount 未啟用 reconnect，客戶端必須把錯誤照常上浮（在報告說明）。
  - 不新增背景刷新計時器；不重實作 discovery/PKCE/refresh。
- 測試（研究報告建議）：擴充 `packages/mcp-client/test/oauth-real-as.test.ts` 的假 AS 加 `refreshMode` 開關（其 `/token` 目前對非 code grant 一律 `unsupported_grant_type`，`oauth-real-as.test.ts:168`——refresh 路徑從未被測過），斷言：會話中遭拒 → 一次 `reconnecting` 事件 → `onRedirect` 捕獲授權 URL → 取該 URL 完成回調 → 工具重新同步。另加一個 supervisor 級測試（仿 `reconnect.test.ts`）。

## T4 [文檔一行] M52 遺留

- `packages/tui/src/scrollback/engine.ts:54-57`（私有 `trimmedLineTotal` 欄位註釋）仍寫「NET … minus the single marker row」，與同檔已修正的 `trimmedLines()` 文檔（`:327-333`）矛盾。改為與 accessor 一致。

## 驗收門（報告附真實輸出）

```powershell
pnpm --filter @i-harness/session-persistence test
pnpm --filter @i-harness/session-persistence typecheck
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/sdk typecheck
pnpm --filter @i-harness/mcp-client test
pnpm --filter @i-harness/mcp-client typecheck
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui typecheck
```

## 提交

`fix(m53): register the rewind/point event type, gate the session-rewind capability, recover MCP OAuth on auth failure`
