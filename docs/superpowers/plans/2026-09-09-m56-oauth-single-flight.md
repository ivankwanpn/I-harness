# M56：MCP OAuth Option 2 — 到期感知 + single-flight 刷新

日期：2026-09-09 · 分支 `m56`（自 `main` @ `ef89904`）
源：`docs/research/2026-09-08-m52-mcp-oauth-live-refresh.md` §4 Option 2 + §3 gap 表（G1/G4/G5）

**背景**：M53 已落 Option 1（auth-class 錯誤 → 拆世代 → supervisor 重連走 `connectWithAuth`，恢復了「刷新失敗」的可見性與恢復）。本輪補 Option 2：**到期前主動刷新**，並在 provider 的 `tokens()` 咽喉點做 **single-flight**，讓 N 個並發請求只觸發一次 refresh grant（研究報告 probe E 的敗者清 token 症狀由此從源頭收斂）。

## Global Constraints

- 工作目錄 `D:\I-harness-main\.worktrees\m56`，分支 `m56`。永不碰主 checkout 與其他 worktree。
- **不得**重實作 discovery/PKCE/refresh——一律用 SDK 既有導出（`refreshAuthorization` 等）。
- **不得**加背景刷新計時器（洩漏/unref 紀律/與 unmount 競態）。
- 每個新失敗模式**一律 fail-soft** 到既有 401 路徑（回傳舊 token，讓 Option 1 的重連接手）。
- 結果形狀/線協議/on-disk 只可加性擴展；不新增外部依賴。
- RED-first；命令環境：`pnpm` = `'/c/Program Files/nodejs/corepack' pnpm`；node 在 `C:\Program Files\nodejs`。
- 推送需用戶明確同意。

## T1：provider 的到期感知 + single-flight（`packages/mcp-client/src/oauth.ts`）

1. **到期時間**：`saveTokens(t)` 時，若 `t.expires_in` 為正數，記下 `expiresAt = Date.now() + expires_in*1000`。**持久化形狀必須讓 SDK 看到的 `OAuthTokens` 仍是合法值**（建議另存一個 store 鍵，例如 `tokens-expiry`，而非往 tokens 物件塞欄位——由實作者選並在報告說明）。
2. **discovery 狀態**：實作 SDK 的 `saveDiscoveryState`/`discoveryState` 鉤子（`auth.d.ts:153,165`），持久化 AS metadata + URL——`refreshAuthorization` 需要它（研究報告 G5）。
3. **`tokens()` 咽喉點**：當 `expiresAt - now < skew`（**skew 取 30-60s 之一並在報告寫明**）且存在 `refresh_token` 且 client info/discovery 狀態齊備 → 以**provider 級共享 promise**（single-flight）呼叫 SDK 的 `refreshAuthorization(...)`，成功則 `saveTokens` 並回傳新 token；**任何失敗**：清掉共享 promise、回傳**舊 token**（fail-soft，讓 401 路徑與 Option 1 接手）。
4. **不變**：無 `expires_in`、無 `refresh_token`、或狀態不齊 → 維持現行被動行為（不嘗試刷新）。
5. **可見性（評估後最小實作或記錄）**：評估刷新結果能否以 ≤~15 行接進既有的 `mcp/server-status` sink（`assembly.ts:371-373` 的事件入口）；能則接，不能則在報告說明原因。

## T2：用既有真 AS fixture 測（`packages/mcp-client/test/oauth-real-as.test.ts`）

fixture 的 `/token` 目前對非 code grant 一律 `unsupported_grant_type`（`:168`）——**擴充支援 `grant_type=refresh_token`**（輪換 + 拒絕兩模式），然後：
- (a) 到期前主動刷新：`expires_in` 設小 → 下一次請求前 `tokens()` 已換新；
- (b) **single-flight**：N 個並發呼叫 → fixture 端**恰好一次** refresh grant（斷言 token 端點被呼叫次數）；
- (c) fail-soft：refresh 被拒 → 回舊 token，後續仍走 401/重連路徑；
- (d) 無 `refresh_token` → 不嘗試刷新；
- (e) 無 `expires_in` → 不主動刷新（被動行為不變）。

## 驗收門（報告附真實輸出）

```powershell
pnpm --filter @i-harness/mcp-client test
pnpm --filter @i-harness/mcp-client typecheck
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/tui test
pnpm -r typecheck
pnpm e2e
```

## 提交

`feat(m56): expiry-aware single-flight OAuth refresh in the MCP provider`
