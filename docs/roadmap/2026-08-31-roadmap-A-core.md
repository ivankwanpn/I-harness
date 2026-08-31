# Roadmap A — 引擎核心（core runtime）

> 2026-08-31 · 基於 `docs/audit/2026-08-31-fiveway-comparison.md`。本區只列**候選**；每項註記「待選」——取捨記在第 6 節。

## 1. 該區現狀 vs 目標

**現狀**（IH 主線，M1–M25）：事件驅動循環、session event log + deriveMessages、compaction（shadow）、token budget、subagent 同進程駐留（阻塞 turn）、**單次 runHeadless（無並行、無輸入分級）**、靜態 systemPrompt、無修復鏈、無標題、無 plan mode、無自審批。

**目標**：從「單次 runHeadless」變成「可被驅動、可並行、可恢復、上下文會改變的 agent runtime」——五源中 dsh/codex 已達、opencode 達、IH 缺的全部核心項。

## 2. 候選里程碑表

| # | 名稱 | 一句話 | 五源來源 | 成本 | 依賴 | 建議節點 |
|---|---|---|---|---|---|---|
| R-A1 | 輸入分級與持久化 | send/followup/steer/inject + queue 分級 + 持久化收件箱 | dsh（概念）+ codex（queue 庫）/ opencode（admit/promote） | M | session-persistence、core-session | 基底（A 區第一） |
| R-A2 | 多 session 協調 | 每 session 串行、跨 session 並行的執行控制 | dsh（per-agent inbox/phase）/ codex（ThreadManager） | M | R-A1 | A1 之後 |
| R-A3 | 崩潰恢復修復鏈 | torn tail + interrupted-turn closers + 缺失 tool result 合成 | dsh（repair.ts）/ codex（backfill） | M | session-persistence | 可與 A1 並行 |
| R-A4 | 動態 system context | 變化時 append user/message 上下文快照（或 ContextUpdated 事件） | dsh（runtime-context projection）/ opencode（epoch） | M | core-session | A1 之後 |
| R-A5 | 指令載入（AGENTS.md） | 全局→逐級合併 AGENTS.md/CLAUDE.md 進 context；變更推 inbox | dsh（agent-instructions）/ codex（world_state） | S | R-A4 | 可插空做 |
| R-A6 | session 標題 | LLM 用首/全部 prompt 生成標題 | dsh（title providers）/ codex | S | llm-seam | 可插空做 |
| R-A7 | plan mode | 單一 log-only 事件 + 投影 fold + exit 工具 | dsh（logged state） | S | core-session | 可插空做 |
| R-A8 | get_context_remaining | 模型查詢剩餘上下文預算 + #context token | codex | S | token-meter | 可插空做 |
| R-A9 | 自動審批審查（guardian） | 審批前由審查子代理評審（嚴格 JSON、fail-closed、斷路器） | codex（core/src/guardian） | L | subagent、guard-approval | 架構敏感，需先定「人工 vs 自動」產品決策 |
| R-A10 | 跨 session 記憶（memories） | SQLite 記憶庫 + list/read/search 工具 | codex | L | R-A1 | 遠期候選 |
| R-A11 | 上下文滾動（rollover/new context window） | 模型可開新上下文窗 | codex（new_context_window） | M | R-A1 | 遠期（模型能力問題） |

## 3. 每項詳情

### R-A1 輸入分級與持久化 ★建議基底
- **為什麼**：現在沒有「前台/後台」語義——prompt 只有 `run(task)` 一次性；steer（當前 turn 中途插入）與 queue（閒置後排隊）是「被 UI 驅動的 agent 產品」的第一前提。
- **機制源**：dsh `core/agent/inbox.ts`（next-turn/next-step 兩隊列 + `agent/inbox/spliced` 持久事件）為概念源；opencode `session_input`（admit→promote→pending/cancel, delivery=steer|queue）為持久化參考；codex `queue_1.sqlite` 為存儲參考（durable queue + promote 順序）。
- **IH 化**：core-session 新增 input 層（事件型別 `agent/input/admitted|promoted|cancelled` + inbox spliced）；持久化經現有 coordinator（documents 或新表）；promote 規則純邏輯。
- **邊界**：steer 在 provider 邊界注入；queue 只在 idle 提升；重啟恢復 pending。

### R-A2 多 session 協調
- **為什麼**：前端/團隊都要同時跑多個 session；現在 runHeadless 一進程一 session。
- **機制源**：dsh per-agent Inbox + AbortController phase；codex ThreadManager + LRU residency；opencode SessionRunCoordinator(每 session 串行、跨 session 並行)。
- **IH 化**：把「agent 循環」從 runHeadless 拆成可重複實例化的 SessionExecutor（service 上註冊 registry），每 session 一個串行協調器。

### R-A3 崩潰恢復修復鏈
- **機制源**：dsh `core/session/src/repair.ts`（interruptedTurnClosers 合成 closers + missing tool error）；codex JSONL→SQLite backfill（啟動掃描、可重建）。
- **IH 化**：session-persistence 載入時檢查打開的 turn → 合成 `agent/error`？ 或閉合 marker，與現有 torn-tail 修補共鏈。

### R-A4 動態 system context
- **機制源**：dsh `core/agent-loop/src/runtime-context.ts`（渲染變化時 append user/message snapshot `form:snapshot` + named sections，投影狀態過重放存活）；opencode `ContextUpdated` 持久事件 + epoch。
- **IH 化**：系統 prompt 變為「基底 + 動態區」兩段；turn 前渲染動態區、與上次快照 diff → 變更寫入 session log 作為快照訊息（模型可見、可重放）。

### R-A5 AGENTS.md 指令載入
- dsh `context/agent-instructions` 的「baseline + 文件變更推送 inbox」；codex world_state/agents_md。
- IH 化：新包掃描 workspace 向上/全局，併入 R-A4 動態區；變更檢測可後補。

### R-A6 session 標題
- dsh `session-title-*`（first-prompt/all-prompts LLM providers + fold fallback）；codex thread titles。
- IH 化：title 投影 + llm 包接 seam；存 coordinator documents。

### R-A7 plan mode
- dsh `plan/plan-mode`：單一 `plan/mode` log-only 事件、投影 fold、`exit_plan_mode` 工具 + `plan/policy` prompt 段 +「review approval question」。
- IH 化：極小（一個事件型別 + 投影 + 一個工具）。

### R-A8 get_context_remaining
- codex 工具：回傳剩餘預算 + `#context` 特殊 token 佔位提示。
- IH 化：token-meter 已有 estimate；加一個模型工具即可。

### R-A9 自動審批審查（guardian）
- codex：`approvals_reviewer: auto_review` → 專用審查子代理（獨立 thread/rollout、`guardian:{parent}` prompt cache、嚴格 JSON 契約、90s fail-closed、拒絕斷路器 3/10、審批策略注入）。
- IH 化：在 guard-approval 加一台「reviewer」——用現有 subagent 設施啟動審查子代理，產出 allow/deny/approve + rationale；超時/解析失敗一律 deny（fail-closed）；介入點在 approval 決策前。
- **為什麼你要挑**：只有無人值守/CI 場景才值得 L 成本；有人值守時「人工審批」已成立。這是產品姿態決策。

### R-A10 memories（遠期）
- codex `memories_1.sqlite` 四工具（list/read/search/add_ad_hoc_note）。
- 概念好，但「記憶進模型 prompt 的產品型態」尚未定義 → 遠期。

### R-A11 上下文滾動（遠期）
- codex `new_context_window`（多窗模型）；依賴模型能力支持 → 遠期。

## 4. 排序建議（依賴優先）

1. R-A1（基底）→ R-A2 → R-A4（A5 併入）→ R-A3、R-A6、R-A7、R-A8（可插空、互不依賴）
2. R-A9（單獨箭頭：先決策再動工）
3. R-A10、R-A11 遠期

## 5. 依賴交叉

- R-A1 是 **C 區（服務面）的前置**、D 區（durable 任務通知）的基礎。
- R-A2 影響 C 區的 session 操作面設計。
- R-A4 影響 B 區 skills/工具注入（R-B6）。
- R-A9 依賴 R-A1/A2 的「session 執行器」可複用（審查子代理 = 普通子代理）。

## 6. 取捨紀錄（待填）

| # | 決策（M26 立即 / 後補 / 不做） | 註記 |
|---|---|---|
| R-A1 | **M26 立即** | 基底；與 A2 同批，C/D 區共同前提 |
| R-A2 | **M26 立即** | 與 A1 同批 |
| R-A3 | 後補 | 待 A1 持久化輸入到位後一起做 |
| R-A4 | **M26 立即** | 變化寫入 session log 快照；A5 併入 |
| R-A5 | **M26 立即** | 快贏組 |
| R-A6 | **M26 立即** | 快贏組 |
| R-A7 | **M26 立即** | 快贏組 |
| R-A8 | 後補 | 快贏組中未選（可插空再補） |
| R-A9 | **M26 立即** | guardian：自動審批審查，fail-closed；依賴 A1/A2 執行器 |
| R-A10 | 遠期 | product 形式未定 |
| R-A11 | 遠期 | 依賴模型多窗能力 |
