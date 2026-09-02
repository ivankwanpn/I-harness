# M33 執行計劃（compaction 六項吸收）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ①anchored 增量摘要 + ⑥提示結構化（G1）；②prune pass + ③計數 overhead + ④磁滯熔斷 + ⑤命令面（G2）。

**Architecture:** G1 只動 `packages/compaction/src/{summarizer.ts,index.ts}`（提示/anchored 邏輯）；G2 動 `compaction src/index/region/config`、`core-session`（prune 事件）、`core-agent`（maybeCompact 計數）`session-executor`（overhead 估算）、`apps/cli/run.ts`（命令）——**G1/G2 都碰 `compaction/src/index.ts`**（G1 的 maybeCompact? 不——anchored 在 summarizer;maybeCompact 不動。**G1 只 summarizer.ts;G2 碰 index.ts/region/config**——無交集，可平行）。

**Tech Stack:** TS ESM strict、vitest。
**Spec:** `docs/superpowers/specs/2026-09-02-m33-compaction-design.md`
**Global Constraints:** 零新依賴；append-only 永不改寫；shadow-projection 優先序；既有測試不破（`compaction-basic.spec.ts` 等以現行事件/行為為準）；每任務 commit（分支 m33）。

---

### Task 1 (G1): summarizer 重構——anchored + 8 節提示

**Files:** Modify: `packages/compaction/src/summarizer.ts`；Test: `packages/compaction/test/summarizer.test.ts`（0 現有? 有則擴）

**Interfaces:** Produces: anchored 語義（previous sum 注入 + "update" 指令）；8 節模板；敏感指令段保守規則。

- [ ] **Step 1: 失敗測試**（二輪 mock：第一輪 prompt 無 previous；第二輪 prompt 含 `<previous-summary>` + update 指令；模板 8 節關鍵詞斷言（Work State/Completed/Active/Blocked/Next Move/Sensitive Instructions）；敏感指令：shadow 區 user/message 含「請勿修改 ××」→ prompt 含原句）
- [ ] **Step 2: 驗證失敗**
- [ ] **Step 3: 實現**（summarizer.ts：`buildSummaryPrompt(shadowText, previousSummary?, instructions?)`——8 節 + previous 注入 + 敏感段規則（保守 match，原文保留）；renderShadowed 不變（shadow 文本已由 derive 提供））
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/compaction test`**
- [ ] **Step 5: Commit** `feat(m33): anchored incremental summary + structured 8-section prompt`

---

### Task 2 (G2): prune pass（`compaction/prune` 事件 + 替身投影 + 免摘要路徑）

**Files:** Modify: `packages/core-session/src/index.ts`（union + events gate 沿用 session-persistence 註冊）、`packages/core-session/src/derive.ts`（? deriveMessages 位置——核對；替身應用）、`packages/compaction/src/{index.ts,region.ts,config.ts}`（執行 + marker + config）
- [ ] **Step 1: 失敗測試**（大 tool/result 選區 → prune 後 < threshold → 只 append prune 事件 + 無摘要 spy call；keep 區大 result → 替身到模型面（deriveMessages 輸出 head/tail/…pruned…）；prune 關閉 config → 不觸發）
- [ ] **Step 2: 驗證失敗** → **Step 3: 實現**（事件型別 + 註冊（session-persistence module-init 追加, 同前），region isCompactionMarker 加 prune；deriveMessages 投影 tool/result 時查本 session 最新 prune[該 callId] → 替身；index compactIfNeeded 前置 prune 計劃→替身計數→跳摘要或替身輸入；config prune 選項）
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/core-session --filter @i-harness/compaction test`**
- [ ] **Step 5: Commit** `feat(m33): model-free prune pass (compaction/prune shadow projection)`

---

### Task 3 (G2): 計數 overhead + 磁滯 + 熔斷

**Files:** Modify: `packages/compaction/src/{config.ts,index.ts}`、`packages/core-agent/src/index.ts`（maybeCompact 計數? 現於 compaction engine——checkBudget 側 AgentBudgetConfig）、`packages/session-executor/src/assembly.ts`（overhead 估算）
- [ ] **Step 1: 失敗測試**（overhead 100k + window 200k、active 70k → 70+100 > 160(0.8) 觸發（無 overhead 時 70<160 不觸發）；磁滯：壓後 1/2 turn 不壓、3 turn 壓；熔斷：3 連失敗→第 4 壓力不壓、新事件重置）
- [ ] **Step 2: 驗證失敗** → **Step 3: 實現**（config.overheadTokens 校驗+maybeCompact 加;AgentBudgetConfig.overheadTokens;assembly 估算（沒 host 值時:sP/4 + 工具 schema/4——`approxTokens`）；磁滯 turn 計數（自最後 compaction/end 起 turn/end 數）；熔斷 WeakMap + 新內容重置）
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/compaction --filter @i-harness/core-agent --filter @i-harness/session-executor test`**
- [ ] **Step 5: Commit** `feat(m33): counting overhead + 3-turn hysteresis + 3-strike breaker`

---

### Task 4 (G2): 命令面 session-compact

**Files:** Modify: `packages/session-executor/src/assembly.ts`（SessionAssembly.compactNow? 綁 compactor）、`apps/cli/src/run.ts`（registerCommand）
- [ ] **Step 1: 失敗測試**（命令註冊：`session-compact` execute「{}」→ compactNow 被呼叫（assembly 級 mock/spy）;busy 文本（executor.isRunning true → 錯誤文本）;「No compactable history yet.」（空）
- [ ] **Step 2: 驗證失敗** → **Step 3: 實現**（assembly 暴露 compactNow（現 createCompactionEngine 已在——檢查其存在於 assembly;run.ts 命令：解析 `{instructions?}`,調 compactNow（可帶 instructions → summarizer 傳參? **v0：instructions 透傳至 compactOnce→summarizer 追加「User instructions」段**——Task1 的 prompt 已可吸收）→ 回顯 JSON）
- [ ] **Step 4: 驗證通過 + typecheck**
- [ ] **Step 5: Commit** `feat(m33): session-compact command (manual compaction surface)`

---

### 最終驗證
- [ ] `pnpm -r test` / `typecheck` / `e2e` 全綠
- [ ] 交互 smoke（mock 模型兩輪壓力：anchored prompt 斷言）由測試覆蓋；命令層 `session-compact` 回顯
