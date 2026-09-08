# M51 候選 bug 核實與修復

日期：2026-09-08 · 分支 `m51`（自 `main` @ `bea61ba`）
源：`docs/audit/2026-09-02-ih-m49-bug-hunt.md` §B（12 條 `[子代理]` 候選，作者尚未復現）

**目的**：對 12 條候選逐條判定 **REAL / NOT-REAL / DESIGN-QUESTION**，只修 REAL 的；每條結論都必須有可運行的證據（腳本或測試），不得只靠讀碼斷言。

## 候選清單

| ID | 級別 | 位置 | 主張 |
|---|---|---|---|
| T1 | MED | `packages/tui/src/minimal/commit.ts:54-61` | `pendingDelta` 在 lineCount 縮小後 cursor 卡住、靜默吞新內容（retain/rewind 縮小皆中） |
| T2 | MED | `packages/tui/src/render/markdown.ts:145-157` | `stablePrefixCount` 把流式 heading/hr/table/code-close 當 self-closed 凍結（生產路徑不走 checkpointer → 影響低） |
| P1 | MED | `apps/cli/src/web.ts:364-365` | 空 registry 時 `sessionContextWindow` 早退、跳過 user 行 → `get_context_remaining` 不註冊 |
| P2 | MED | `packages/provider-runtime/src/index.ts:232-240` × `packages/provider/src/index.ts:337-347` | `discoverModels` 拒絕無 key 閘道（如 localhost:11434） |
| P3 | MED | `packages/provider-runtime/src/index.ts:289-295` | `resolveModel` 的 catalog 門使 `--model` override 對「已配置未 discovery」的 provider 失效 |
| P4 | LOW | `packages/llm-gemini/src/index.ts:38-46, 218-226` | SSE 畸形 frame 直接 throw 而非乾淨 error event |
| B1 | MED | `packages/guard-retry/src/index.ts:99` × `packages/hooks/src/index.ts:283-301` | retry 重跑整個 `tools/execute` cascade → pre/post hooks 各跑兩次 |
| B2 | MED | `packages/core-agent/src/index.ts:273, 282` × `packages/core-session/src/index.ts:432-437, 461-467` | step 文字被投影到 tool result **之後**（正確 Anthropic 形狀是同一條 assistant(text+toolCalls)） |
| B3 | MED-LOW | `packages/core-agent/src/execute-tool-calls.ts:167-191` | abort 時已完成的 sibling 結果被丟（tool/call 無 tool/result → role 交替斷） |
| B4 | LOW-MED | `packages/session-query/src/file-backed.ts:321` | 索引把 `Date.now()` 當 FTS `time`（同 session 每列相同、無 recency 意義） |
| B5 | LOW | `packages/session-persistence/src/index.ts:447-463` | `load()` 回非 canonical（seq≠index）事件，`loadOwned()` 才正規化 → 兩者對同一 session 的 seq 不一致 |
| B6 | LOW | `packages/session-persistence/src/index.ts:477-481` | `loadOwned` 的 seq 不變式對「closed turn 但含未配對 tool/call」是難防缺口 |

## Global Constraints

- 工作目錄 `D:\I-harness-main\.worktrees\m51`，分支 `m51`。永不碰主 checkout 與其他 worktree。
- **Phase A 為唯讀核實**：不得修改工作樹、不得提交；一次性腳本寫到 OS temp 目錄並以 `node --experimental-strip-types` + 絕對路徑 import 受測代碼（或臨時測試檔跑完即刪，報告中註明）。
- 每條候選的結論必須附：可運行命令 + 實際輸出（REAL 需給出觸發輸入與錯誤結果；NOT-REAL 需說明為何觸發條件不可達）。
- Phase B 修復：RED-first（先在 pre-fix 代碼上失敗的測試）→ 最小修復 → GREEN；結果形狀只可加性擴展；不新增外部依賴。
- 命令環境：`pnpm` = `'/c/Program Files/nodejs/corepack' pnpm`；node 在 `C:\Program Files\nodejs`。`ERR_MODULE_NOT_FOUND @i-harness/tui-core` → `rm -rf apps/tui/node_modules && pnpm install`。
- 推送需用戶明確同意。

## Phase A：並行唯讀核實（3 個核實員）

- **A1（TUI）**：T1、T2
- **A2（provider/LLM）**：P1、P2、P3、P4
- **A3（後端）**：B1、B2、B3、B4、B5、B6

每位核實員輸出 `task-A<N>-triage.md`：逐條 `REAL | NOT-REAL | DESIGN-QUESTION` + 證據 + （REAL 時）最小修復方向與風險。

## Phase B：修復（依 Phase A 結果決定範圍）

只修 `REAL` 且不涉及範式取捨者；`DESIGN-QUESTION` 由 controller 裁決並記錄 Ruling。

## 收尾

`pnpm -r typecheck`、受影響包測試、`git diff --check`；推送待批准。

---

## Phase A 結果（2026-09-08）

| 候選 | 判定 | 依據 |
|---|---|---|
| T1 | **REAL** | retain 2100→1501 後 610 行只提交 11 行（吞 599）；rewind 30→11 丟 24/30 |
| T2 | **REAL（潛伏）** | 流式 heading/table 被凍結；但不可達生產（checkpointer 未導出、唯一消費者是其自身測試） |
| P1 | **REAL** | 空 registry 早退跳過 user 行（同 user 行：有 profile→65536，無 profile→undefined） |
| P2 | DESIGN-QUESTION | 已裁決：保留 key gate（放寬只會半狀態） |
| P3 | NOT-REAL | spec §3.3 要求 catalog 成員或手動錄入；有單測 |
| P4 | NOT-REAL | 拋出錯誤是 seam 既定風格，三 adapter 同構 |
| B1 | **REAL（潛伏）** | 一次 retry → pre/post hooks 各跑 2 次（兩種掛載序皆然）；但生產未掛載 hooks |
| B2 | **REAL** | 混合 step 的投影把文字排在 tool result 之後；M3 文檔的 fold 從未實現；2 個 adapter 會丟字 |
| B3 | **REAL** | abort 時已成功的 sibling 無 tool/result；下一輪同 session 產生 tool_use 無 tool_result |
| B4 | DESIGN-QUESTION | 已裁決：僅補文檔註釋（無事件時間源） |
| B5 | **REAL** | load() seq=[0,1,2,null,null,null] vs loadOwned()=[0..5]；fork 持久化非正規形；web 分頁丟修復尾巴 |
| B6 | NOT-REAL | 無生產者能造出該形狀；拋出是刻意的 fail-closed 規則（有測試釘住） |
| **F0（新，P0）** | **REAL** | `layout.ts:156-165` Fenwick 擴容損壞前綴和：幀間讀寫交替下 append 17 → lineCount=1（應 17）；controller 親自複現 |

## Phase B 分波

- **Wave 1（packages/tui）**：F0（P0）+ T1 + T2
- **Wave 2（apps/cli + guard-retry/hooks + core-agent + session-persistence）**：P1 + B1 + B3 + B5 + B4-doc
- **Wave 3（core-session + llm-anthropic + llm-openai）**：B2（投影 fold + adapter 保字）
