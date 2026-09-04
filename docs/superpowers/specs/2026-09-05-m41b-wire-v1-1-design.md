# M41b — Wire v1.1 附錄：`session/cancel` + `session/rewind/*` + list 行豐富 + DA1

日期：2026-09-05 · branch m41b（自 main（含 m43）出）· 源：M41a 方法延續（additive-only）+ 盤點 §11 剩餘。web/desktop 面**很晚再做**（用戶 2026-09-05）——不入任何近期輪。

## 0. 目標

把 `--attach` 遠程面的跟剩兩缺口閉合：**cancel**（曾以誠實 system note 替代）+ **rewind**（遠程未接）；並豐富 `session/list` 行。全部 **additive**（protocolVersion 保持 2——新能力走 capabilities 行）。

## 1. Wire 擴展（packages/sdk）

| 方法 | 請求 | 響應 | 語義 |
|---|---|---|---|
| `session/cancel` | `{ sessionId }` | `{ cancelled: boolean; reason?: "not-running" \| "not-found" }` | 服務端持有每 session 的 in-flight AbortSignal（`session/prompt` 建）→ abort；`cancelled:false` 誠實 |
| `session/rewind/points` | `{ sessionId }` | `RewindPointsResponse`（M41 附錄型：`{ points: [{turnIndex, preview, files}] }`） | assembly.rewind 直調 |
| `session/rewind/plan` | `{ sessionId, target, mode }` | `{ clean, conflicts, unTracked, ops }` | 同上 |
| `session/rewind/execute` | `{ sessionId, target, mode }` | `{ revertedFiles, conflicts, error? }` | 同上 + appendEvent → 服務端落 session log（同 embedded） |

- capabilities 行：`"session-cancel": ["1"], "session-rewind": ["1"]`；不 bump protocolVersion（v1 加性=仍在 2；文檔標註「v1.1 附錄，協議版本不變」）。
- 服務端接線：sdk server 的 session 源（service/assembly）需暴露 rewind + 每 session 的 signal 槽——讀 server.ts 現狀，最小侵入（server 已有 sessionId 狀態）；rewind 執行經 assembly.rewind（M42 已有）+ 事件落 log（append）——與 embedded 相同 append 路。
- 客戶端：HarnessClient + 結構鏡像（TUI remote）雙側。
- **list 行豐富**（apps/cli listSessions 源）：profile() 頭行 → 補 `updatedAt`（meta.createdAt）+ `turnCount`（`count()`/log 統計——唯讀）；context 字段保持可選。

## 2. TUI 側

- remote.ts：`cancel()` 真走 wire（能力行 gated：`session-cancel` 在 → wire；否則維持 system note 降級）；`rewind` 成員走 wire（`session-rewind` gated；absent → 仍無 rewind 面（老 server 誠實））。
- tui-core probe：**DA1 主動查詢**（`\x1b[c`）+ `\x1b[?1;2;...c` 解析 → brand hints（WT via DA2 95 已有——DA1 補充 xterm 族）；500ms 框架內。

## 3. 分組

- **G1（sdk/server/client + CLI 豐富）**：4 方法 + signal 槽 + capabilities + HarnessClient/鏡像側（若有）+ apps/cli list 豐富 + tests（真子進程 e2e：cancel 真中斷 mock turn、rewind round-trip、list 行含 updatedAt/turnCount）。
- **G2（tui remote + probe DA1）**：remote 消費（cancel wire / rewind 成員 gated）+ 能力偵測（握手 capabilities 而非 protocolVersion 判斷）+ DA1 查詢/解析 + 單測（能力降級路徑、DA1 mock 應答）。
- **G3**：docs（contracts.md v1.1 附錄 + README/CAPABILITIES 行 + §11 缺口全闔 + web/desktop 很晚再做的記錄）+ 全量。

## 4. 驗收

- 全量 typecheck/`-r test`/e2e 綠；capabilities 降級路徑測試綠；§11 剩餘項（cancel/rewind/list 豐富/DA1/文檔計數）全闔。
