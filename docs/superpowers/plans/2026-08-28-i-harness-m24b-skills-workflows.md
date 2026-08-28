# M24b Skills-as-Plugins + Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 兩個新包——@i-harness/skills（deferred 檢索 SKILL.md + skill_search/skill_get）與 @i-harness/workflow（靜態 YAML 多步驟 + single-job 執行 + workflow_run/workflow_list）。

**Architecture:** 函數式包（tool-search/preset 先例——no class）；skills 重用 tool-search BM25；workflow 用 exec run() 逐 step 執行 + 單一 background job（workflow-N）；subagent job_* fallback 加第三層認 workflow-N；run.ts 接線（skills 在 registerToolSearch 旁、workflow 在 registerSubagent 旁）。

**Tech Stack:** TypeScript (strict), ESM, pnpm workspace, vitest, yaml (通用套件), @i-harness/* 既有包。

**Spec:** `docs/superpowers/specs/2026-08-28-i-harness-m24b-skills-workflows-design.md`（本計畫從該 spec 論述；執行者兩者都讀）

## Global Constraints

- **yaml 包**：通用套件（依使用者裁定「非零新依賴，禁私有庫」——yaml 是通用、允許新增）。skills + workflow 兩包都加 `"yaml": "^2.x"` 到 dependencies。
- **ESM + strict TS**（strict/noUnusedLocals/noUnusedParameters）
- **snake_case 工具名**（`[A-Za-z0-9_-]`、≤64）：`skill_search`/`skill_get`/`workflow_run`/`workflow_list`
- **skill name kebab** `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`、≤64（naming.ts 相容）
- **workflow name kebab**（同）——缺省=檔名 stem
- **零破坏**：subagent 73、agent-team 92、cli 51+1、全 `pnpm -r test` + `pnpm -r typecheck` 不破
- **v0 不做**：durable skill catalog、remote skills、skill 可註冊工具、workflow DAG/並行/條件、worker-thread、settlement push
- **Windows 優先測試主戰場**

---

### Task 1: @i-harness/skills — 新包（registry + 掃描 + front-matter + searchSkills + 工具面）

**Files:**
- Create: `packages/skills/package.json`、`packages/skills/tsconfig.json`
- Create: `packages/skills/src/{index,frontmatter,registry,search,tool}.ts`
- Test: `packages/skills/test/skills.test.ts`
- Modify: `THIRD_PARTY_NOTICES`（codex skills + dsh + opencode 歸屬）

**Interfaces:**
- Consumes: `@i-harness/tool-search` 的 `search()`（`packages/tool-search/src/search.ts` — `search(query, tools: Searchable[], opts?)`）、`@i-harness/core-tools` 的 `Tool`/`ToolRegistry`、`yaml` 包
- Produces: `createSkillRegistry(deps?)`, `Skill`/`SkillSummary`/`SkillRegistry`, `registerSkills(ctx, tools, { workspace })`（run.ts 用）

- [ ] **Step 1: 建 package 骨架 + 寫失敗測試（skills.test.ts）**

```ts
// packages/skills/test/skills.test.ts — TDD 核心（掃描 + front-matter + searchSkills）
import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSkillRegistry } from "../src/registry.ts"

const SKILL_MD = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# Body\nUse this skill to ${desc}.`

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-skills-"))
  mkdirSync(join(ws, "skills/alpha"), { recursive: true })
  writeFileSync(join(ws, "skills/alpha/SKILL.md"), SKILL_MD("alpha", "Alpha skill"))
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) }
}

it("scans <workspace>/skills/<name>/SKILL.md", async () => {
  const { ws, cleanup } = setupWorkspace()
  try {
    const reg = createSkillRegistry({ workspace: ws })
    const list = reg.list()
    expect(list.map((s) => s.name)).toContain("alpha")
    expect(list.find((s) => s.name === "alpha")?.description).toBe("Alpha skill")
  } finally { cleanup() }
})

it("front-matter: name defaults to dir name; description required (missing → skip)", async () => {
  const { ws, cleanup } = setupWorkspace()
  try {
    mkdirSync(join(ws, "skills/beta"), { recursive: true })
    writeFileSync(join(ws, "skills/beta/SKILL.md"), "---\ndescription: no name\n---\nbody") // name 缺省=beta
    mkdirSync(join(ws, "skills/gamma"), { recursive: true })
    writeFileSync(join(ws, "skills/gamma/SKILL.md"), "---\nname: gamma\n---\nno desc") // description 缺 → skip
    const reg = createSkillRegistry({ workspace: ws })
    const names = reg.list().map((s) => s.name)
    expect(names).toContain("beta") // 缺 name → 目錄名
    expect(names).not.toContain("gamma") // 缺 description → skip
  } finally { cleanup() }
})

it("searchSkills uses BM25 (reuses @i-harness/tool-search)", async () => {
  const { ws, cleanup } = setupWorkspace()
  try {
    const reg = createSkillRegistry({ workspace: ws })
    const hits = reg.searchSkills("alpha")
    expect(hits[0]?.name).toBe("alpha")
  } finally { cleanup() }
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/skills && pnpm vitest run`
Expected: FAIL（module not found / createSkillRegistry 不存在）

- [ ] **Step 3: 實作 frontmatter.ts**

```ts
// packages/skills/src/frontmatter.ts
import { parse } from "yaml"
export interface SkillFrontmatter { name?: string; description?: string }
export function parseFrontmatter(input: string): { meta: SkillFrontmatter; body: string } | undefined {
  // --- 段（行 trim 精確匹配）→ yaml.parse → skill.get("name")/get("description")（scalar keys only）
  // 巢狀/非 scalar value → undefined（bad skill — caller skip）
  // 未閉合/缺 --- → undefined
}
```

- [ ] **Step 4: 實作 registry.ts + search.ts + tool.ts + index.ts**

```ts
// registry.ts
export interface Skill { name: string; description: string; body: string; path: string; source: "workspace" | "global" }
export interface SkillSummary { name: string; description: string; path: string; source: Skill["source"] }
export interface SkillRegistry {
  list(): SkillSummary[]        // workspace 蓋 global；v0 rescan-per-access
  getSkill(name: string): Promise<Skill | undefined>  // 未知/非法 kebab → undefined
  searchSkills(query: string, opts?: { limit?: number }): SkillSummary[]
}
export function createSkillRegistry(deps?: { workspace?: string; globalDir?: string }): SkillRegistry {
  // scanWorkspace: <workspace>/skills/**/SKILL.md（深度≤4、hidden skip、per-skill 錯誤 warn+skip）
  // scanGlobal: ~/.i-harness/skills/**/SKILL.md（globalDir override 測試用）
  // getSkill: find summary → read file → parseFrontmatter → Skill
  // searchSkills: search(query, skills.map(toSearchable), {limit}) — toSearchable → {name, description, inputSchema: undefined, searchHint: undefined}
}
// search.ts — toSearchable + re-export
// tool.ts — skill_search + skill_get（Tool 形制；SkillToolError{code} — SKILL_INVALID_NAME/SKILL_INVALID_FRONTMATTER/SKILL_NOT_FOUND）
// index.ts — export { createSkillRegistry, registerSkills, ... }
// registerSkills(ctx, tools, { workspace }) — registry.register(skillSearchTool) + skillGetTool
```

- [ ] **Step 5: 跑測試確認通過 + typecheck**

Run: `cd packages/skills && pnpm vitest run`（全綠）+ `npx tsc --noEmit` + `cd /d/agent-complete/I-harness && pnpm -r typecheck` clean
（**pnpm install** 先——新包 + yaml dep：`cd /d/agent-complete/I-harness && pnpm install`）

- [ ] **Step 6: Commit**

```bash
git add packages/skills/ THIRD_PARTY_NOTICES && git commit -m "feat(M24b): @i-harness/skills — SKILL.md deferred retrieval (registry + front-matter + BM25 search + skill_search/skill_get)"
```

---

### Task 2: @i-harness/workflow — 新包（YAML 定義 + single-job 執行 + 工具面）

**Files:**
- Create: `packages/workflow/package.json`、`packages/workflow/tsconfig.json`
- Create: `packages/workflow/src/{index,definition,registry,runner,tool}.ts`
- Test: `packages/workflow/test/workflow.test.ts`
- Modify: `THIRD_PARTY_NOTICES`（dsh workflow 歸屬）

**Interfaces:**
- Consumes: `@i-harness/exec` 的 `ExecService`（run/runBackground/getOutput/listJobs/killJob）、`@i-harness/core-tools` 的 `Tool`、`yaml` 包
- Produces: `createWorkflowRegistry`, `runWorkflow`, `WorkflowDefinition`/`WorkflowStep`, `registerWorkflow(ctx, tools, { workspace, exec })`

- [ ] **Step 1: 建 package 骨架 + 寫失敗測試（workflow.test.ts）**

```ts
// packages/workflow/test/workflow.test.ts — TDD 核心（YAML 解析 + 執行 + single-job）
import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkflowRegistry } from "../src/registry.ts"
import { runWorkflow } from "../src/runner.ts"
import type { ExecService } from "@i-harness/exec"

const YAML = `name: release-check
description: Run build + tests
steps:
  - name: build
    command: "pnpm build"
    timeout_ms: 1000
  - name: test
    command: "pnpm test"
    on_failure: continue
`

it("scans <workspace>/workflow/*.yml", () => {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-wf-"))
  writeFileSync(join(ws, "workflow/release-check.yml"), YAML)
  try {
    const reg = createWorkflowRegistry({ workspace: ws })
    expect(reg.get("release-check")?.steps).toHaveLength(2)
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

it("runWorkflow executes steps in order via exec.run(), single workflow-N job", async () => {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-wf-"))
  const calls: string[] = []
  const exec = { run: vi.fn(async (cmd) => { calls.push(cmd.argv[0]); return { stdout: "", stderr: "", exitCode: 0, timedOut: false } }) } as unknown as ExecService
  const def = { name: "x", description: "d", steps: [{ name: "a", command: "echo a" }, { name: "b", command: "echo b" }] }
  try {
    const { jobId } = runWorkflow(def, {}, exec)
    expect(jobId).toMatch(/^workflow-\d+$/)
    await new Promise((r) => setTimeout(r, 50)) // let the async loop run
    expect(calls).toEqual(["echo a", "echo b"])
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

it("on_failure: stop (default) halts on failed step; continue skips", async () => { /* ... */ })
it("params ${param} interpolated before spawn", async () => { /* ... */ })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/workflow && pnpm vitest run`
Expected: FAIL（module not found）

- [ ] **Step 3: 實作 definition.ts + registry.ts + runner.ts + tool.ts + index.ts**

```ts
// definition.ts — WorkflowStep/WorkflowDefinition 型別 + parseWorkflowYaml(text)（yaml.parse + validate: description 必填、name kebab、steps 非空）
// registry.ts — createWorkflowRegistry({ workspace }): scan <workspace>/workflow/*.yml → list/get/reload
// runner.ts — runWorkflow(def, params, exec): { runId, jobId }
//   進度: [step i/N <name>] started/ok/failed(exit=N)/skipped 進 job 輸出流
//   逐 step: exec.run({ argv: argv(command), cwd, env, timeoutMs, abortSignal })
//   失敗: on_failure=stop → run error; continue → skip
//   retry: attempts 次 (backoff_ms)
//   single job: 註冊進 workflow registry（private Map<runId, BackgroundJobView 形>）
// tool.ts — workflow_run {name, params?, wait?} + workflow_list {}（isReadOnly）
// index.ts — export { createWorkflowRegistry, runWorkflow, registerWorkflow }
```

- [ ] **Step 4: 跑測試確認通過 + typecheck**

Run: `cd packages/workflow && pnpm vitest run` + `npx tsc --noEmit` + `cd /d/agent-complete/I-harness && pnpm -r typecheck` clean（pnpm install 先）

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/ THIRD_PARTY_NOTICES && git commit -m "feat(M24b): @i-harness/workflow — static YAML workflows (registry + single-job runner + workflow_run/workflow_list)"
```

---

### Task 3: run.ts 接線（skills + workflow）+ job_* 第三層（subagent job_output/job_list/job_kill 認 workflow-N）

**Files:**
- Modify: `apps/cli/src/run.ts`（registerSkills 在 registerToolSearch 旁 + registerWorkflow 在 registerSubagent 旁）
- Modify: `packages/subagent/src/tools.ts`（job_output/job_list/job_kill 加 workflow 第三層 fallback）
- Test: `apps/cli/test/cli.test.ts`（2 e2e——skill_search+skill_get、workflow_run+job_output）、`packages/subagent/test/tools.test.ts`（job_* workflow layer）

**Interfaces:**
- Consumes: `registerSkills`（Task 1）、`registerWorkflow`（Task 2）、subagent job_* 既有
- Produces: run.ts 接線；subagent job_* 的 workflow 第三層

- [ ] **Step 1: 寫失敗測試（cli.test.ts 2 e2e + tools.test.ts job_* layer）**

```ts
// cli.test.ts — (a) skill_search + skill_get 在真實 run 可用（setup 放 sample SKILL.md）
it("M24b skill tools work in a real run (deferred retrieval)", async () => {
  // setup workspace 含 skills/alpha/SKILL.md → runHeadless with an agent that calls
  // skill_search → skill_get → the tool result is usable (mock model returns the calls)
})
// (b) workflow_run 用既有 job_output 收尾（setup 放 sample workflow.yml）
it("M24b workflow_run returns job_id; job_output observes it", async () => { /* ... */ })
// tools.test.ts — job_output with a workflow-N id routes to the workflow registry layer
it("job_output falls back to the workflow registry for workflow-* ids", async () => { /* ... */ })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd apps/cli && pnpm vitest run` + `cd packages/subagent && pnpm vitest run test/tools.test.ts`
Expected: FAIL（skill/workflow 工具未接線 / job_* 不認 workflow-N）

- [ ] **Step 3: 實作 run.ts 接線**

```ts
// run.ts — registerToolSearch(ctx, tools) 旁:
registerSkills(ctx, tools, { workspace: opts.workspace })
// registerSubagent 旁:
registerWorkflow(ctx, tools, { workspace: opts.workspace, exec: execService })
```

- [ ] **Step 4: 實作 subagent job_* 第三層**

```ts
// packages/subagent/src/tools.ts — job_output/job_list/job_kill 加 workflow fallback
// job_output: 若 id 以 "workflow-" 前綴 → 輪詢 workflow registry（getOutput/wait）→ 回 {text, status}
// job_list: 合併 subagent + shell + workflow（kind: "workflow"）
// job_kill: 若 workflow- 前綴 → workflow registry kill
// （subagent deps 需帶 workflow registry——registerSubagent 或 run.ts 傳——**決定（controller ruling）**：
//   workflow registry 是 run-level 單例（同 execService）——傳進 SubagentToolDeps 的選項（`workflow?: WorkflowRegistry`），
//   run.ts 在 registerSubagent 前建 workflow registry 並傳入；subagent 的 job_output/job_list/job_kill 在
//   deps.workflow 存在時認 workflow-* 前綴。**低侵入**：SubagentToolDeps 加可選 workflow 欄位——不傳=現狀。）
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd apps/cli && pnpm vitest run` + `cd packages/subagent && pnpm vitest run` + `cd packages/agent-team && pnpm vitest run`（全綠——subagent 73、agent-team 92、cli 51+1 不破）+ `cd /d/agent-complete/I-harness && pnpm -r test` + `pnpm -r typecheck` clean

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/run.ts packages/subagent/src/tools.ts apps/cli/test/cli.test.ts packages/subagent/test/tools.test.ts && git commit -m "feat(M24b): wire skills + workflow tools into CLI; subagent job_* third layer (workflow-N)"
```

---

## 驗證（全文完）

- [ ] **Step: 全 workspace 測試**

```bash
cd /d/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck
```
Expected: ALL PASS（skills 新 + workflow 新 + subagent 73 + agent-team 92 + cli 51+1 + 全不破）

## 自審紀錄（M24b plan）

1. **Spec 覆蓋**：skills（3.1 full）→ Task 1；workflows（3.2 full）→ Task 2；接線（§4）+ job_*（§3.3）→ Task 3。全覆蓋。
2. **Placeholder 掃描**：Task 1 Step 4 的 registry.ts 是「核心邏輯摘要」——**實際 scanWorkspace/getSkill 是 Task 1 的核心實作**（plan 的簡化碼概括行為——implementer 依 spec §3.1 完整實作）；Task 2 Step 3 同理（runner 是 core）。**無 TBD/TODO**——但需注意 Task 1/2 的「Register 部分」是骨架——implementer 需依 spec 完整展開（spec 為 authority）。
3. **型別一致**：`createSkillRegistry`/`registerSkills`/`createWorkflowRegistry`/`runWorkflow`/`registerWorkflow`——跨 Task 1/2/3 一致。
4. **已知取捨**：(a) job_* 第三層的 workflow registry 傳遞——run.ts 建 workflow registry 傳進 registerSubagent（低侵入）；(b) skills/workflow 的 yaml 包新增（通用套件——依裁定）；(c) registerSkills/registerWorkflow 的 ctx/tools 接線與 registerToolSearch 同形。
