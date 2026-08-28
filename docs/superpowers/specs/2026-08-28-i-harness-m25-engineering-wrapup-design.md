# I-harness M25 設計：工程收尾（e2e + telemetry + 文件狀態 + 目錄清理）

> 2026-08-28。依 M20-M25 設計檔 §8（最後一個 milestone——通過即「前端之前後端完整」）。
> 決策產出於 2026-08-28 brainstorming 對話；依「吸收而非移植」原則。

## 1. 目標與範圍

### 1.1 目標
- **M25 = 工程收尾**（非新功能）：e2e 驗證現有能力、telemetry 觀察出口、M19 文件狀態收尾、目錄清理。通過即後端完整（前端之前最後一關）。

### 1.2 範圍（四組件）
- **① e2e 測試層**（`e2e/` 目錄 + `pnpm e2e` script）——真實進程 + mock 模型（run.ts:164 預設）+ 真實工具。
- **② telemetry 出口**（`@i-harness/telemetry` 新包）——獨立 host 事件流 + `createTelemetry` 多播 + stdout JSONL sink + `--telemetry` flag。
- **③ M19 文件狀態收尾**（+ M14/M15 等落後文件審閱更新）。
- **④ 目錄清理**（docs/superpowers 序列化 + `.superpowers/sdd/` 歸檔）。

### 1.3 明確不做
- CI（§8.4——本地 `pnpm e2e`；以後有遠端 repo 再說）。
- 真 API key e2e（用 mock 模型——A 裁定；不依賴 key/費用/flaky）。
- 前端（web/tui/desktop）——明確不在本輪。
- telemetry 與 session log 分離（agent 不可見——§8.1②）。

## 2. 設計

### 2.1 ① e2e 測試層（`e2e/` 目錄 + `pnpm e2e`）

**目標**：真實進程端到端——啟動真實 headless CLI（`apps/cli`）+ mock 模型（run.ts:164 預設——**零特殊處理**）+ 真實工具（shell/fs/workflow/skills/sandbox）。

**Key finding（controller-verified）**：`apps/cli/src/run.ts:164` `const model = opts.model ?? createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])`——**無 `--model` 時 CLI 用 mock 膠帶預設**（不需 API key/模型注入）。所以 e2e 直接 `spawnSync(node --import tsx apps/cli/src/index.ts run ...)` 用預設 mock——零特殊處理。

**目錄**：`e2e/`（repo root）+ `package.json` script `"e2e": "vitest run e2e/"`（tsx 已在 root package.json:19）。

**覆蓋**（5 個 e2e 檔——各測試一個工具面）：
| 檔 | 覆蓋 | 備註 |
|---|---|---|
| `e2e/team.e2e.ts` | `spawn_teammate`（真實子代理完成） | mock 膠帶 |
| `e2e/apply-patch.e2e.ts` | 真實 `apply_patch`（M21 mtime 檢查） | 真實檔案 |
| `e2e/sandbox.e2e.ts` | Windows `--sandbox` 寫出阻擋（真實隔離） | `describe.skipIf(platform !== "win32")` |
| `e2e/workflow.e2e.ts` | `workflow_run`（真實 step） | `workflow/*.yml` 樣本 |
| `e2e/skills.e2e.ts` | `skill_get` 真實 SKILL.md | workspace 樣本 |

**進程模式**：`spawnSync(process.execPath, ["--import", "tsx", entry, "run", ...], {cwd, env})`（cli.test.ts:344 先例——真實 CLI 入口）。

**不作 CI**（§8.4）。

### 2.2 ② telemetry 出口（`@i-harness/telemetry`）

**新包結構**：
```
packages/telemetry/
  package.json
  tsconfig.json
  src/
    types.ts          (TelemetryEvent + TelemetryEventType)
    telemetry.ts      (createTelemetry + emit 多播)
    jsonl.ts          (createJsonlSink — stdout JSONL)
  test/
    telemetry.test.ts
```

**TelemetryEvent**（host 事件流——與 session log 分離，agent 不可見）：
```ts
export type TelemetryEventType =
  | "session/start" | "session/end"
  | "turn/start" | "turn/end"
  | "tool/start" | "tool/end" | "tool/error"
  | "provider/call" | "provider/error"
  | "token/usage"
  | "retry/start"
  | "error" | "warn"
  | "mcp/server-status"   // M23 事件——接 mcp-client onStatus
export interface TelemetryEvent {
  type: TelemetryEventType
  ts: number              // Date.now()
  data: Record<string, unknown>  // sessionId?, tool name/callId, provider, tokens, message...
}
```

**TelemetrySink + createTelemetry**：
```ts
export interface TelemetrySink {
  onEvent(ev: TelemetryEvent): void | Promise<void>
}
export interface Telemetry {
  emit(ev: TelemetryEvent): void          // 多播到 sinks；sink 錯誤 → fail-visible warn 不中斷
  close(): void                            // flush + 關閉 sinks
}
export function createTelemetry(sinks: TelemetrySink[]): Telemetry
export function createJsonlSink(stream?: NodeJS.WritableStream): TelemetrySink  // stdout JSONL — 每事件一行 JSON {ts, type, data}
```

**接觸點（wire）**：
- **core-agent**（`packages/core-agent/src/index.ts`）：`turn/start`（L142 旁）+ `turn/end`（runTurn 結束）+ `tool/start`/`tool/end`/`tool/error`（executeToolCalls——L68 tool/result 旁）+ `provider/call`/`provider/error`（L181 model.stream 旁）+ `token/usage`（M20 checkBudget/estimateTokens 旁——turn 結束導出）+ `retry/start`（M12 guard-retry / M20 provider retry 旁）。
- **run.ts**：`mcp/server-status`（mcp-client onStatus 接 telemetry.emit）+ `session/start`/`session/end`（run 開始/結束）。
- **core-agent 注入**：`AgentDeps.telemetry?: Telemetry` 可選（不傳 = 無事件——向後相容；既有一堆測試不破）。

**CLI flag**：`--telemetry`（啟用 stdout JSONL 出口——預設 off）；`createTelemetry([createJsonlSink(process.stdout)])` 在 run.ts 組裝；`close()` 在 run 結束。

### 2.3 ③ M19 文件狀態收尾
- M19 spec design→approved（status 更新）+ plan checkbox 勾 + ledger 清理。
- 查 M14/M15 等可能 design 狀態但已實作——同更新到 approved/complete。

### 2.4 ④ 目錄清理
- `docs/superpowers/` 三件套（spec/plan/ledger）一致化——保證每 milestone 有。
- `.superpowers/sdd/` 舊 milestone 的 review/report 檔案**歸檔**到 `.superpowers/archive/<milestone>/`（gitignored——不刪碼）。

## 3. 測試策略

### telemetry（telemetry.test.ts 全單元）
sink 收集（emit 多播）/JSONL 格式（`` {ts, type, data} `` 一行一 JSON）/sink 錯誤不中斷（fail-visible）/事件型別（session/turn/tool/provider/token/retry/mcp）。

### e2e（e2e/*.e2e.ts 5 個）
真實進程 + mock 模型（run.ts:164 預設）+ 真實工具（shell/fs/workflow/skills/sandbox）；sandbox Windows-only。

### 零破壞
全 `pnpm -r test` + `pnpm -r typecheck` 不破（telemetry 是 AgentDeps.telemetry? 可選——不傳=無事件）。

## 4. 接線（run.ts）

- `--telemetry` flag → `createTelemetry([createJsonlSink(process.stdout)])` + AgentDeps.telemetry + mcp onStatus 接。
- `pnpm e2e` script（package.json）。
- e2e 直接 spawn 真實 CLI。

## 5. 風險與取捨

- **e2e 的模型**：run.ts:164 預設 mock（無 `--model` → mock；`--model` 需 `--api-key` fail-loud）——e2e 不傳 `--model` 即 mock——零特殊處理。
- **telemetry 接觸點分散**（core-agent 多處 emit——AgentDeps.telemetry? 可選——不傳=無——既有一堆測試不破）。
- **M19 文件**：審閱後更新（若發現實作與 spec 差異→記錄不修（spec 是歷史）或修文件——審閱時裁定）。
- **dsh telemetry**：M25 telemetry 用獨立介面（sink + emit——非 dsh 代碼）；若研究發現 dsh telemetry 有對應形狀→THIRD_PARTY_NOTICES；否則無吸收（獨立設計）。
- **M23 後續 deferred**：M24b 的 driveFollowups-log-minor 等記錄在 M25 backlog（非 M25 scope——若乾淨順手補）。

## 6. 交付檔清單

- `packages/telemetry/{package.json,tsconfig.json,src/{types,telemetry,jsonl}.ts,test/telemetry.test.ts}`
- `e2e/{team,apply-patch,sandbox,workflow,skills}.e2e.ts`
- `package.json` patch（`"e2e": "vitest run e2e/"` script；tsx 已有）
- `apps/cli/src/run.ts`（telemetry wire + `--telemetry` flag）
- `packages/core-agent/src/index.ts`（AgentDeps.telemetry? + turn/tool/provider/token/retry emit）
- 文件：M19 spec/plan 狀態更新、docs 序列化、`.superpowers/sdd/` 歸檔
- `THIRD_PARTY_NOTICES`（telemetry 預設無吸收——本設計用獨立 sink 介面（`{onEvent}` + createTelemetry 多播）——**非 dsh/codex 代碼**；若 M25 研究發現 dsh telemetry 有對應形狀且吸收→補；否則不補（獨立設計））

## 7. 研究文件索引（telemetry/e2e 參考）

- telemetry：dsh telemetry（若有——packages/telemetry 或類似——M25 研究確認）；I-harness `packages/core-agent/src/index.ts`（turn/tool/provider 觸發點 L142/181/193）、`packages/core-agent/src/execute-tool-calls.ts`（tool/result L68）、`packages/provider/src/index.ts`（M20 retryPolicy L25/108）、`packages/token-meter/src/index.ts`（M20 budget/checkBudget/estimateTokens）、`packages/mcp-client/src/supervisor.ts`（onStatus L35/85——mcp/server-status 接點）、`packages/guard-retry/src/index.ts`（M12 retry）。
- e2e：`apps/cli/src/run.ts:164`（mock 模型預設——e2e 零特殊處理）、`apps/cli/test/cli.test.ts:344-348`（spawnSync 真實進程先例）、`package.json:19`（tsx）。
