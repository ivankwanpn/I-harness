# I-harness M34 設計：per-model 策略 + analytics + 質量防禦 + until-success 抑制

> 2026-09-03。範圍 = `docs/research/2026-09-02-compact-fourway.md` §7.3 的 M34 四件（⑦a/⑦b/⑦c/⑦d）。
> 來源：dsh（modelPolicies）、codex/grok（per-attempt analytics、per-model threshold）、grok（degenerate 下限、sticky/until-success 抑制）——五路交叉點。
> Global Constraints：零新依賴；append-only 鐵律；M33 行為向前兼容（默認值=現狀）；fail-soft 語義維持；既有測試不破（除明列更新）；每任務 commit（分支 m34）。

## 0. 四件

| # | 項 | 來源 | 級 |
|---|---|---|---|
| ⑦a | **per-model 壓縮策略**（`modelPolicies`） | dsh 形狀 + grok per-model threshold | M |
| ⑦b | **compaction analytics**（telemetry 事件） | codex/grok 埋點 | S |
| ⑦c | **摘要質量防禦**（degenerate 下限 + 單次重試） | grok | S |
| ⑦d | **until-success 強化 + sticky**（抑制語義細化） | grok 抑制狀態機 | S |

## 1. ⑦a per-model 壓縮策略

```ts
// packages/compaction/src/config.ts
export interface ModelCompactionPolicy {
  thresholdRatio?: number      // 覆蓋 0.8（grok per-model 85/80/90% 族）
  retainTokens?: number        // 覆蓋（或 retainRatio）
  maxTokens?: number           // 摘要輸出上限覆蓋
  summarizationModel?: ModelClient // 覆蓋
  auto?: boolean               // 覆蓋（per-model 關閉）
}
CompactionConfig.modelPolicies?: Record<string, ModelCompactionPolicy>  // key = "provider/model"（精確）
// 解析：resolveCompactSpec(config, provider?, modelId?) → 現有廠 default 鏈上疊加 modelPolicies[`${provider}/${modelId}`]
// validate：重複 target 報錯（fail-loud at load, dsh 同款）；nonPositive 等覆蓋沿用現有校驗
```

- 消費點：`createCompactionEngine` 建構時的 contextWindow/threshold/retain/max 解析（現 resolveConfig + resolveContextWindow 鏈）——插入「policies arm」：解析時傳入 provider/modelId（M31 已傳 profile/modelId?——engine 建構處已收 provider/modelId（deps 有 profile/modelId）——用 deps 值查 policies）
- 測試：deepseek/deepseek-v4-pro 覆蓋 0.5/retain 400 → 壓力在 50% 觸發、保留 400；未列模型 → 全局默認；重複 target 報錯

## 2. ⑦b compaction analytics

```ts
// telemetry/types.ts + emit 點（packages/compaction/src/index.ts compactOnce）
event: "compaction/attempt"  // 併入 TelemetryEventType（+manifest）
data: { sessionId?, reason: "auto"|"manual", outcome: "success"|"prune-only"|"failure"|"skipped",
        tokensBefore?: number, tokensAfter?: number, shadowed?: number, pruned?: number,
        attempts: number, durationMs }
```

- emit 點：compactOnce（成功/失敗/剪枝/跳過各路径）——telemetry 可選依賴（deps.telemetry?,不傳=零事件,M25 慣例）
- tokensBefore/After 用 `activeTokens(session)`(投影)+prune 前後(`surfaceTokensAfterPrune`)
- 測試：emit 斷言（四路 outcome）；無 telemetry 時不發

## 3. ⑦c 摘要質量防禦

- `CompactionConfig.minSummaryChars?: number = 500`（grok 下限；正整數校驗）
- `summarizeWithModel` 回傳後檢查：`trim().length < minSummaryChars` → **視為失敗**：單次重試（`compactRetries` 現有=1 語義——**即現行 retry 循環複用**：compactOnce 的 retry 目前只在壓力層;把「質量失敗」納入同一 retry——**設計**：summarizeWithModel 內做 1 次重試（若第一次質量不足）→ 仍不足 → throw（fail-soft 路徑照舊）)
- 註記：與現有「empty/解析失敗」的 fail 語義合併（不新增錯誤類型）
- 測試：mock 短摘要（100 chars）→ 重試（第二次長）→ 成功;兩次都短 → fail-soft

## 4. ⑦d until-success + sticky

- **until-success**（改造 M33 熔斷重置條件）：`consecutiveAutoCompactFailures` 計數保持；**重置僅由「一次自動壓縮成功」**（compactOnce 返回 compacted:true 或 prune-only 視為成功）——不再僅靠「新非標記事件」重置（新事件只在「故障蓄積中」不提前釋放;但「成功」定義含 prune-only）
- **sticky**（新增）：自動壓縮**成功後仍超限**（`activeTokens+overhead >= threshold`）→ 該 session 置 `stickyUntilNewContent`（不觸發 auto maybeCompact,手動 compact 照常）——釋放條件：新非標記事件 (同 re-fire guard 判據) 或手動壓縮
- 三者（re-fire guard / 3-strike breaker / sticky）狀態機文檔化於 index.ts 註釋
- 測試：成功但超限 → 下一 turn 壓力不壓（sticky）;新事件 → 釋放;3 連失敗手動成功一次 → 熔斷解除

## 5. 執行（單執行者串行,避免 M33 式雙組調和）

1. T1 ⑦a（config + 解析 arm + 校驗 + tests）
2. T2 ⑦b（telemetry 類型/事件 + emit + tests）
3. T3 ⑦c（質量下限 + tests）
4. T4 ⑦d（熔斷語義改 + sticky + tests）
（T3/T4 都在 index/core-agent——串行安全）

## 6. 最終驗證

`pnpm -r test/typecheck/e2e` + 交互：壓力感知（per-model 0.5 觸發）+ analytics 事件存在 + 已知 flake 檢查
