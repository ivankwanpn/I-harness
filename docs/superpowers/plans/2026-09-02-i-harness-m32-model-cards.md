# M32 執行計劃（模型卡 + 協議級思考強度）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模型卡（`contextWindow`/`maxOutputTokens` 數據文件 + 解析鏈）+ 思考強度（6 檔 × 4 協議譯表 + 接線），語義修正（maxTokens 誤映射撤銷）。

**Architecture:** T1（語義修正+卡文件+鏈）→ T3（接線）= G1；T2（譯表）= G2（依賴 T1 的 `ReasoningEffort` 類型只屬 llm-seam 新代碼——兩組文件交集極少：`llm-seam/src/index.ts` 兩組都碰（T1 無、T2 有 ReasoningEffort；T1 只 provider/web/settings）——**安全**）。

**Tech Stack:** TS ESM strict、vitest、pnpm workspace。
**Spec:** `docs/superpowers/specs/2026-09-02-m32-model-cards-design.md`
**Global Constraints:** 零新依賴；fail-loud（模型 400 透傳，不捕獲不降級）；缺省不發默認；既有測試除明列外不破；每任務 commit（分支 m32）。

---

### Task 1 (T1): 語義修正 + model-catalog.json + 解析鏈 arm

**Files:**
- Create: `packages/provider/src/model-catalog.json`
- Modify: `packages/provider/src/index.ts`（+`resolveModelCard`+`CARD` 載入、`resolveEffectiveModelContext` 加 arm、撤 `maxTokens→maxContextWindow` 映射：`mergeModelContext` 與 `web.ts effectiveProviderProfile`）、`packages/settings/src/index.ts`（`maxTokens` 註記語義=輸出長度）、`packages/web-host`（若類型引 us）
- Test: `packages/provider/test/*`（chain +3）、`apps/cli/test/web.test.ts`（-映射断言改）

**Interfaces:**
- Produces: `resolveModelCard(route: string, modelId: string): { contextWindow?: number; maxOutputTokens?: number } | undefined`；chain: userModel > modelContexts > profile > CARD > undefined

- [x] **Step 1: 失敗測試**（provider.test：`resolveEffectiveModelContext` 經 catalog 檔回 1M/384K；user 覆蓋回 user；無卡→undefined；`maxTokens` 不再映射 maxContextWindow——已撤斷言）
- [x] **Step 2: 驗證失敗**
- [x] **Step 3: 實現**（catalog json（種子：deepseek 三模型 1M/384000；gemini/bedrock M30 核實值——maxOutputTokens 依官方：gemini 65536、bedrock Claude 系按官（claude-3-5-sonnet 8192 輸出? 以文檔值填並註記來源））；`resolveModelCard` 純查詢；`resolveEffectiveModelContext` 末臂 CARD；撤映射（`mergeModelContext` 中 maxTokens→maxContextWindow 行刪 + web.ts effectiveProviderProfile 對應分支刪；SettingsModel.maxTokens 註記）
- [x] **Step 4: 驗證通過 + `pnpm --filter @i-harness/provider --filter apps/cli test`**
- [x] **Step 5: Commit** `feat(m32): model-catalog.json + resolution-chain arm; undo maxTokens→maxContextWindow mapping`

---

### Task 2 (T2): ReasoningEffort 六檔 + 四譯表 + 世代規則

**Files:**
- Modify: `packages/llm-seam/src/index.ts`（`ReasoningEffort` + `LLMRequest.reasoningEffort?`）
- Modify: `packages/llm-openai/src/index.ts`、`packages/llm-openai-compatible/src/index.ts`（共用譯表——openai-family：effort 直通；off→none）、`packages/llm-anthropic/src/index.ts`（adaptive/legacy 世代規則）、`packages/llm-gemini/src/index.ts`（3.x level / 2.5 budget 規則）、`packages/llm-bedrock/src/index.ts`（adaptive reasoningConfig / ≤4.5 thinkingConfig budget / nova）——每適配器 body 構建處調 `translateReasoning`
- Test: 各適配器 `test/*`（+translate 斷言；世代表測；off 分支；缺省=不發字段斷言）

**Interfaces:**
- Consumes: `ReasoningEffort`（llm-seam）
- Produces: 各適配器 `translateReasoning(model, effort?): { …wire fields } | undefined`（export for tests）

- [ ] **Step 1: 失敗測試**（anthropic：`claude-sonnet-4-6` + high → `thinking:{type:"adaptive"}` + output_config effort high；`claude-opus-4.8` + max → max；`claude-3-5` + high → 不發 effort、budget_tokens 表查 16384；off → 不傳 thinking；缺省→無 thinking 字段）
- [ ] **Step 2: 驗證失敗**
- [ ] **Step 3: 實現**（四譯表照 spec §2.2/世代規則；deepseek = openai-family 同一函數——零特判）
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/llm-seam --filter @i-harness/llm-openai --filter @i-harness/llm-openai-compatible --filter @i-harness/llm-anthropic --filter @i-harness/llm-gemini --filter @i-harness/llm-bedrock test`**
- [ ] **Step 5: Commit** `feat(m32): reasoning effort — 6-level vocab + 4 protocol translation tables`

---

### Task 3 (T3): 接線（web per-session / assembly / runHeadless）

**Files:**
- Modify: `packages/session-executor/src/assembly.ts`（AssemblyOptions.reasoningEffort? → Agent 建構 opts/請求閉包）、`packages/session-executor/src/service.ts`（每 session 從 meta.modelSelection.reasoningEffort 解析傳入）、`apps/cli/src/web.ts`（接線）、`apps/cli/src/run.ts`（HeadlessOptions.reasoningEffort? 透傳——host 選項）、`packages/core-agent/src/index.ts`（AgentDeps.reasoningEffort? → 每 LLMRequest 注入）
- Test: `apps/cli/test/web.test.ts`（modelSelection.effort="high" → assembly 收到；缺省無）、`packages/session-executor/test/*`

**Interfaces:**
- Consumes: `ReasoningEffort`（T2）、`SessionModelSelection.reasoningEffort`（已有）
- Produces: 請求攜帶 `reasoningEffort`；缺省 → 不發

- [x] **Step 1: 失敗測試**（web test：session meta 設 effort → e2e mock 收到 `LLMRequest.reasoningEffort === "high"`;無 meta → 接收 undefined）
- [x] **Step 2: 驗證失敗**
- [x] **Step 3: 實現**（把 effort 從 selection 一路傳到 agent 請求組裝處——core-agent 建 request 時取 deps.reasoningEffort（缺省 undefined 不設））
- [x] **Step 4: 驗證通過 + typecheck**
- [x] **Step 5: Commit** `feat(m32): wire per-session reasoning effort into requests`

---

### 最終驗證

- [x] `pnpm -r test` / `pnpm -r typecheck` / `pnpm e2e` 全綠（EXIT 0；64 projects × test/typecheck；e2e 5 files/11 tests）——G1 T1+T3 執行記錄
- [x] smoke：`grep maxTokens→maxContextWindow` 零映射（`grep "maxContextWindow.*maxTokens\|maxTokens.*maxContextWindow" packages | grep -v test`；剩餘命中僅為撤映射註記註釋）
- [x] catalog 生效：unit 斷言 deepseek 卡 1M/384000（provider.test "M32 model catalog"）
