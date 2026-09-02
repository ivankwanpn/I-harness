# M31 執行計劃（模型動態發現 + 窗口管理 + websearch 契約）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三件——①統一窗口解析（覆蓋鏈修復+全路徑）②discovery probe-apply + 移除硬編碼目錄 ③websearch 契約升級（零默認 provider + 信任邊界）。

**Architecture:** T1（provider 統一解析 + web effectiveProviderProfile 修）與 T3（全路徑窗口）強相連 = G1；T2（web-host probe-apply + cli 去硬編碼）與 T4（web seam 升級）獨立 = G2。T1 先於 T3；T3 直接消費 T1 導出。

**Tech Stack:** TS ESM strict、vitest、pnpm workspace、node:sqlite/node:http 既有。

**Spec:** `docs/superpowers/specs/2026-09-02-m31-models-web-design.md`
**Global Constraints:** 零新依賴；ESM strict；Windows 優先；fail-closed；不默認 provider；不硬編碼目錄（移除 GEMINI/BEDROCK_MODEL_CONTEXTS）；既有測試除明列外不破；每任務 commit（分支 m31）。

---

### Task 1 (T1): 統一窗口解析函數 + settings→provider 覆蓋鏈修復

**Files:**
- Modify: `packages/provider/src/index.ts`（+`resolveEffectiveModelContext`）、`apps/cli/src/web.ts`（`effectiveProviderProfile`）
- Test: `packages/provider/test/provider.test.ts`（+3 例）、`apps/cli/test/web.test.ts`（+1 例）

**Interfaces:**
- Produces: `resolveEffectiveModelContext({ profile, modelId, userModel? }): ProviderModelContext | undefined`（chain: userModel > modelContexts[id] > profile.contextWindow）
- Consumes: `ProviderModelContext`、`ProviderProfile`（現有）

- [ ] **Step 1: 失敗測試**

```ts
// packages/provider/test/provider.test.ts 增
it("resolveEffectiveModelContext: user overrides modelContexts overrides profile", () => {
  const profile = { name:"p", protocol:"openai-compatible", contextWindow: 128_000, modelContexts: { m1: { contextWindow: 64_000 } } } as any
  expect(resolveEffectiveModelContext({ profile, modelId:"m1", userModel:{ contextWindow: 32_000 } })?.contextWindow).toBe(32_000)
  expect(resolveEffectiveModelContext({ profile, modelId:"m1" })?.contextWindow).toBe(64_000)
  expect(resolveEffectiveModelContext({ profile, modelId:"m2" })?.contextWindow).toBe(128_000)
  expect(resolveEffectiveModelContext({ profile, modelId:"m3" })).toBeUndefined()
})
```

- [ ] **Step 2: 驗證失敗**（函數不存在）
- [ ] **Step 3: 實現**

```ts
// packages/provider/src/index.ts 新增（放在 resolveModelContext 附近）
export interface EffectiveContextInput {
  profile: ProviderProfile
  modelId: string
  userModel?: { contextWindow?: number; maxTokens?: number }
}
export function resolveEffectiveModelContext(input: EffectiveContextInput): ProviderModelContext | undefined {
  if (input.userModel?.contextWindow !== undefined) return input.userModel
  return resolveModelContext(input.profile, input.modelId)
}
// web.ts effectiveProviderProfile（152-164）改：user models 不再扁平化 id——
// 聚合 modelContexts: { [id]: { contextWindow: m.contextWindow, maxTokens: m.maxTokens } } 併入 profile
// （profile.modelContexts 與 user 聚合以 user 勝——以 resolveEffectiveModelContext 的 userModel arm 自然生效）
```

- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/provider --filter apps/cli test`**
- [ ] **Step 5: Commit** `feat(m31): unified context-window resolution + settings→profile override chain`

---

### Task 2 (T2): web-host `POST /api/llm/probe-apply` + CLI 去硬編碼

**Files:**
- Modify: `packages/web-host/src/host.ts`（+route）、`packages/web-host/src/types.ts`（+型別）、`apps/cli/src/index.ts`（刪常量）、`apps/cli/test/cli.test.ts`（369-399 更新）
- Test: `packages/web-host/test/models-routes.test.ts`（+3 例）

**Interfaces:**
- Consumes: `probeModels`（provider 現有）、`settingsStore.mutateSection("llm", …)`（現有）、`ModelDescriptor`
- Produces: `POST /api/llm/probe-apply { route, baseURL?, apiKey?, protocol? }` → `{ adopted: number, models: ModelDescriptor[], fingerprint: string, failures? }`

- [ ] **Step 1: 失敗測試**

```ts
// models-routes.test.ts 增
it("probe-apply adopts models into settings (upsert, no delete)", async () => {
  const res = await fetch(`${base}/api/llm/probe-apply`, { method:"POST", body: JSON.stringify({ route:"r1", baseURL: fakeIssuer }) })
  expect(res.status).toBe(200)
  const { adopted, models } = await res.json()
  expect(adopted).toBeGreaterThan(0)
  // settings 已含 models[i].contextWindow（探測容量）
  const sec = await settingsView("llm")
  expect(sec.providers.r1.models.find((m:any)=>m.id===models[0].id)?.contextWindow).toBe(models[0].contextWindow)
})
it("probe-apply probe failure leaves settings untouched", async () => { /* 指向壞 issuer → 400 → 斷言 mutate 未被呼叫（settings 原值）*/ })
```

- [ ] **Step 2: 驗證失敗**（route 404）
- [ ] **Step 3: 實現**（host.ts：route 位（2138-2216 probe 旁）→ probeModels（現行協議鏈）→ `upsertModels(existing, discovered)`（id 覆蓋/新增/不刪）→ `settingsStore.mutateSection` → 回 `{ adopted, models, fingerprint: sha256(route+baseURL+apiKey) }`；錯誤 → 400 並保持 settings 不寫）
- [ ] **Step 4: CLI 去硬編碼**（`apps/cli/src/index.ts`：刪 `GEMINI_MODEL_CONTEXTS`/`BEDROCK_MODEL_CONTEXTS` 常量與 `modelContexts` 傳遞；parseModel 的 gemini/bedrock 改 `models: [], modelContexts: undefined`；defaultModel 保留；cli.test 369-399 更新斷言）
- [ ] **Step 5: 驗證通過 + `pnpm --filter apps/cli --filter @i-harness/web-host test` + typecheck**
- [ ] **Step 6: Commit** `feat(m31): probe-apply (discover→adopt) + drop hardcoded model catalogs`

---

### Task 3 (T3): 全路徑窗口（service per-session + budget/compaction 接線）

**Files:**
- Modify: `apps/cli/src/web.ts`（defaultContextWindow → per-session via resolveEffectiveModelContext）、`packages/session-executor/src/service.ts`/`assembly.ts`（保留缺省 spread 語義）

**Interfaces:**
- Consumes: `resolveEffectiveModelContext`（T1）、`modelBuilder`（per-session 已拿 meta.modelSelection）
- Produces: per-session assembly 的 `contextWindow` 由「session modelSelection → settings userModel → modelContexts → profile」解析（有值傳、無值缺省=現 Behavior）

- [ ] **Step 1: 失敗測試**（web.test 或 service 測試：兩 session 選不同模型 → `get_context_remaining` 回各自窗口;斷言回 `window` 各異）
- [ ] **Step 2: 驗證失敗**
- [ ] **Step 3: 實現**（web.ts 的解析處：sessionData 建 assembly 前用 modelSelection 對應的 profile+modelId 經 §T1 函數；service.ts 的 spread 保持缺省;`AgentBudgetConfig`/compaction 的窗口在 agent 建構處從同一解析（web 路徑）取——有值才供;純 CLI run 路徑:無輸入→undefined→budget 未設（現狀語義不變——`get_context_remaining` 不註冊））
- [ ] **Step 4: 驗證通過 + typecheck**
- [ ] **Step 5: Commit** `feat(m31): per-session context-window resolution on web path; budget/compaction consume it`

---

### Task 4 (T4): websearch seam 契約升級（零默認 + 信任邊界）

**Files:**
- Modify: `packages/web/src/index.ts`（契約改 dsh 形狀）、`packages/web/src/fetch.ts`（+notice 注入）、`packages/core-tools` 或 web 工具渲染層（notice）
- Test: `packages/web/test/*`（現有改斷言 + 3 例）

**Interfaces:**
- Produces: `WebSearchRequest/WebSearchSource{url,title?,snippet?,publishedAt?}/WebSearchResult{content?,sources,truncated}`；provider 註冊同面（`registerSearchProvider(id, provider)`——保留現用命名，形狀升級；`EXTERNAL_WEB_CONTENT_NOTICE` 導出）
- Consumes: 現 `registerWeb` 語義（保持 fail-closed：無 provider → websearch 工具不註冊）

- [ ] **Step 1: 失敗測試**（新契約型別以 search 結果形狀斷言：sources 可無 title、truncated 標記於 seam 截斷時、notice 前綴出現於返回文本）
- [ ] **Step 2: 驗證失敗**
- [ ] **Step 3: 實現**（升級 types/契約;seam 截斷執行;notice: 工具渲染層注入（回傳結果包絡含 `notice` 欄位或首行——決定：**回傳 `{ notice, … }` 結構,避免污染 model 文本**）——tools 層（web 工具）將 notice 置於回傳物件)
- [ ] **Step 4: 驗證通過 + `pnpm --filter @i-harness/web test && typecheck`**
- [ ] **Step 5: Commit** `feat(m31): websearch seam contract (dsh-honest shape) + trust notice; zero default providers`

---

### 最終驗證

- [ ] `pnpm -r test` / `pnpm -r typecheck` / `pnpm e2e` 全綠
- [ ] smoke：`i-harness run`（無 model）綠；`i-harness web` + `curl /api/models/catalog`（目錄空/僅 provider 行——無硬編碼證明）；`curl -X POST /api/llm/probe-apply`（假 issuer → 錯誤不寫）
- [ ] grep：`GEMINI_MODEL_CONTEXTS|BEDROCK_MODEL_CONTEXTS` 零命中
