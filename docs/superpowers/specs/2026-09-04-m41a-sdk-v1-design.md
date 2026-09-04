# M41a — SDK wire v1：`session/history` + `session/list` + 版本握手

日期：2026-09-04 · branch m41（自 main 出）· 源：M38b 錄案（remote replay/list 無 v0 RPC）＋ M40 取捨（#5 拆此輪）。

## 0. 目標

把 `--attach` 的兩個誠實缺口補成真功能：歷史回放與會話列表。**v0 凍結原則保持**——v1 = 只加方法（additive-only），老客戶端零破壞。

## 1. 現況（已確認）

- `PROTOCOL_VERSION = 1`（packages/sdk/src/protocol.ts:54）——凍結版號。
- 方法：`initialize`/`session/prompt`/`session/status` + 通知 `session/event`/`session/status`。
- 客戶端：@i-harness/sdk client（connect/run）+ TUI 的結構鏡像 `spawnSdkSubprocess`（wire 直接講話）。
- 服務端（sdk server）：方法 switch；session 源可注入。

## 2. v1 方法

| 方法 | 請求 | 響應 | 實現 |
|---|---|---|---|
| `session/history` | `{ sessionId, afterSeq?, limit? }` | `{ events: SessionEvent[], nextSeq }` | server 從 liveSession 的 log 走 walk（afterSeq 純增量；limit 分頁上限 500）；session 不存在 → 404 式失敗碼（-32601? 用 INVALID_PARAMS + message）+ 空列表 |
| `session/list` | `{}` | `{ sessions: [{ id, title, updatedAt, turnCount, contextUsed?, contextTotal? }] }` | 可選 `listSessions` 源（server opt；store 列出——apps/cli sdk 命令傳 coordinator 面，同 web-host）；未提供源 → `{ sessions: [] }`（誠實空白）+ `status: "listing-unavailable"` 場 |

- **版本握手**：`initialize` 的 `protocolVersion` → **2**；ServerInfo.capabilities 增加 `"session-history": ["1"], "session-list": ["1"]`。老客戶端收到的能力表忽略即可（additive）。
- **兼容**：v0 客戶端零破壞（新方法不存在於其調用面；server 對未知方法已 -32601——新方法對 v0 客戶端只會因呼叫而生效）。docs/contracts.md 補 v1 附錄。

## 3. 分組

- **G1（SDK v1）**：packages/sdk protocol+server+client（新方法 + 握手 2 + capabilities）+ 測試（握手、history 增量/分頁/無 log 404 語義、列表與 unavailable 場、老客戶端兼容——mock v0 客戶端調用仍通）+ docs/contracts.md 附錄。
- **G2（TUI remote 消費）**：packages/tui/src/backend/remote.ts——`spawnSdkSubprocess` 鏡像加兩方法；`replay()` 真走 history；`listSessions()` 真走 list（含 unavailable → []）；M38b 的「誠實缺口」註解更新；測試：真 sdk 子進程 e2e 斷言 **history/list 現在返回真數據**（先 prompt 一輪 → history(afterSeq=0) 得事件 → 列表含該 session）。
- **G3**：docs + 全量驗證 + 推送。

## 4. 驗收

- 全量 typecheck/`-r test`/e2e 綠；sdk wire freeze 文檔更新；TUI remote-backend 測試改斷言真回放/列表；`--attach` 的 replay/list 缺口從 CAPABILITIES-DETAIL §11 移出（改掛「已補」）。
