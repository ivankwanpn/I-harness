# Roadmap D — 子代理與多智能體（subagents & teams）

> 2026-08-31 · 基於 `docs/audit/2026-08-31-fiveway-comparison.md`。候選清單，取捨記 §6。
> **背景**：主線 M3/M6/M8/M9/M19/M24a 已建成「同進程駐留 + 持久化 + resume + teams（roster/mailbox/task-board）」——五源中最完整的協同結構化。本區缺的主要是**任務協議的耐用化與背景化**（opencode/codex 的最強點）。

## 1. 該區現狀 vs 目標

**現狀**：`spawn_agent`/`wait_agent`/`list`/`send_message`/`interrupt`/`followup`/`close`/`resume` + team（roster/mailbox/task-board/activity）+ durable inbox（M9）+ resume 一致性（M24a）。**但**：spawn 阻塞父 turn；無持久任務記錄（重啟後父不知道子在做什麼）；無背景執行；無取消樹；無配額（depth 手動）。

**目標**：durable 任務協議（opencode `task_submission` 級）＋ 背景執行（父被 wake）＋ 取消樹/配額 → 即「opencode fork README 自我宣傳的領域」。

## 2. 候選里程碑表

| # | 名稱 | 一句話 | 五源來源 | 成本 | 依賴 | 建議節點 |
|---|---|---|---|---|---|---|
| R-D1 | durable 任務記錄 | `(parent,messageID,toolCallID)` 任務表 + 狀態機 + 恢復 | opencode（task_submission）/ 分支 spine | M | session-persistence（documents）、subagent | 第一優先 |
| R-D2 | 背景執行 + 父被 wake | spawn 立即返回 handle，完成時 durable 通知 → 父收件箱 | opencode（outbox + synthetic input）/ codex（非同步 6 工具） | M | R-D1、R-A1 | D1 之後 |
| R-D3 | 取消樹 + 配額 | recursive cancelTree + depth/concurrency permit | opencode / dsh（permit） | S–M | R-D1 | D2 之後 |
| R-D4 | 任務控制工具 | get_task_output（快照/等 ≤600s）+ stop_task | opencode（durable 狀態）/ 分支（job kill bridge） | S | R-D2 | D2 之後 |
| R-D5 | 外部進程子代理 | claude-code/codex/acp/獨立 harness 進程 providers | dsh（4 providers） | L | R-C4（SDK） | 遠期 |
| R-D6 | agent 身份/證明 | Ed25519 身份令牌 + 網絡證明 | codex（agent-identity/attestation） | L | — | 遠期 |

## 3. 每項詳情

### R-D1 durable 任務記錄 ★建議首選
- **為什麼**：現在子代理狀態只活在進程記憶（AgentRegistry 快照）+ coordinator 文檔；「父 turn 進行中、子正在做、進程死了」這個語義不存在。opencode 把每次任務記為 `task_submission` 行（accepted→running→completed/error/cancelled/recovery-required），**重啟後可查、可續、不重發**（exact retries 採用既有提交；衝突失敗）。
- **IH 化**：coordinator documents 擴 `task` 協議（狀態機 + 時間戳 + agent 路徑 + 結果）；持久化由 write-behind 統一；recovery 分類按 opencode（ambiguous → recovery-required 而非重發）。
- **邊界**：`recovery-required` 語義 = 不重發不丟失；與 A3 修復鏈對齊。

### R-D2 背景執行 + 父被 wake
- opencode：child 完成 → 通知 outbox 行 → 父 session 被 wake（合成 parent input）；codex：非同步 spawn（task_name handle）→ 完成經 mailbox 通知父。
- **IH 化**：現有 followup driver（M9）已有 inbox 機制——把「阻塞等待」改為「提交 + 訂閱完成事件」；父收到通知後自行決定 followup（codex 語意是 mail，opencode 是 synthetic input）。

### R-D3 取消樹 + 配額
- opencode：`cancelTree(rootSessionID)` 遞歸取消 + descendent quiescence 等待；`subagent_max_concurrency`/`subagent_depth` 配置項。
- IH 化：subagent-permit（per-project 配額）在 subagent 服務上註冊；取消走現有 interrupt 渠道 + 樹遍歷。

### R-D4 任務控制工具
- opencode `get_task_output`（1–20 個自有 task id，進程內活跳閘/持久狀態快照）+ `stop_task`；IH 分支已有 job fold + kill bridge（`jobs.ts` 投影於 subagent 快照 doc）。
- IH 化：三合一 —— 工具 + fold 投影 + kill。

### R-D5 外部進程子代理（遠期）
- dsh 的 four providers（claude-code/codex/acp/獨立 harness 子進程）為五源獨有。**價值**= 與外部 agent 生態互通；**成本**= L + ACP/SDK 前置；標記遠期。

## 4. 排序建議

1. R-D1 → R-D2 → R-D3 → R-D4（一個連貫任務——同批 M）
2. R-D5、R-D6 遠期

## 5. 依賴交叉

- R-D2 需要 A 區 R-A1（輸入接收箱/合成輸入）。
- R-D1/R-D7 需要 C 區 R-C0 決策（engine-owned 姿態簡化「進程内活 vs 持久」的邊界）。
- 主線 teams（mailbox/task-board）與 D 區任務協議**共存**：任務協議是「驅動層」，teams 是「協同層」。

## 6. 取捨紀錄（待填）

| # | 決策 | 註記 |
|---|---|---|
| R-D1 | **M26 立即** | 四件同批：一套任務協議一次落地 |
| R-D2 | **M26 立即** | 同批（依賴 R-A1 收件箱，已定 M26） |
| R-D3 | **M26 立即** | 同批 |
| R-D4 | **M26 立即** | 同批 |
| R-D5 | 遠期 | 外部進程子代理（dsh 四 providers）——維持待定 |
| R-D6 | 遠期 | agent 身份/證明——維持待定 |
