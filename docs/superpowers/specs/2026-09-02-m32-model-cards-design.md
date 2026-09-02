# I-harness M32 設計：模型卡（上下文/輸出長度）+ 協議級思考強度

> 2026-09-02。用戶四輪裁定吸收：①「輸出長度」=模型每次最大輸出（能力卡），非請求限制——字段名 **`maxOutputTokens`**（參考 cc-custom/opencode 明確名）②思考強度**按協議**（模型不支持→其 400 上拋；不猜、不特判——DeepSeek 併入 openai-family 譯表，服務器端自映射）③`minimal` 取消（統一 6 檔）④默認 = 不發（provider 端默認；「不默認任何提供商」立場）。
> Global Constraints：零新依賴；ESM strict；Windows 優先；fail-loud（模型 400 透傳）；既有測試除明列外不破。

## 0. 範圍（四件）

1. **語義修正**：`maxTokens`（M31 誤映射 `maxContextWindow`）撤銷——卡字段 `maxOutputTokens`；請求參數 `maxTokens?`（每次限制，與卡分開）
2. **`model-catalog.json`** 數據文件（卡：`contextWindow`/`maxOutputTokens`；初始種子 DeepSeek 1M/384K + 遷入 M30 已核實 gemini/bedrock 值）+ 統一解析鏈插入（user > host modelContexts > catalog 文件 > undefined）
3. **`ReasoningEffort` 6 檔** + `LLMRequest.reasoningEffort?` + **四張協議譯表**（openai-family 共用含 DeepSeek 零特判 / anthropic / gemini / bedrock，各含世代規則）
4. **接線**：web 路徑 per-session `modelSelection.reasoningEffort`（已有存儲）→ 請求；缺省不發；CLI run 路徑透傳 host 選項同語義

## 1. 模型卡（卡數據文件）

### 1.1 結構（數據文件，非代碼）

```jsonc
// packages/provider/src/model-catalog.json
{
  "deepseek": {
    "deepseek-v4-flash":        { "contextWindow": 1048576, "maxOutputTokens": 384000 },
    "deepseek-v4-pro":          { "contextWindow": 1048576, "maxOutputTokens": 384000 },
    "deepseek-v4-flash-vision-exp": { "contextWindow": 1048576, "maxOutputTokens": 384000 }
  },
  "gemini": { /* M30 已核實值遷入：1M 系、1.5-pro 2097152… maxOutputTokens 依官方（如 65536） */ },
  "bedrock": { /* Claude 系 200k；maxOutputTokens 依官方 */ }
}
```
- **語義**：能力卡（模型文檔值）；非目錄（不影響「無默認目錄」立場——白名單式能力值）
- 更新紀律：文件可擴/可改；每次變更註記來源（模型文檔）

### 1.2 解析鏈插入（`resolveEffectiveModelContext` 擴）

```
settings userModel（最高） > profile.modelContexts[modelId] > profile.contextWindow
> model-catalog.json 值 > undefined（fail-closed）
```
- 新增 `resolveModelCard(protocolOrRoute, modelId)`：從 catalog 文件讀 `{contextWindow, maxOutputTokens}`（純查詢）
- `maxOutputTokens` 消費：①儀表/提示（可選）②請求 `maxTokens` 缺省值？（**不**——缺省不發；能力值只作顯示/校驗）③校驗：請求 maxTokens > 卡值 → fail-loud（clamp 不做——由模型管）
- **M31 修復**：`SettingsModel.maxTokens`（既有）語義定為「輸出長度」（與卡同語義），**撤 `maxTokens→maxContextWindow` 映射**（G1 誤映射）；`maxContextWindow` 保留 M15 原生語義

## 2. 思考強度（協議級）

### 2.1 統一語彙與請求面

```ts
// llm-seam
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max"
export interface LLMRequest { …; reasoningEffort?: ReasoningEffort }   // 缺省=不發
```

### 2.2 四張譯表（每適配器內 `translateReasoning`；模型不支持→原樣直發（400 上拋），不遮擋）

| IH | openai-family（Responses+Chat+DeepSeek） | anthropic | gemini | bedrock |
|---|---|---|---|---|
| off | `none` | 不傳 adaptive / legacy 不發 block | `minimal` | 不傳 thinking |
| low/medium/high | 原樣 | `output_config.effort` 原樣 | `thinkingLevel` 原樣（3.x）；2.5 → budget 表 | `reasoningConfig.maxReasoningEffort` / additionalModelRequestFields.thinking |
| xhigh/max | 原樣（max Responses 有） | 原樣 | 直發（模型 400） | 原樣 |

**世代規則（適配器內模型名小表，cc-custom 風格）**：
- anthropic：名含 `-4-6`/`-4-7`/`-4-8`（或更晚）→ adaptive + effort；否則 legacy `budget_tokens`（卡上 `budgetByEffort` 默認表 low 2048/medium 8192/high 16384——舊模型適用；**不發 effort 給 legacy**）
- gemini：`gemini-3` → thinkingLevel；`gemini-2.5` → thinkingBudget（-1 dynamic 對應 high？——**映射表**：low 4096/medium 8192/high 16384/off 0；僅依此規則）
- bedrock：`claude-4.6+`/`claude-opus-4.7+` → adaptive（effort 同上）；`nova` → 自家 effort 原樣；≤4.5 → thinkingConfig budgetTokens
- openai-family：統一 effort 字段（no 世代特判；deepseek 同表—服務器端自映射）

### 2.3 默認與接線

- 適配器 `stream()` 收到的 `LLMRequest.reasoningEffort` 缺省 → **不發**（provider 端默認；符合「不默認」）
- web per-session：`SessionModelSelection.reasoningEffort?`（M26-C5 已存）→ `buildModelFor` 路徑 → session 每次 submit 的請求？——**最小接線**：assembly 加 `reasoningEffort?`（Agent 建構 opts）→ 由 service 每 session 從 meta.modelSelection 解析傳入；`runHeadless` 同透傳
- CLI run：無 modelSelection → 不發（fail-closed 同現在）

## 3. 移除/遷移清單

- `G1` 的 `maxTokens → maxContextWindow` 映射（`web.ts effectiveProviderProfile` + `provider/mergeModelContext`）撤
- `SettingsModel.maxTokens` 語義註記改（輸出長度）
- `llm-seam`/`llm-*` 四適配器：`translateReasoning` 導入（零請求改動工具？——它們構造 body 處調用）
- `model-catalog.json` 新增；`resolveEffectiveModelContext` 加 arm（測試更新）
- docs：m31 設計 §1.3 語義修正註記（歷史）

## 4. 測試與驗證

- 卡：catalog 查詢；鏈順序（user > modelContexts > profile > catalog > undefined）
- 譯表：每適配器 `translateReasoning` 單測（wire 對象/數值斷言）+ 世代規則表測（老/新模型名 → 不同 wire）
- 集成：web per-session `modelSelection.reasoningEffort` → e2e mock 斷言請求體含 effort；缺省不發
- 400 透傳：mock stream 錯誤 → 既有 error 路徑（不新增捕獲）
- 全門：`pnpm -r test/typecheck/e2e`

## 5. 執行排序

- **T1（G1）**：語義修正 + model-catalog.json + 解析鏈 arm + 撤映射（provider/web/settings/tests）
- **T2（G2）**：ReasoningEffort 類型 + LLMRequest 字段 + 四譯表 + 世代規則（llm-seam/llm-* 五包 + tests）
- **T3（G1 內，T1 後）**：接線（assembly reasoningEffort + service per-session + runHeadless 透傳）
