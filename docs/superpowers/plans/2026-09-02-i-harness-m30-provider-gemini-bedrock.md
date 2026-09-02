# M30 執行計劃：新增 Gemini / Bedrock 模型 provider（first-class）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依 dsh + 現有 provider 層，把 gemini / bedrock 補成 **first-class** provider——新增 `gemini` / `bedrock` 兩個協議 + 各自一個 `llm-*` 適配包，接進 `@i-harness/provider` registry 的雙分派（`buildClient`/`buildWireClient`）、settings `PROVIDER_PROTOCOLS`、CLI 內建 profile、主流模型 `modelContexts`；`--model gemini:...` / `--model bedrock:...` 直接可用，含 `get_context_remaining` / per-session selection。

**Architecture:** 沿用現有三層——`@i-harness/llm-seam` 的 `ModelClient`（`LLMStreamEvent`）、每協議一個純 fetch adapter（`llm-openai`/`llm-anthropic` 為模板）、`@i-harness/provider` 的協議→工廠 **static switch**。Gemini 走原生 Google GenAI REST（純 fetch + `x-goog-api-key`）；Bedrock 走官方 `@aws-sdk/client-bedrock-runtime` 的 **Converse API**（SigV4 + AWS 憑證鏈由 SDK 處理，M28 已允公開庫——dsh 自身也只在第三方 SDK 內碰 bedrock）。

**Tech Stack:** TS ESM strict、vitest（TDD）、pnpm workspace、全域 fetch + `parseSSE`；新增公開依賴 `@aws-sdk/client-bedrock-runtime`（bedrock）。

**Spec:** 見下方「設計要點」（本計劃為自足執行檔；決策依據 = `docs/audit/2026-08-31-fiveway-comparison.md` §C provider 廣度、dsh `llm-deepseek`/`llm-pi-ai` 適配模式）
**Global Constraints:** M28 依賴原則修訂＝通用公開庫自由引入、私有庫禁入（本輪新增 `@aws-sdk/client-bedrock-runtime`，明示用途）；ESM strict；Windows 優先；fail-closed；既有測試不破；每任務 commit（分支 m30）；gemini/bedrock 兩邊 registry marker 與 wire 詞彙用相同字串。

## 設計要點（關鍵接線點）
I-harness 的 provider 分派有**兩個詞彙**，加 provider 兩邊都要改：
- **registry marker**：`ProviderProtocol`（`packages/provider/src/index.ts:6`），CLI/headless `buildClient`（:537-548）分派。
- **wire 詞彙**：`PROVIDER_PROTOCOLS`（`packages/settings/src/sections.ts:105`），web `buildWireClient`（provider/index.ts:582-593）+ `ProbeRequest.protocol` 使用。
- ⚠️ 既有不對稱：marker `"openai-compatible"` vs wire `"openai-completions"`（同 adapter 兩拼寫）；gemini/bedrock 兩邊用**相同字串**即可。

---

### Task 1: `packages/llm-gemini`（純 fetch，原生 Google GenAI）
- 仿 `llm-anthropic` 模板：`src/index.ts` 導出 `createGeminiClient(config: GeminiConfig): ModelClient`；`package.json`（名 `@i-harness/llm-gemini`、deps 僅 `@i-harness/llm-seam`、exports `"."→"./src/index.ts"`）。
- 施工：
  - `POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse`，`x-goog-api-key`（baseUrl 缺省 `https://generativelanguage.googleapis.com`）。
  - SSE 解析：`candidates[0].content.parts` 的 `text`→`text/chunk`、`functionCall`→`tool_call`（累積 args）；`usageMetadata`→end 前使用量；非 2xx/解析失敗/abort→`error`；終結 `end`。
  - 消息翻譯：`contents`（`role: user|model`、`parts[].text`）+ `tools`→`functionDeclarations`；tool result→`functionResponse`；`systemPrompt`→`systemInstruction`；M14 `projectImagesForTextModel` 用於無 image modality。
- [ ] 失敗測試 `test/gemini.test.ts`（`vi.stubGlobal("fetch", mock)`，`for await` 收 events 斷言順序 + 斷言 `url/headers/body`）
- [ ] 實現 → `pnpm --filter @i-harness/llm-gemini test && typecheck`
- [ ] Commit `feat(m30): llm-gemini adapter (Google GenAI REST)`

### Task 2: `packages/llm-bedrock`（官方 AWS SDK，Converse）
- 導出 `createBedrockClient(config: BedrockConfig): ModelClient`；deps：`@i-harness/llm-seam` + `@aws-sdk/client-bedrock-runtime`。
- 施工：
  - `BedrockConfig = { model, region?, profile?, options?, inputModalities? }`（不需 `apiKey`；AWS 憑證鏈 env `AWS_ACCESS_KEY_ID/SECRET/REGION`、`~/.aws/credentials`+profile、IMDS；`region` = `options.region`→`AWS_REGION`→缺省 `us-east-1`）。
  - **Converse**（`ConverseStreamCommand`/`ConverseCommand`）：messages/tools→`ConverseStreamRequest`（`messages`/`system`/`toolConfig`/`inferenceConfig`）。
  - 流式 parse：`contentBlockDelta`（`text`→`text/chunk`、`toolUse` args→`tool_call`）、`messageStop`→`end`；`messageStart` usage 作使用量。
- [ ] 失敗測試 `test/bedrock.test.ts`（注入 fake `BedrockRuntimeClient`，斷言命令參數 + 事件順序；不射真網路）
- [ ] 實現 → `pnpm --filter @i-harness/llm-bedrock test && typecheck`
- [ ] Commit `feat(m30): llm-bedrock adapter (AWS Converse)`

### Task 3: `packages/provider/src/index.ts`（registry 分派）
- [ ] `ProviderProtocol`（:6）加 `"gemini" | "bedrock"`；頂部 import 兩工廠（:1-4）
- [ ] `buildClient`（:537-548）加 `case "gemini"` / `case "bedrock"`
- [ ] `buildWireClient`（:582-593）加對應 `case`（wire 詞彙）
- [ ] `probeAuthHeaders`（:218-229）加 `"gemini"`→`{ "x-goog-api-key": key }`；`"bedrock"` v0 以靜態 catalog 兜底
- [ ] `packages/provider/package.json`（:13-19）加 `@i-harness/llm-gemini` + `@i-harness/llm-bedrock` workspace dep
- [ ] 測試 `test/provider.test.ts`（+協議分派）、`test/directory.test.ts`（probe auth）→ 驗證
- [ ] Commit `feat(m30): provider registry adds gemini/bedrock protocols`

### Task 4: `packages/settings/src/sections.ts` + CLI 內建 profile
- [ ] `PROVIDER_PROTOCOLS`（:105）加 `"gemini" | "bedrock"`
- [ ] `apps/cli/src/index.ts` `parseModel`（:40-42）加兩個 `reg.register`：`{name:"gemini", protocol:"gemini", defaultModel:"gemini-2.5-pro", modelContexts:{...}}`、`{name:"bedrock", protocol:"bedrock", defaultModel:"anthropic.claude-3-5-sonnet-20241022", modelContexts:{...}}`
- [ ] `modelContexts` 注入常見 gemini/bedrock 模型 context window
- [ ] 測試 → Commit `feat(m30): wire gemini/bedrock into settings + cli built-in profiles`

### Task 5: 依賴 + 文檔
- [ ] `pnpm install`（更新 lockfile；AWS SDK 純 JS、無原生 postinstall）
- [ ] `README.md` 包樹補 `llm-gemini`/`llm-bedrock` + CLI 例；`docs/contracts.md` provider 段落補 gemini/bedrock 協議與認證
- [ ] `docs/roadmap/2026-08-31-roadmap-E-platform.md` R-E11 註記「已於 M30 落地（用戶拍板覆蓋 M20 不新增）」
- [ ] Commit `docs(m30): gemini/bedrock provider notes + roadmap`

### 最終驗證
- [ ] `pnpm --filter @i-harness/llm-gemini test && --filter @i-harness/llm-bedrock test && --filter @i-harness/provider test` 綠
- [ ] `pnpm -r typecheck`（+ `test` + `e2e`）全綠、既有不破
- [ ] 冒煙：`run "hello" --model gemini:gemini-2.5-pro`（無 key → fail-closed/loud，證明 profile/contextWindow 解析正常）
- [ ] （選用、需真 key/AWS 憑證）真跑 `gemini:gemini-2.5-pro`、`bedrock:anthropic.claude-3-5-haiku` e2e

## 風險 / 取捨
- **Bedrock 依賴 AWS SDK**：Converse 官方樣式的代價是引入較重公開依賴。若此後要維持 IH 零 SDK 紀律，可改純 fetch + 手寫 SigV4（`node:crypto`）+ AWS 憑證鏈——成本高、易錯，暫不取，**保留為決策註記**。
- **Bedrock probe 暫缺**：probe 需 AWS 憑證（ListFoundationModels），v0 以靜態 catalog 兜底（registry 現有 `ProbeUnavailableError` 路徑）。
- **Gemini native 非 OpenAI 相容**：與 `llm-openai-compatible` 不同，`--model gemini:...` 走唯一原生協議，語意/metadata 由我們自訂（符合 first-class）。
