# M25 Engineering Wrap-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** M25 工程收尾——telemetry 出口（@i-harness/telemetry 獨立 host 事件流）+ e2e 測試層（真實進程 + mock 模型）+ M19 文件狀態收尾 + 目錄清理。通過即「前端之前後端完整」。

**Architecture:** telemetry = 獨立 sink 介面（`{onEvent}` + createTelemetry 多播，與 session log 分離）；e2e = 真實 CLI 進程（run.ts:164 mock 模型預設——零特殊處理）；文件/目錄 = 審閱更新 + 歸檔。

**Tech Stack:** TypeScript (strict), ESM, pnpm workspace, vitest, tsx (已有), @i-harness/* 既有包。

**Spec:** `docs/superpowers/specs/2026-08-28-i-harness-m25-engineering-wrapup-design.md`（本計畫從該 spec 論述；執行者兩者都讀）

## Global Constraints

- **telemetry 與 session log 分離**（agent 不可見——§8.1②）；**零衝擊**：AgentDeps.telemetry? 可選（不傳=無事件——既有測試不破）
- **e2e 用 mock 模型**（run.ts:164 `opts.model ?? createMockClient(...)` 預設——**零特殊處理**；`--model` 需 `--api-key` fail-loud——不依賴真 key）
- **sandbox e2e Windows-only**（`describe.skipIf(platform !== "win32")`）
- **不作 CI**（本地 `pnpm e2e`）
- **零新外部依賴**（tsx 已有；telemetry 用獨立介面——無吸收預設）
- **零破壞**：全 `pnpm -r test` + `pnpm -r typecheck` 不破（subagent 77 / agent-team 92 / cli 53+1）
- **Windows 優先測試主戰場**

---

### Task 1: @i-harness/telemetry — 新包（types + createTelemetry 多播 + jsonl sink）

**Files:**
- Create: `packages/telemetry/package.json`、`packages/telemetry/tsconfig.json`
- Create: `packages/telemetry/src/{types,telemetry,jsonl}.ts`
- Test: `packages/telemetry/test/telemetry.test.ts`

**Interfaces:**
- Consumes: 無（獨立包——NodeJS.WritableStream for JSONL）
- Produces: `TelemetryEventType`/`TelemetryEvent`/`TelemetrySink`/`Telemetry`/`createTelemetry`/`createJsonlSink`

- [ ] **Step 1: 建 package 骨架 + 寫失敗測試（telemetry.test.ts）**

```ts
// packages/telemetry/test/telemetry.test.ts — TDD 核心（多播 + JSONL + 錯誤隔離）
import { describe, expect, it, vi } from "vitest"
import { createTelemetry, createJsonlSink, type TelemetryEvent, type TelemetrySink } from "../src/index.ts"

it("emit multicasts to all sinks", () => {
  const a: TelemetryEvent[] = []; const b: TelemetryEvent[] = []
  const tele = createTelemetry([{ onEvent: (e) => a.push(e) }, { onEvent: (e) => b.push(e) }])
  tele.emit({ type: "turn/start", ts: 1, data: {} })
  expect(a).toHaveLength(1); expect(b).toHaveLength(1)
})

it("sink errors fail-visible (warn) without breaking others", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const good: TelemetryEvent[] = []
  const tele = createTelemetry([{ onEvent: () => { throw new Error("sink boom") } }, { onEvent: (e) => good.push(e) }])
  tele.emit({ type: "turn/start", ts: 1, data: {} })
  expect(warn).toHaveBeenCalled(); expect(good).toHaveLength(1)
})

it("jsonl sink writes one JSON line per event to the stream", () => {
  const chunks: string[] = []
  const stream = { write: (s: string) => { chunks.push(s); return true } } as NodeJS.WritableStream
  const sink = createJsonlSink(stream)
  sink.onEvent({ type: "mcp/server-status", ts: 123, data: { server: "alpha" } })
  expect(chunks).toHaveLength(1)
  expect(JSON.parse(chunks[0]!)).toMatchObject({ ts: 123, type: "mcp/server-status", data: { server: "alpha" } })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/telemetry && pnpm vitest run`
Expected: FAIL（module not found）

- [ ] **Step 3: 實作 types.ts + telemetry.ts + jsonl.ts + index.ts**

```ts
// types.ts
export type TelemetryEventType = "session/start" | "session/end" | "turn/start" | "turn/end"
  | "tool/start" | "tool/end" | "tool/error" | "provider/call" | "provider/error"
  | "token/usage" | "retry/start" | "error" | "warn" | "mcp/server-status"
export interface TelemetryEvent { type: TelemetryEventType; ts: number; data: Record<string, unknown> }
export interface TelemetrySink { onEvent(ev: TelemetryEvent): void | Promise<void> }
export interface Telemetry { emit(ev: TelemetryEvent): void; close(): void }
// telemetry.ts
export function createTelemetry(sinks: TelemetrySink[]): Telemetry {
  // emit: forEach sink → try { await onEvent } catch → console.warn (fail-visible, not interrupt)
  // close: flush sinks (no-op unless sink needs it)
  return { emit: (ev) => { for (const s of sinks) { try { void s.onEvent(ev) } catch (e) { console.warn("[telemetry] sink error:", e) } } }, close: () => {} }
}
// jsonl.ts
export function createJsonlSink(stream: NodeJS.WritableStream = process.stdout): TelemetrySink {
  return { onEvent: (ev) => { stream.write(JSON.stringify({ ts: ev.ts, type: ev.type, data: ev.data }) + "\n") } }
}
// index.ts — export { createTelemetry, createJsonlSink, type TelemetryEvent, ... }
```

- [ ] **Step 4: 跑測試確認通過 + typecheck**

Run: `cd packages/telemetry && pnpm vitest run` + `npx tsc --noEmit` + `cd /d/agent-complete/I-harness && pnpm -r typecheck` clean

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/ && git commit -m "feat(M25): @i-harness/telemetry — independent host event stream (createTelemetry multicast + JSONL sink)"
```

---

### Task 2: core-agent emit + CLI `--telemetry` flag + run.ts wire

**Files:**
- Modify: `packages/core-agent/src/index.ts`（AgentDeps.telemetry? + turn/tool/provider/token/retry emit）
- Modify: `apps/cli/src/index.ts`（`--telemetry` flag 解析）
- Modify: `apps/cli/src/run.ts`（createTelemetry + AgentDeps.telemetry + mcp onStatus 接 + session/start/end）
- Test: `apps/cli/test/cli.test.ts`（--telemetry e2e——run 用 --telemetry → stdout JSONL 行）

**Interfaces:**
- Consumes: `createTelemetry`/`createJsonlSink`（Task 1）
- Produces: `AgentDeps.telemetry?: Telemetry`（可選——不傳=無事件）

- [ ] **Step 1: 寫失敗測試（cli.test.ts）**

```ts
// cli.test.ts — --telemetry 產生 JSONL 行到 stdout
it("--telemetry writes JSONL telemetry lines to stdout", async () => {
  const res = spawnSync(process.execPath, ["--import", "tsx", entry, "run", "hello", "--telemetry"], { encoding: "utf8" })
  expect(res.status).toBe(0)
  expect(res.stdout).toContain('"type":"session/start"')  // JSONL 行
  expect(res.stdout).toContain('"type":"turn/start"')
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd apps/cli && pnpm vitest run`
Expected: FAIL（--telemetry 未解析/未 wire）

- [ ] **Step 3: 實作**

```ts
// core-agent/src/index.ts — AgentDeps 加 telemetry?
import type { Telemetry } from "@i-harness/telemetry"
export interface AgentDeps {
  // ...existing
  telemetry?: Telemetry  // M25: optional — absent = no events (backward compat)
}
// runTurn: emit turn/start + turn/end
deps.telemetry?.emit({ type: "turn/start", ts: Date.now(), data: { message } })
// ...at runTurn end: turn/end
// executeToolCalls: tool/start + tool/end + tool/error (L68 tool/result 旁)
// model.stream: provider/call + provider/error (L181 旁) + token/usage (turn 結束 checkBudget/estimateTokens 導出)
// retry/start: guard-retry / provider retry 旁（若 retryPolicy 觸發）
```

```ts
// cli/src/index.ts — --telemetry flag
const telemetryIdx = args.indexOf("--telemetry")
const telemetry = telemetryIdx !== -1 || process.env.I_HARNESS_TELEMETRY === "1"
// ...to HeadlessOptions: if (telemetry) opts.telemetry = "jsonl"
```

```ts
// cli/src/run.ts — wire
import { createTelemetry, createJsonlSink } from "@i-harness/telemetry"
// HeadlessOptions 加 telemetry?: "jsonl"
// createTelemetry + AgentDeps.telemetry + mcp onStatus 接 + session/start/end
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd apps/cli && pnpm vitest run` + `cd packages/core-agent && pnpm vitest run`（不破——telemetry 可選）+ `cd /d/agent-complete/I-harness && pnpm -r test` + `pnpm -r typecheck` clean

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/index.ts apps/cli/src/index.ts apps/cli/src/run.ts apps/cli/test/cli.test.ts && git commit -m "feat(M25): core-agent + CLI — telemetry emit (turn/tool/provider/token/retry) + --telemetry JSONL flag"
```

---

### Task 3: e2e 測試層（`e2e/` 目錄 + `pnpm e2e` script）

**Files:**
- Create: `e2e/{team,apply-patch,sandbox,workflow,skills}.e2e.ts`
- Modify: `package.json`（`"e2e": "vitest run e2e/"` script; tsx 已有）

**Interfaces:**
- Consumes: 真實 CLI（spawnSync node --import tsx）+ run.ts:164 mock 模型預設
- Produces: `pnpm e2e` script + 5 個 e2e 檔

- [ ] **Step 1: 寫 e2e（team.e2e.ts — 先例）**

```ts
// e2e/team.e2e.ts — spawnSync 真實 CLI（cli.test.ts:344 先例）
import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// NOTE: CLI 無 --workspace flag——workspace = process.cwd()（index.ts:119 硬編）。
// e2e 的 workspace 用 spawn 的 cwd（tmp dir——CLI 把 cwd 當 workspace）。
// entry 路徑：repo root 的 apps/cli/src/index.ts（--import tsx）。
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))

function runCli(args: string[], cwd: string) {
  const entry = join(REPO_ROOT, "apps/cli/src/index.ts")
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], { cwd, encoding: "utf8", timeout: 60_000 })
}

it("spawn_teammate completes a real subagent", () => {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-e2e-"))
  try {
    // workspace = ws（CLI 用 cwd）；session 存 ws/sessions（--session-dir 不傳 → 預設）
    const res = runCli(["run", "delegate a task to a teammate", "--yes", "--session-dir", join(ws, "sessions")], ws)
    expect(res.status).toBe(0)  // mock 模型預設 — 不需 API key
    // ...assert 輸出含 spawn_teammate / 完成
  } finally { rmSync(ws, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 跑 e2e 確認失敗/通過**

Run: `cd /d/agent-complete/I-harness && pnpm e2e`
Expected: 各 e2e 檔——team/apply-patch/sandbox(win32)/workflow/skills——真實進程跑通（mock 模型預設）

- [ ] **Step 3: 完成其餘 4 個 e2e 檔**（apply-patch mtime / sandbox win32-only / workflow_run + job_output / skill_get）

- [ ] **Step 4: Commit**

```bash
git add e2e/ package.json && git commit -m "feat(M25): e2e layer — real-CLI process tests (team/apply-patch/sandbox/workflow/skills) + pnpm e2e"
```

---

### Task 4: M19 文件狀態收尾 + 目錄清理

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-i-harness-m19-subagent-teams-design.md`（design→approved）
- Modify: `docs/superpowers/plans/2026-08-26-i-harness-m19-subagent-teams.md`（checkbox 勾）
- 查 M14/M15 等落後文件——同更新
- `.superpowers/sdd/` 歸檔到 `.superpowers/archive/`（gitignored）

**Interfaces:**
- Consumes: 現有 docs/superpowers + .superpowers/sdd/
- Produces: 文件狀態 updated + archive

- [ ] **Step 1: 審閱 M19 spec/plan + 更新狀態**
  （M19 實作已完成——spec status design→approved；plan checkbox 勾選；若發現實作與 spec 差異→記錄不修（spec 是歷史）或修文件——審閱時裁定）

- [ ] **Step 2: 查 M14/M15 等落後文件** + 同更新

- [ ] **Step 3: .superpowers/sdd/ 歸檔**（舊 milestone 的 review/report 移到 `.superpowers/archive/<milestone>/`——gitignored 不刪碼）

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ && git commit -m "docs(M25): M19 (and M14/M15) design/plan status → approved/complete; docs serialization"
```

---

## 驗證（全文完）

- [ ] **Step: 全 workspace 測試**

```bash
cd /d/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck && pnpm e2e
```
Expected: ALL PASS（telemetry 新 + e2e 5 個真實進程 + 全既有不破）

## 自審紀錄（M25 plan）

1. **Spec 覆蓋**：telemetry（§2.2 full）→ Task 1/2；e2e（§2.1 full）→ Task 3；文件狀態（§2.3）+ 目錄清理（§2.4）→ Task 4。全覆蓋。
2. **Placeholder 掃描**：Task 2 Step 3 的 emit 位置是「摘要」——**core-agent 的多處 emit（turn/tool/provider/token/retry）是核心實作**（plan 簡化碼概括——implementer 依 spec §2.2 完整實作）；Task 4 的審閱是「文件製」——**依 spec §2.3/2.4 執行**。**無 TBD/TODO**——但 Task 2/4 的「核心邏輯」依 spec 展開（spec 為 authority）。
3. **型別一致**：`createTelemetry`/`createJsonlSink`/`TelemetryEvent`/`AgentDeps.telemetry?`——跨 Task 1/2 一致。
4. **已知取捨**：(a) e2e mock 模型零特殊處理（run.ts:164）；(b) telemetry AgentDeps.telemetry? 可選（不傳=無——既有測試不破）；(c) Task 4 是文件製（審閱裁定——發現差異記錄不修）。
