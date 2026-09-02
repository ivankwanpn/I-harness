# M34 執行計劃（per-model 策略 / analytics / 質量防禦 / until-success）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四件：⑦a per-model 壓縮策略、⑦b compaction analytics、⑦c 摘要質量下限、⑦d until-success+sticky。

**Architecture:** 單執行者串行（T1→T4）——全部密接 `packages/compaction/src/{config,index,summarizer}.ts` + `telemetry`，串行避免交叉調和。

**Tech Stack:** TS ESM strict、vitest。
**Spec:** `docs/superpowers/specs/2026-09-03-m34-compaction-policy-design.md`
**Global Constraints:** 零新依賴；append-only；默認=現狀行為（向前兼容）；fail-soft 維持；每任務 commit（分支 m34）。

---

### Task 1 (⑦a): per-model 壓縮策略（modelPolicies）

**Files:** Modify: `packages/compaction/src/config.ts`、`packages/compaction/src/index.ts`（引擎解析 arm）
**Test:** `packages/compaction/test/config.test.ts`（或既有 spec +3 例）

**Interfaces:** Produces: `ModelCompactionPolicy`；`CompactionConfig.modelPolicies?: Record<"provider/model", ModelCompactionPolicy>`；解析整合（`resolveEffectiveSpec` 類：global 鏈 + policies arm）

- [ ] **Step 1: 失敗測試**（`modelPolicies: {"deepseek/deepseek-v4-pro": {thresholdRatio: 0.5, retainTokens: 400}}` + 建構引擎(deps.provider="deepseek", deps.modelId="deepseek-v4-pro") → pressure 觸發於 50%、保留 400；`"deepseek/deepseek-v4-flash"` 未列 → 全局 0.8/0.16；重複 key → throw；非正整數覆蓋 → throw）
- [ ] **Step 2: 驗證失敗** → **Step 3: 實現**（config：型別+驗證+`resolveEffectiveSpec(config, provider?, modelId?)`（defaults→policies 覆蓋→現 resolveConfig/resolveContextWindow 整合）；引擎建構：若 deps.provider+modelId 存在 → 用 resolveEffectiveSpec 取代單一 resolveConfig 產物；contextWindow 鏈不變）
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/compaction test`**
- [ ] **Step 5: Commit** `feat(m34): per-model compaction policies (dsh/grok shape)`

---

### Task 2 (⑦b): compaction analytics

**Files:** Modify: `packages/telemetry/src/types.ts`（`+ "compaction/attempt"`）、`packages/telemetry/src/manifest.ts`、`packages/compaction/src/index.ts`（emit 點,可選 deps.telemetry）
**Test:** `packages/compaction/test/analytics.test.ts`（+1 新）

**Interfaces:** Consumes: `Telemetry`（deps.telemetry?,M25 慣例——可選）；`activeTokens`/`surfaceTokensAfterPrune`

- [ ] **Step 1: 失敗測試**（四種 outcome：success（摘要）、prune-only、failure（summarizer 拋）、skipped（無可壓縮）→ emit 事件含 reason/tokensBefore/After/attempts；無 telemetry deps → 零 emit（spy 不存在））
- [ ] **Step 2: 驗證失敗** → **Step 3: 實現**（types/manifest 加碼；compactOnce 各路徑 emit（before 於選區計數、after 於 append 後；durationMs 以 Date.now 差））
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/compaction --filter @i-harness/telemetry test`**
- [ ] **Step 5: Commit** `feat(m34): compaction analytics telemetry event`

---

### Task 3 (⑦c): 摘要質量下限

**Files:** Modify: `packages/compaction/src/{config.ts,summarizer.ts}`
**Test:** `packages/compaction/test/summarizer.test.ts`（+2）

**Interfaces:** `CompactionConfig.minSummaryChars?: number = 500`（正整數）；質量檢查於 summarizeWithModel 內、失敗→重試 1 次→仍失敗 throw（fail-soft 現路徑）

- [ ] **Step 1: 失敗測試**（mock 第一次 100 chars → 第二次 2000 → 成功（兩次調用 spy）；兩次都 100 → throw → 現 fail-soft warn 路徑;等於/超 500 → 不重試直接通過）
- [ ] **Step 2: 驗證失敗** → **Step 3: 實現**（summarizeWithModel：生成後 `if (trimmed.length < minSummaryChars)` → 1 次重試（同模型的第二次調用）→ 仍短 → 原 throw;maxTokens 與 500 下限的關係文件化——maxTokens 需 > ~500 才有意義（註記））
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/compaction test`**
- [ ] **Step 5: Commit** `feat(m34): summary degenerate-floor (500 chars) with one retry`

---

### Task 4 (⑦d): until-success + sticky

**Files:** Modify: `packages/compaction/src/index.ts`（breaker 重置條件 + sticky 狀態）、`packages/compaction/src/config.ts`（`sticky?: boolean = true`? 否——設計 sticky 無開關,作為再防護;僅文檔化）——無 config 開關
**Test:** `packages/compaction/test/engine.test.ts`（+3）

**Interfaces:** 狀態機（re-fire guard / 3-strike / sticky）:sticky 判定 = 自動壓成功（含 prune-only）後 `tokensWithOverhead >= threshold` → `stickyUntilNewSeq`（釋放：新非標記事件 / 手動 compact 成功）;breaker 重置 = 一次自動成功（不再僅新事件）

- [ ] **Step 1: 失敗測試**（①成功但壓後仍超限 → 下一 turn 壓力閾值內不壓（sticky）;手動 compact 後釋放 ②新事件釋放 sticky ③3 連失敗 → 手動/自動成功一次 → breaker 解除（此後壓力正常壓）④（回歸）既存 re-fire guard 行者：minTurns=0 時壓後無新事件不壓——保持）
- [ ] **Step 2: 驗證失敗** → **Step 3: 實現**（index：`stickyFromSeq?: number` per-session WeakMap;複用新非標記事件判據（hasNonMarkerEventsAfter 提取為共用輔助）;breaker 重置語義改（autoSuccess 计数器））
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/compaction test && pnpm -r typecheck`**
- [ ] **Step 5: Commit** `feat(m34): until-success breaker + sticky suppression`

---

### 最終驗證
- [ ] `pnpm -r test` / `pnpm -r typecheck` / `pnpm e2e` 全綠
- [ ] smoke：per-model 策略以「實際 web 路徑壓力行為」驗證由測試覆蓋;analytics 事件存在（cli mock run + grep telemetry? 簡略）
