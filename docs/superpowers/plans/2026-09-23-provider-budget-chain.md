# M73 — 每一條離開行程的請求都帶著自己的預算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 provider 請求的**預算**（輸出上限與 context 窗口）在**每一條**出口都成立——今天有兩條出口完全沒有它：**子代理的 agent deps**（兩個建構點）與 **compaction 的摘要請求**。

**Architecture:** 沿用 M72 已經立下的規矩，把它補到缺的出口。子代理那半是**型別 + 傳遞**：host 解析出來的 binding 早就帶著兩個數字（provider-runtime 的 `SessionModelBinding`），是**型別窄化**與**讀取點**把它們丟掉的；「繼承」那條路則要沿著既有的 host 形狀（`RoleModelHost`）把 session 的數字穿到 spawn。compaction 那半是**一條既有鏈的延伸**：cap 從 `core-agent` 的 deps 傳進壓縮引擎，在**窗口已經在手**的那個位置用既有的 `clampOutputCap` 夾一次。

**Tech Stack:** TypeScript ESM · pnpm workspaces · vitest

**Spec:** `docs/superpowers/specs/2026-09-23-provider-budget-chain-design.md`（設計的權威；§1 是範圍，§2 是驗收）

## Global Constraints

- **紅先測試 ＋ 變異證明**：每一條修法都要先看到紅；實作後**把修法拿掉一次**、確認**具名的那條**測試變紅、再用 Edit 工具還原（**絕不**用 `git checkout --`，它會還原到 HEAD 而不是你的編輯），並以 `sha256sum` 確認位元組還原。
  - **突變要當預測看**：本計畫寫的是「**拿掉哪一條規則 ⇒ 哪一條測試必須紅**」。哪一行字面編輯能達到那個效果，**由你量測決定並記錄**——M72 兩個階段的字面突變預測錯了七次（其中一次物理上不可行）。若你找不到能讓它紅的突變，**那是發現，回報它**，不要換一條測試來遷就。
- **既有測試只在「它刻意斷言的正是這次要改的契約」時才改**，而且要**具名說明**、不得放鬆（`expect` 只能變嚴或等價）。
- **缺席即缺席**：沒有值就不寫那個鍵——**不得注入預設**。這是 M72 兩個階段都在守的規矩，本計畫的每一條案例都要有一條「缺席時不帶」的對照。
- **提交訊息不加任何 attribution trailer**；**不 amend**；blobs LF；檔案用 Write/Edit 工具寫。
- **每個任務只跑自己套件的測試與 typecheck**；`pnpm verify:all` **整支分支只跑一次**（收尾任務）。
- **不要動 `docs/`**（紀錄由控制器寫）。**不要動 seam 的事件聯集與 `LLMUsage` 的欄位**。
- **每一條新規則只落在一處**——本計畫唯一允許的第二份是**測試 helper**，且必須由第一份 move 過去而不是複製。

---

### Task 1: `spawnChild` 的兩條來源都交得出預算

**Files:**
- Modify: `packages/subagent/src/child.ts`（`RoleModelHost` `:110-118`；`RoleModelState` `:179-182`；讀取 `:279-287`；`createAgent` `:290-316`）
- Modify: `packages/subagent/package.json`（加 `@i-harness/token-meter`）
- Test: `packages/subagent/test/child.test.ts`

**Interfaces:**
- Consumes: `AgentDeps.maxOutputTokens`（`@i-harness/core-agent:89-91`，由 core-agent 在組請求時夾）、`AgentBudgetConfig`（同檔 `:29-38`，`contextWindow` 必填）、`clampOutputCap`（`@i-harness/llm-seam`，core-agent 內部呼叫）、`CHARS_PER_TOKEN`（`@i-harness/token-meter`）
- Produces: `SpawnOptions.contextWindow?: number`、`SpawnOptions.maxOutputTokens?: number`（經由 `RoleModelHost`）；行為——子代理的每個 `LLMRequest` 帶 `maxOutputTokens`（被窗口夾過）

**實況（量測）**：`packages/subagent/src/` 的 `contextWindow`／`maxOutputTokens` **零命中**；`child.ts:284-285` 只讀 `client` 與 `reasoningEffort`；但在「role 宣告了模型」那條路上，解析出來的物件**在 runtime 仍帶著**那兩個鍵（TS 結構型別不刪屬性，且 `apps/cli/src/provider-runtime.ts:19-23` 原物件回傳）⇒ 丟掉它們的是**型別**（`child.ts:182`）與**讀取點**。

- [ ] **Step 1: 把兩個測試 helper 抬到 module scope**

`packages/subagent/test/child.test.ts:651-668` 的 `recordingClient` 與 `settled` 目前宣告在 `describe("the role's resolved reasoningEffort reaches the child")` 的**身體裡**（`:647` 開始），所以新的 describe 看不到它們。

把這兩個宣告**原封不動**搬到檔案層級（放在 `function spawnFixture()` `:438` 之前），並在搬過去的那一份加一行說明：

```ts
/** Two describes share these: the effort test (below) and the budget test
 * (M73). The body is UNCHANGED from where it was declared inside the effort
 * describe — a move, not a second copy. (`recordingModel` at :330 is an
 * earlier twin with a different shape; this task does not touch it.) */
```

**不要**複製成第二份，也不要動 `:330` 的 `recordingModel`。

- [ ] **Step 2: 寫紅測試（三條）**

```ts
// ── the child's request carries the SESSION's budget, not just its model ─────
// provider-runtime's binding already carries `contextWindow`/`maxOutputTokens`;
// the spawn kept the client and the effort and dropped those two, so every child
// ran unbounded — a request with no cap is one nothing can clamp (on anthropic
// the adapter's own 128k fallback, unclamped, is what reaches the wire) and a
// request with no window is one the budget ladder cannot even measure. The
// REQUEST is the surface where "the child carries its budget" is a fact.
describe("the child's request carries the resolved budget", () => {
  it("a declared role's binding hands its window and cap to the child", async () => {
    const f = spawnFixture()
    const roleClient = recordingClient("from the role's model")
    const resolveModel = async () => ({
      status: "ready" as const,
      binding: {
        client: roleClient, providerId: "gw", modelId: "big", label: "role",
        contextWindow: 9_000, maxOutputTokens: 50_000,
      },
    })
    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: { ...f.roles.get("general")!, model: { provider: "gw", model: "big" } },
      parentModel: f.parentModel, resolveModel,
      allowSubagentModelSelection: true,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    await settled(f.jobs, jobId)

    const req = roleClient.requests[0]!
    // 9k window, 50k cap ⇒ the clamp MUST have shrunk it. This is the assertion
    // that fails if the WINDOW was dropped: clampOutputCap returns the value
    // untouched when the window is undefined (llm-seam), so a cap-only fix
    // would sail through an equality assertion on 50_000 and leave the 400
    // this unit exists to close.
    expect(req.maxOutputTokens).toBeGreaterThan(0)
    expect(req.maxOutputTokens!).toBeLessThan(50_000)
  }, 10_000)

  it("an inheriting child gets the SESSION's numbers", async () => {
    const f = spawnFixture()
    const parentClient = recordingClient("parent")
    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,        // no role model → the inherit arm
      parentModel: parentClient, resolveModel: noRoleModel,
      contextWindow: 200_000, maxOutputTokens: 4_242,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    await settled(f.jobs, jobId)

    // 200k window vs a small request ⇒ the clamp is a no-op and the value is
    // the session's own, verbatim.
    expect(parentClient.requests[0]!.maxOutputTokens).toBe(4_242)
  }, 10_000)

  it("neither source has one → the child's request carries NEITHER key", async () => {
    const f = spawnFixture()
    const parentClient = recordingClient("parent")
    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,
      parentModel: parentClient, resolveModel: noRoleModel,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    await settled(f.jobs, jobId)

    // 缺席即缺席 — a spawned default here would be a number nobody chose.
    expect("maxOutputTokens" in parentClient.requests[0]!).toBe(false)
  }, 10_000)
})
```

**為什麼第 1 條斷的是不等式而不是精確公式**：spec §2 把驗收看成一條等式（「送出的值是 `window − 輸入估計 − 4096`」）。那個等式**寫不出來**——測試看不到 `OUTPUT_CAP_SAFETY_MARGIN`（llm-seam 沒有匯出它），也看不到 child 自己算的 `overheadTokens`（它由角色 prompt 與工具 schema 的 JSON 長度決定）。**證明機制的是變異，不是等式**：Step 7 的 (a) 把窗口的傳遞拿掉 ⇒ 值回到 50_000 ⇒ 這條紅，那正是「窗口真的被用上、夾取真的發生」的證據。夾取本身的算術已由 M72 Ⅱ 直接測在 llm-seam，這裡不重測協作者。

- [ ] **Step 3: 跑它，看到紅**

Run: `pnpm --filter @i-harness/subagent test`
Expected: 第 1、2 條紅（`maxOutputTokens` 是 `undefined` ⇒ `toBeGreaterThan` 失敗）；第 3 條**綠先**（今天本來就沒有那個鍵）——它的殺手是 Step 6 的變異 (c)。

- [ ] **Step 4: 型別：把兩個數字補進 host 形狀與 ready arm**

`packages/subagent/src/child.ts`，`RoleModelHost`（`:110-118`，接在 `allowSubagentModelSelection` 之後）：

```ts
  /** M73: the SESSION's own model's numbers — what an INHERITING child runs
   * under (no declared role model). They ride this host shape for the same
   * reason `roleSelectionFor` does: every spawn arm (the subagent tool, the
   * team scheduler, the guardian) already carries it, so the values reach
   * `spawnChild` without a second parameter path. NOT the numbers of a role's
   * DECLARED model — that binding resolves at spawn and carries its own
   * (RoleModelState's ready arm below). Absent → no key is written. */
  contextWindow?: number
  maxOutputTokens?: number
```

`RoleModelState` 的 ready arm（`:182`）：

```ts
  | { status: "ready"; binding: { client: ModelClient; reasoningEffort?: ReasoningEffort; contextWindow?: number; maxOutputTokens?: number } }
```

（`session-executor/src/assembly.ts:100-103` 的孿生型別由 **Task 3** 處理——那是 host 端的同一份形狀，兩處都要改，否則 host 傳不進來。）

- [ ] **Step 5: 實作：讀出來、傳進去**

`spawnChild` 的讀取段（`:268-287` 的 `let model` / `let reasoningEffort` 旁邊）：

```ts
  // M73: the numbers the request is CLAMPED against and the ladder MEASURES
  // with. The declared arm reads them off the binding it just resolved; the
  // inherit arm takes the session's, handed in on the host shape.
  let contextWindow = opts.contextWindow
  let maxOutputTokens = opts.maxOutputTokens
```

並在 `if (declared !== undefined) { ... }` 內、`modelLabel = modelLabelOf(declared)` 之前加：

```ts
    contextWindow = state.binding.contextWindow
    maxOutputTokens = state.binding.maxOutputTokens
```

`createAgent` 之前，把 composed prompt 收成一個常數（今天它在 `:297` 被 inline 呼叫一次）：

```ts
  // M73: the prompt is composed ONCE — the agent gets it, and the overhead
  // estimate below prices it.
  const childPrompt = composeSubagentPrompt(opts.role.systemPrompt)
  // The charge the child's log never carries but the model sees on every
  // request: its composed prompt and its tool schemas' JSON — priced the way the
  // session's own assembly prices the same pair (assembly.ts's
  // estimateAssemblyOverhead), against the char/token constant token-meter owns.
  // Absent window → absent overhead: `budget` needs a window anyway.
  const overheadTokens = contextWindow === undefined
    ? undefined
    : Math.ceil(childPrompt.length / CHARS_PER_TOKEN)
      + Math.ceil(JSON.stringify(childReg.schemas()).length / CHARS_PER_TOKEN)
```

`createAgent` 的 deps（`:290-316`），接在 `...(reasoningEffort !== undefined ? { reasoningEffort } : {})` 之後：

```ts
    // M73: the budget this child's requests carry. Before this, a child ran
    // unbounded — no cap (per-provider max_tokens absent, so on anthropic the
    // adapter's own unclamped fallback went to the wire) and no window (the
    // budget ladder cannot even fire without one). Both come from the same
    // place the main session's do.
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(contextWindow !== undefined
      ? { budget: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
```

`:297` 的 `systemPrompt:` 改成 `systemPrompt: childPrompt,`。

最後把 import 補上（`child.ts` 檔頭）：

```ts
import { CHARS_PER_TOKEN } from "@i-harness/token-meter"
```

並在 `packages/subagent/package.json` 的 `dependencies` 加：

```json
    "@i-harness/token-meter": "workspace:*",
```

- [ ] **Step 6: 跑它，看到綠**

Run: `pnpm --filter @i-harness/subagent test` ＋ `pnpm --filter @i-harness/subagent typecheck`。**所有既有案例都要綠**（`:670` 的 effort 兩條不受影響：它們的 binding 不帶那兩個鍵 ⇒ 缺席）。

- [ ] **Step 7: 變異證明（三條）**

(a) **拿掉視窗的傳遞**（`...(contextWindow !== undefined ? { budget: ... } : {})` 整段）⇒ 第 1 條必須紅（因為窗口消失 ⇒ 夾取變成 no-op ⇒ 值回到 50_000）；(b) **拿掉 cap 的傳遞** ⇒ 第 1、2 條必須紅；(c) **讓 `budget`/`maxOutputTokens` 無條件寫入**（沒有值時也寫 `undefined`）⇒ 第 3 條必須紅。

每一條都要記下你**實際**用的那一行編輯與它的紅。還原並 `sha256sum` 驗證。

- [ ] **Step 8: Commit**

```bash
git add packages/subagent/src/child.ts packages/subagent/test/child.test.ts packages/subagent/package.json
git commit -m "feat(subagent): a spawned child's requests carry the resolved window and cap (M73)"
```

---

### Task 2: rebuild 路徑——同樣兩個數字，加上它掉的 prompt contract

**Files:**
- Modify: `packages/subagent/src/tools.ts`（`ensureResidentAgent` `:602-673`，讀取 `:628-635`、`createAgent` `:657-667`）
- Test: `packages/subagent/test/resume.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RoleModelHost.contextWindow?` / `maxOutputTokens?`（`SubagentToolDeps extends RoleModelHost`，`tools.ts:30`）與 `RoleModelState` 的加寬 ready arm
- Produces: 行為——`resume_agent`／inbox sweep／teammate wake 重建出來的 agent，deps 與 spawn 的一致

**實況（量測）**：`tools.ts:633-634` 與 `child.ts:284-285` 是同一段讀取的孿生；`tools.ts:657-667` 的 deps 同樣沒有 `budget`／`maxOutputTokens`。**且它還有第二個缺陷**：`:659` 傳 `systemPrompt: role.systemPrompt`，而 spawn 傳 `composeSubagentPrompt(role.systemPrompt)`（`child.ts:297`）——`composeSubagentPrompt` 全樹**只有一個呼叫點**，所以重建的子代理掉掉 `SUBAGENT_PROMPT_CONTRACT`，而 `child.ts:296` 的註解說「每個 child agent 都會附加」。spawn 那條有測試（`child.test.ts:370-376`），**rebuild 那條沒有**。

- [ ] **Step 1: 寫紅測試（兩條）**

寫在 `packages/subagent/test/resume.test.ts`。該檔**已經有一條完全同形的測試**——`it("the rebuilt child's requests carry the resolved binding's reasoningEffort")`（在 `describe("ensureResidentAgent")` 內，`resume.test.ts:174-202`）。以下兩條就是它的**逐字複製品**，只換掉 binding 的內容與斷言；`setup()`（`:31-48`，回 `{ deps, table, agents, jobs }`）、`restoredEntry()`（`:50-62`）、`driveFollowups` 的注入手法全部沿用。

```ts
  // M73: the same two numbers spawnChild carries, on the rebuild path — a
  // budget that appears only on the first spawn would vanish on every resume.
  it("M73: the rebuilt child's requests carry the resolved window and cap", async () => {
    const { deps, table } = setup()
    const entry = restoredEntry("child-1", "general")
    append(entry.session, { type: "subagent/inbox", messageId: "in-1", message: "wake after resume" })
    table.add(entry.path, entry)
    const requests: LLMRequest[] = []
    const roleClient: ModelClient = {
      async *stream(request) {
        requests.push(request)
        yield { type: "text/chunk", text: "rebuilt" }
        yield { type: "end" }
      },
    }
    const rebuilt: SubagentToolDeps = {
      ...deps,
      allowSubagentModelSelection: true,
      roleSelectionFor: () => ({ provider: "gw", model: "big" }),
      resolveModel: async () => ({
        status: "ready" as const,
        binding: { client: roleClient, contextWindow: 200_000, maxOutputTokens: 4_242 },
      }),
    }

    await driveFollowups({ ...rebuilt, rebuild: (e) => ensureResidentAgent(rebuilt, e) }, entry, "child-1")

    expect(requests).toHaveLength(1)
    // 200k window vs a small request ⇒ the clamp is a no-op and the resolved
    // value lands verbatim.
    expect(requests[0]!.maxOutputTokens).toBe(4_242)
  }, 10_000)

  // M73 defect #2 at the same site: the rebuild passed `role.systemPrompt` where
  // spawn passes the COMPOSED prompt, so a resumed child silently lost
  // SUBAGENT_PROMPT_CONTRACT. The request is the surface where that is a fact.
  it("M73: the rebuilt child's system prompt is the COMPOSED one", async () => {
    const { deps, table } = setup()
    const entry = restoredEntry("child-1", "general")
    append(entry.session, { type: "subagent/inbox", messageId: "in-1", message: "wake after resume" })
    table.add(entry.path, entry)
    const requests: LLMRequest[] = []
    const roleClient: ModelClient = {
      async *stream(request) {
        requests.push(request)
        yield { type: "text/chunk", text: "rebuilt" }
        yield { type: "end" }
      },
    }
    // No declared selection ⇒ the inherit arm, which runs on `parentModel` —
    // the recording client stands in for it.
    const rebuilt: SubagentToolDeps = { ...deps, parentModel: roleClient }

    await driveFollowups({ ...rebuilt, rebuild: (e) => ensureResidentAgent(rebuilt, e) }, entry, "child-1")

    const role = deps.roles.get("general")!
    expect(requests).toHaveLength(1)
    expect(requests[0]!.systemPrompt).toBe(composeSubagentPrompt(role.systemPrompt))
    // …and the contract is what makes the difference: the composed prompt is
    // NOT the bare role prompt, so this can never pass by both being equal.
    expect(requests[0]!.systemPrompt).not.toBe(role.systemPrompt)
  }, 10_000)
```

檔案頭補一個 import（`composeSubagentPrompt` 由 `../src/child.ts` 匯出）：

```ts
import { composeSubagentPrompt } from "../src/child.ts"
```

（若本檔的 fixture 形狀讓某一條寫不出來，**回報**而不是改測別的——那是 fixture 的事實，不是設計的。）

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/subagent test`
Expected: 兩條都紅（`undefined` 與未組成的 prompt）。

- [ ] **Step 3: 實作**

讀取段（`:628-635`）：

```ts
  let model = deps.parentModel
  let reasoningEffort: ReasoningEffort | undefined
  // M73: the same two numbers spawnChild carries, from the same two sources —
  // a rebuild is a spawn with a restored log, and a budget that appeared only
  // on the first one would vanish on every resume.
  let contextWindow = deps.contextWindow
  let maxOutputTokens = deps.maxOutputTokens
  if (declared !== undefined) {
    const state = await deps.resolveModel(declared)
    if (state.status !== "ready") return false
    model = state.binding.client
    reasoningEffort = state.binding.reasoningEffort
    contextWindow = state.binding.contextWindow
    maxOutputTokens = state.binding.maxOutputTokens
  }
```

並在 `createAgent` 之前：

```ts
  // M73 defect #2: this call used `role.systemPrompt` where spawn uses the
  // COMPOSED prompt — so a rebuilt child silently lost SUBAGENT_PROMPT_CONTRACT
  // (scope / delegation / result-delivery), which child.ts's own comment says
  // rides "every child agent". Same composer, same place, one call site each.
  const childPrompt = composeSubagentPrompt(role.systemPrompt)
  const overheadTokens = contextWindow === undefined
    ? undefined
    : Math.ceil(childPrompt.length / CHARS_PER_TOKEN)
      + Math.ceil(JSON.stringify(childReg.schemas()).length / CHARS_PER_TOKEN)
```

`createAgent` 的 deps（`:657-667`）：`systemPrompt: childPrompt`，並接上與 Task 1 **同形**的兩個 spread：

```ts
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(contextWindow !== undefined
      ? { budget: { contextWindow, ...(overheadTokens !== undefined ? { overheadTokens } : {}) } }
      : {}),
```

`tools.ts` 檔頭補 `import { composeSubagentPrompt } from "./child.ts"`（若尚未 import）與 `CHARS_PER_TOKEN`。

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/subagent test` ＋ typecheck —— **所有既有案例都要綠**，特別是 `resume.test.ts:175-202` 那兩條（它們釘住 `modelLabel` 與 `reasoningEffort`）。

- [ ] **Step 5: 變異證明（三條）**

(a) 拿掉窗口那一段 ⇒ 第 1 條紅；(b) 把 `systemPrompt: childPrompt` 改回 `role.systemPrompt` ⇒ 第 2 條紅；(c) 拿掉 cap 那一段 ⇒ 第 1 條紅。記錄實際編輯與還原的 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/src/tools.ts packages/subagent/test/resume.test.ts
git commit -m "fix(subagent): a rebuilt child keeps its budget and its composed prompt contract (M73)"
```

---

### Task 3: host 端把 session 的數字交進去（三個 spawn 臂）

**Files:**
- Modify: `packages/session-executor/src/assembly.ts`（`RoleModelResolution` `:100-103`；`registerSubagent` `:1057-1083`；`registerGuardian` `:1113-1138`；`mountAgentTeams` `:1144`+）
- Modify: **`packages/subagent/src/index.ts`**（`registerSubagent` 的 `subagentDeps` `:160-180`——**第四個 hop**：那兩個欄位經 `RoleModelHost` 進了 `RegisterSubagentOptions`，但這個 deps 物件沒有把它們往下傳，少了這一步 inherit 臂在 CLI 路上**什麼都收不到**。這一步是 T1 的複審發現的，原本的計畫漏了它。）
- Modify: **`packages/subagent/src/tools.ts`**（`spawn_agent` 工具對 `spawnChild` 的呼叫 `:150-190`——**第五個 hop**：它轉送 `parentModel`／`resolveModel`／兩個開關，卻沒有這兩個數字 ⇒ 走**工具**（最主要的那條路）spawn 出來的子代理，inherit 臂兩者皆無。T2 的複審指名了這一跳。）
- Modify: `packages/guard-approval/src/guardian/reviewer.ts`（`GuardianReviewDeps` `:24-`；`spawnChild` `:151-172`）
- Modify: `packages/agent-team/src/scheduler.ts`（`TeamDeps` `:71-`；`spawnChild` `:196-216`）
- Test: `packages/session-executor/test/assembly.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RoleModelHost.contextWindow?` / `maxOutputTokens?`（`RegisterSubagentOptions` 與 `SpawnOptions` 都 extends 它）
- Produces: 行為——一個 assembly 帶了 `contextWindow`／`maxOutputTokens` 時，**它掛出來的子代理**（工具、隊友、guardian）都帶著它們

**實況（量測）**：`AssemblyOptions.contextWindow`（`:211`）與 `maxOutputTokens`（`:217`）在三個註冊點都**已經在 scope 裡**；三個 spawn 臂各自把 `parentModel` 與開關往下傳，卻沒有這兩個。

- [ ] **Step 1: 寫紅測試**

`packages/session-executor/test/assembly.test.ts:379-406` 的 `spawnBlockingModel` 就是這個測試要的形狀，`waitFor` 在檔案層級（`:5`，`async function waitFor(cond, timeoutMs = 5000)`）。**照它寫一個錄製版**（父的 turn 發同一個 `spawn_agent`、子的 turn 用同一個訊息內容辨識法，但不阻塞、且把請求推起來），放在同一個 describe 裡（**不要**動 `spawnBlockingModel` 本身）：

```ts
  // M73: the recording twin of spawnBlockingModel above — same routing (the
  // child's turn is recognised by its authored message; the child run's first
  // stream call races the parent's continuation, so ordering cannot be relied
  // on), and every request the CHILD makes is kept.
  function spawnRecordingModel(): { model: ModelClient; childRequests: LLMRequest[] } {
    const childRequests: LLMRequest[] = []
    let spawned = false
    const model: ModelClient = {
      async *stream(request: LLMRequest) {
        const last = request.messages.at(-1)
        const isChild = last?.role === "user" && typeof last.content === "string" && last.content.includes("inspect code")
        if (isChild) {
          childRequests.push(request)
          yield { type: "text/chunk", text: "child ok" }
          yield { type: "end" }
          return
        }
        if (!spawned) {
          spawned = true
          yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "inspect code", task_name: "helper" } } }
          yield { type: "end" }
          return
        }
        yield { type: "text/chunk", text: "spawned" }
        yield { type: "end" }
      },
    }
    return { model, childRequests }
  }
```

新 describe：

```ts
// ── M73: the session's budget reaches the subagents it spawns ───────────────
describe("createSessionAssembly — the session's budget reaches its children (M73)", () => {
  it("a spawned child's requests carry the session's window and cap", async () => {
    const { model, childRequests } = spawnRecordingModel()
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      sessionId: "s1",
      approveAll: true,
      model,
      contextWindow: 200_000,
      maxOutputTokens: 4_242,
    })
    try {
      await assembly.agent.run("spawn a helper")
      await waitFor(() => childRequests.length > 0)
      // 200k window vs a small request ⇒ the session's own value, verbatim.
      expect(childRequests[0]!.maxOutputTokens).toBe(4_242)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})
```

（`spawnRecordingModel` 宣告在**檔案的既有 describe 內**；新 describe 若在同一個外層 scope，把它抬到檔案層級——**move，不是複製**。）

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/session-executor test`
Expected: 紅（`maxOutputTokens` 是 `undefined`）。

- [ ] **Step 3: 實作（三個臂）**

`assembly.ts`：

1. **`RoleModelResolution`（`:100-103`）**——與 Task 1 的 `RoleModelState` **同步加寬**（ready arm 加 `contextWindow?`／`maxOutputTokens?`）。這一處的註解（`:95-99`）已經說明為什麼 ready arm 收 `reasoningEffort`；把兩個新欄位接在它後面，並補一句「M73：同一個理由——binding 的兩個數字由 host 原樣傳遞」。
2. **`registerSubagent`（`:1057-1083`）**——沿用同一個慣例（`...(opts.x !== undefined ? { x: opts.x } : {})`）：

```ts
      ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
      ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
```

3. **`registerGuardian`（`:1113-1138`）**——同樣兩個 spread。**但語意不同**：guardian 的 `parentModel` 是 `deps.model ?? deps.parentModel`（`reviewer.ts:149`），所以**設定了自己的模型時，session 的數字不是它的**——見下一步。
4. **`mountAgentTeams`（`:1144`）**——同樣兩個 spread。

`packages/subagent/src/index.ts`：

4b. **`subagentDeps`（`:160-180`）**——兩個欄位要**再往下傳一層**（`RegisterSubagentOptions` → `SubagentToolDeps`），沿用同一個慣例：

```ts
    ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
```

少了這一步，`registerSubagent` 收回來的 `SubagentToolDeps` 沒有那兩個值 ⇒ 工具臂的 spawn 走 inherit 時**兩者皆無**（T1 的複審指名了這一跳）。

`packages/subagent/src/tools.ts`：

4c. **`spawn_agent` 的 `spawnChild` 呼叫（`:150-190`）**——那兩個值到了 `SubagentToolDeps` 之後，**這一步才是真的把它們交給 spawn**；在那之前它是空手的。照同一個慣例，接在 `allowSubagentModelSelection: deps.allowSubagentModelSelection` 之後：

```ts
        ...(deps.contextWindow !== undefined ? { contextWindow: deps.contextWindow } : {}),
        ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
```

（T2 的複審警告：只接 `index.ts` 那一跳的話，「兩個路徑的優先序一致」會成立，而**實際的預算兩邊都是空的**——優先序對、數字沒有，是最難看出來的那種錯。）

`agent-team/src/scheduler.ts`：

5. **`TeamDeps`（`:71-`）**——本檔的慣例是個別鏡射 `SpawnOptions` 的欄位（`:46` `resolveModel: SpawnOptions["resolveModel"]`、`:54` `roleSelectionFor?: SpawnOptions["roleSelectionFor"]`），照它：

```ts
  contextWindow?: SpawnOptions["contextWindow"]
  maxOutputTokens?: SpawnOptions["maxOutputTokens"]
```

6. **`spawnChild`（`:196-216`）**——同樣兩個 spread，接在 `roleSelectionFor`／`allowSubagentModelSelection` 那兩行之後。

`guard-approval/src/guardian/reviewer.ts`：

7. **`GuardianReviewDeps`（`:24-`）**——加兩個可選欄位，型別用 `SpawnOptions["contextWindow"]`／`SpawnOptions["maxOutputTokens"]`。
8. **`spawnChild`（`:151-172`）**——**只在繼承臂**傳：

```ts
    // M73: the session's numbers are the numbers of THE SESSION'S MODEL. When a
    // guardian model is configured, this child runs on a different endpoint
    // whose window we do not know here — passing the session's would be a
    // wrong number, which is worse than an absent one. So: inherited arms get
    // them, configured ones stay absent (and are recorded as a residual).
    ...(deps.model === undefined && deps.contextWindow !== undefined ? { contextWindow: deps.contextWindow } : {}),
    ...(deps.model === undefined && deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
```

`assembly.ts` 的 `registerGuardian` 呼叫點照樣傳（`opts.guardian.model` 的判斷在 reviewer 裡）。

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/session-executor test`、`--filter @i-harness/guard-approval test`、`--filter @i-harness/agent-team test`，三個 typecheck。**既有案例全綠**——特別是 `assembly.test.ts` 的 42 條與 guardian 既有的 case。

- [ ] **Step 5: 變異證明（兩條）**

(a) 拿掉 `registerSubagent` 的兩個 spread ⇒ 新測試紅；(b) 拿掉 `reviewer.ts` 的 `deps.model === undefined` 條件（變成無條件傳）⇒ **必須有**一條 guardian 的既有或新測試會紅；若沒有，**那是發現——回報它**（代表「設定 guardian 模型」那條路今天沒有測試在盯），不要為了讓它紅而加一條與設計無關的測試。

- [ ] **Step 6: Commit**

```bash
git add packages/session-executor/src/assembly.ts packages/guard-approval/src/guardian/reviewer.ts packages/agent-team/src/scheduler.ts packages/session-executor/test/assembly.test.ts
git commit -m "feat(assembly): the session's window and cap reach every spawn arm (M73)"
```

---

### Task 4: compaction 的摘要請求帶 cap，而且被夾過

**Files:**
- Modify: `packages/compaction/src/index.ts`（引擎 deps `:56-69`；`compactOnce` 的呼叫 `:159`）
- Modify: `packages/compaction/src/summarizer.ts`（簽名 `:160-173`；請求組裝 `:180-190`）
- Modify: `packages/core-agent/src/index.ts`（`createCompactionEngine` 的呼叫 `:185-194`）
- Test: `packages/compaction/test/summarizer-prefix.test.ts`

**Interfaces:**
- Consumes: `deps.maxOutputTokens`（`AgentDeps`，`core-agent:89-91`）、`clampOutputCap`（`@i-harness/llm-seam`，compaction 已依賴）、`estimateContent`（`@i-harness/token-meter`，compaction 已依賴）、窗口 `contextWindow`（`compaction/src/index.ts:77`）
- Produces: `createCompactionEngine` deps 的 `maxOutputTokens?: number`；`summarizeWithModel` 的一個新可選參數 `limits?: { maxOutputTokens?: number; contextWindow?: number }`

**實況（量測）**：`summarizer.ts:181-184` 的三個 `LLMRequest` 字面只有 `messages`／`tools`／`systemPrompt`；`packages/compaction/` 全包 `maxOutputTokens` **零命中**（含測試）。窗口在 `index.ts:77` 解析、呼叫點 `:159` 在同一個 scope。**`CompactionConfig.maxTokens` 不是上限**：它唯一的用途是事後切片（`summarizer.ts:196` 的 `trimToTokens(trimmed, maxTokens)`，而 `trimToTokens` = `slice(0, maxTokens * 4)`）——**不要**把它接到 wire 上（那會讓摘要被模型截斷、卻仍然通過 `minSummaryChars` floor 檢查，而下一輪的 anchored 摘要是建立在它上面）。

- [ ] **Step 1: 寫紅測試（兩條）**

寫在 `packages/compaction/test/summarizer-prefix.test.ts`（它的 `capturingModel`（`:29-41`）與 `createCompactionEngine` 的用法就是形狀）：

```ts
// ── M73: the summarizer's own request carries a budget ──────────────────────
// This request is built by compaction, not by the session's agent, so it never
// met the clamp. On an anthropic route that made it exactly the dangerous one:
// no cap on the request ⇒ the adapter's own 128k fallback, unclamped, on the
// call that runs BECAUSE the context is nearly full.
describe("M73: the summarizer request carries a clamped cap", () => {
  it("hands the resolved cap to the request, clamped against the window", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 1_000, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
      maxOutputTokens: 50_000,
    })
    await engine.compact(toolSession())

    const req = requests[0]!
    // 1k window ⇒ the clamp must have shrunk it; without the window on this
    // path clampOutputCap returns the value untouched.
    expect(req.maxOutputTokens).toBeGreaterThan(0)
    expect(req.maxOutputTokens!).toBeLessThan(50_000)
  })

  it("with no resolved cap the request carries NO key (absent stays absent)", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 1_000, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
    })
    await engine.compact(toolSession())
    expect("maxOutputTokens" in requests[0]!).toBe(false)
  })
})
```

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/compaction test`
Expected: 第 1 條紅（`undefined`，而且 `maxOutputTokens` 不是 `createCompactionEngine` 認得的選項 ⇒ 也會是 typecheck 錯——先讓測試紅，再修型別）。第 2 條綠先。

- [ ] **Step 3: 實作**

`packages/compaction/src/summarizer.ts`：

1. 簽名加最後一個可選參數：

```ts
export async function summarizeWithModel(
  model: ModelClient,
  replayText: string,
  maxTokens: number,
  previousSummary: string | undefined,
  instructions: string | undefined,
  minSummaryChars: number,
  attemptsTracker?: { count: number },
  prefix?: { systemPrompt: string; tools: ToolSchema[]; messages: LLMMessage[] },
  /** M73: the request's OWN budget. `maxOutputTokens` is the model's resolved
   * cap (the chain's value, anthropic's required fallback included);
   * `contextWindow` is what the engine resolved. Both optional — absent
   * means the request carries no cap, exactly as before. */
  limits?: { maxOutputTokens?: number; contextWindow?: number },
): Promise<{ text: string; attempts: number }> {
```

2. 在 `const request: LLMRequest = ...`（`:181-184`）**之後**、`let out = ""` 之前：

```ts
    // M73: the cap this request carries, clamped against the window and the
    // input we are about to send — the same `clampOutputCap` the session's own
    // requests go through (llm-seam), applied HERE because this request is
    // built here and nowhere else. Absent cap ⇒ absent key: a default would be
    // a number nobody chose.
    const cappedRequest: LLMRequest = limits?.maxOutputTokens === undefined
      ? request
      : {
          ...request,
          maxOutputTokens: clampOutputCap(
            limits.maxOutputTokens,
            limits.contextWindow,
            estimateContent(request.messages),
          ),
        }
```

3. 把下面那個 `model.stream(request)` 改成 `model.stream(cappedRequest)`（`:186`）。

4. 檔頭 import：`clampOutputCap` 接進既有的 `@i-harness/llm-seam` import；`estimateContent` 從 `@i-harness/token-meter` 進（compaction 已依賴它，`package.json:14`）。

`packages/compaction/src/index.ts`：

5. 引擎 deps 型別（`:56-69`）加：

```ts
  /** M73: the model's resolved output cap, handed down from the layer that
   * resolved it (core-agent's AgentDeps). Absent → the summarizer's request
   * carries no cap (pre-M73 behavior). */
  maxOutputTokens?: number
```

6. `:159` 的呼叫加第九個引數：

```ts
      const result = await summarizeWithModel(model, replayText, config.maxTokens, previousSummary, instructions, config.minSummaryChars, attemptsTracker, prefix, {
        ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      })
```

**注意 `config.maxTokens` 的位置不動**——它仍然是那個字元切片，第 3 與第 9 個引數是兩件事。

`packages/core-agent/src/index.ts`：

7. `createCompactionEngine` 的呼叫（`:185-194`）加：

```ts
        ...(deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
```

- [ ] **Step 4: 跑它，看到綠**

Run: `pnpm --filter @i-harness/compaction test`、`--filter @i-harness/core-agent test`（它的 101 條要全綠）、兩個 typecheck。**既有案例全綠**，特別是 `summarizer-prefix.test.ts:64-100`（不帶 cap ⇒ 不帶鍵）與 `engine.test.ts` 的 `maxTokens` 切片兩條（`maxTokens` 的語意沒有動）。

- [ ] **Step 5: 變異證明（兩條）**

(a) 讓 `cappedRequest` 無條件等於 `request`（即拿掉夾取那一段）⇒ 第 1 條紅；(b) 讓它無條件寫 `maxOutputTokens`（沒有 cap 時也寫）⇒ 第 2 條紅。記錄實際編輯與還原的 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/compaction/src/index.ts packages/compaction/src/summarizer.ts packages/core-agent/src/index.ts packages/compaction/test/summarizer-prefix.test.ts
git commit -m "feat(compaction): the summarizer's request carries the resolved cap, clamped (M73)"
```

---

### Task 5: 摘要失敗說得出自己是什麼

**Files:**
- Modify: `packages/compaction/src/index.ts`（`CompactionResult` `:23-35`；`compactOnce` 的 fail-soft `:162-172`）
- Modify: `apps/cli/src/run.ts`（`handleSessionCompactCommand` `:96-110`）
- Test: `packages/compaction/test/engine.test.ts`、`apps/cli/test/session-compact.test.ts`

**Interfaces:**
- Produces: `CompactionResult.reason?: "summarizer-failed"`（值域至少含此一值；缺席維持缺席）
- Produces: 行為——`/compact` 對「摘要器失敗」與「沒有可壓的區域」給**不同**的字

**實況（量測）**：`{ compacted: false, shadowedSeqs: [] }` 今天至少出現在四個地方（`:109` 沒有可壓區域、`:171` 摘要器失敗、`:186` 與 `:215` 兩條引擎早退）⇒ 判別欄位的義務是**「摘要器失敗」與其餘全部分得開**。`apps/cli/src/run.ts:102` 對**任何** `!result.compacted` 都回 `"No compactable history yet."`。

- [ ] **Step 1: 寫紅測試（兩條）**

`packages/compaction/test/engine.test.ts`——加在既有的 `it("summarizer failure is fail-soft: no events appended")`（`:58-69`）**之後**，沿用同一組 fixture（`mockModel`、`longSession`、`config` 都在該檔頂端）：

```ts
  it("M73: a summarizer failure SAYS it was the summarizer", async () => {
    const failing: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: "error", error: new Error("model exploded") }
      },
    }
    const s = longSession()
    const engine = createCompactionEngine({ model: failing, config })
    const result = await engine.compact(s)
    expect(result.reason).toBe("summarizer-failed")

    // The control: a `false` from a DIFFERENT arm carries no reason. Without
    // this the assertion above could pass on a type that always writes one.
    const noPressure = await createCompactionEngine({ model: mockModel("x"), config }).maybeCompact(createSession())
    expect(noPressure.compacted).toBe(false)
    expect(noPressure.reason).toBeUndefined()
  })
```

（對照那一條走的是 **pressure gate** 那條早退，不是 `:109` 的「沒有可壓區域」——`maybeCompact` 在空 session 上必然早退，這與既有 `:41` 那條同一個機制。**不要**改用 `compact(createSession())`：顯式 compact 沒有壓力閘，它會去 shadow 那個唯一的 event（既有 `:52` 那條就是這樣）。）

`apps/cli/test/session-compact.test.ts`——沿用該檔的 `deps()` helper（`:14-27`）：

```ts
  it("M73: a summarizer failure does not read as 'nothing to compact'", async () => {
    const d = deps({
      compactNow: async (): Promise<CompactionResult> => ({ compacted: false, shadowedSeqs: [], reason: "summarizer-failed" }),
    })
    const out = await handleSessionCompactCommand(d, "{}")
    expect(out).not.toBe("No compactable history yet.")
    expect(out).toContain("summar")
  })
```

第二條的斷言**不要**寫死整句話（文案會再改），斷言它**不再是那句話**且**說得出是摘要的問題**。

**這一改會撞到四條既有斷言——已逐條量過，四條都要改，且都是「變嚴」而不是放寬**：它們斷言的是**摘要器失敗那一條臂的完整回傳形狀**，所以加上 `reason` 之後正確的期望值就是它。四條都是 `expect(...).toEqual({ compacted: false, shadowedSeqs: [] })` ⇒ 改成 `expect(...).toEqual({ compacted: false, shadowedSeqs: [], reason: "summarizer-failed" })`：

| 檔案:行 | 測試 |
|---|---|
| `packages/compaction/test/engine.test.ts:67` | "summarizer failure is fail-soft: no events appended" |
| `packages/compaction/test/analytics.test.ts:93` | "summarizer failure emits outcome failure (fail-soft retry still applies)" |
| `packages/compaction/test/site-diagnostics.test.ts:77` | "the summarizer's fail-soft report is the ambient handle's, at phase turn / level warn" |
| `packages/compaction/test/summarizer.test.ts:150` | "both passes below the floor throw → the existing fail-soft warn path" |

**其餘十二處 `toEqual({ compacted: false, shadowedSeqs: [] })` 不受影響**（我逐條走過：`engine.test.ts:44/96/182/209`、`hysteresis-breaker.test.ts:73/118/125/160`、`prune.test.ts:168`、`assembly.test.ts:306`、`session-compact.test.ts:11`——它們走的是壓力閘、re-fire guard、sticky、reset 與 prune 那些臂，那些臂**不寫** `reason`）。**若你跑出來紅的不是這四條，回報它**——那代表我這份清單是錯的，而錯的清單比沒有清單更糟。

- [ ] **Step 2: 跑它，看到紅**

Run: `pnpm --filter @i-harness/compaction test`、`pnpm --filter @i-harness/cli test`
Expected: 兩條新的紅（`reason` 是 `undefined`；CLI 回的是那句話）。**Step 3 之後**，上表那四條既有斷言也會紅——那是預期的，改它們的期望值（**只加 `reason`，其他不動**）。

- [ ] **Step 3: 實作**

`packages/compaction/src/index.ts`：

1. `CompactionResult`（`:23-35`）加：

```ts
  /** M73: WHY a pass that did not compact did not. Today `compacted:false` has
   * four producers (no shadowable region, a summarizer failure, and two engine
   * early exits) and they were indistinguishable to every consumer — the CLI
   * reported the summarizer's failure as "nothing to compact". Absent on the
   * arms that carry no reason (they are pre-M73 behavior, unchanged). */
  reason?: "summarizer-failed"
```

2. fail-soft 的回傳（`:171`）：

```ts
      return { compacted: false, shadowedSeqs: [], reason: "summarizer-failed" }
```

**只改那一個回傳點**——`:109`／`:186`／`:215` 不動（它們是真的「沒有可壓的區域」與早退）。

`apps/cli/src/run.ts`：

3. `:102`：

```ts
  if (!result.compacted) {
    // M73: a summarizer failure used to answer with the same sentence as an
    // empty region — a real failure reading as "there was nothing to do".
    if (result.reason === "summarizer-failed") {
      return "Compaction failed: the summarization did not succeed (see the session's warnings)."
    }
    return "No compactable history yet."
  }
```

- [ ] **Step 4: 跑它，看到綠**

Run: 兩個套件的 test ＋ typecheck。**「必須原樣綠」指的是上面那張表的十二條對照**（走壓力閘、re-fire、sticky、reset、prune 的那些臂），以及 `summarizer-prefix.test.ts` 一族的既有案例。（原文此處誤把 `engine.test.ts:58` 列為必須原樣綠——**那一條正是碰撞 #1**，本任務就是要改它。以碰撞表為準。）

- [ ] **Step 5: 變異證明（兩條）**

(a) 把 `reason: "summarizer-failed"` 拿掉 ⇒ compaction 那條紅；(b) 把 CLI 的 `if (result.reason === …)` 拿掉 ⇒ CLI 那條紅。記錄實際編輯與還原的 `sha256sum`。

- [ ] **Step 6: Commit**

```bash
git add packages/compaction/src/index.ts apps/cli/src/run.ts packages/compaction/test/engine.test.ts apps/cli/test/session-compact.test.ts
git commit -m "fix(compaction): a summarizer failure is distinguishable from an empty region (M73)"
```

---

### Task 6: 收尾（閘門＋報告）

**Files:**
- Modify: 無（只跑閘門與寫報告）

- [ ] **Step 1: `pnpm verify:all`**

Run: `pnpm verify:all`
Expected: 五步全綠（母體 67；`--gate` 不得新增 row——本階段**不新增任何 seam 匯出**）。**若 suite 紅在已量測的負載 flake**（`apps/cli` 的 M12 retry 或 entry-guard）：依既有先例隔離跑該套件、**兩個讀數都記**；修法已在 `c8dbfc4`（PR #7）。
- **若閘門說有未消費的 row，那是真的，回報而不要加 allowlist。**

- [ ] **Step 2: 報告**（寫給控制器，不進 git）

每個任務各自的：紅先證據、GREEN、**每一條變異證明與其 sha 驗證**（含「你實際用的那一行編輯」）、被改動的既有斷言（引用前後並說明為何是**刻意**而非放鬆）、以及**沒有做的事**（見 §殘餘）。

---

## 驗收（照 spec §2）

1. **子代理帶 cap 且被夾**：宣告了模型的 role ⇒ 子代理的請求帶著被窗口夾過的上限（Task 1）。
2. **繼承臂也帶**：沒有宣告模型的 role ⇒ 子代理拿到**session 的**窗口與上限（Task 1）。
3. **rebuild 也帶，且 prompt contract 沒有掉**（Task 2）。
4. **三個 spawn 臂都帶**：工具、隊友、guardian（Task 3）。
5. **摘要請求帶被夾過的 cap**（Task 4）。
6. **摘要失敗與其他 `compacted:false` 分得開**（Task 5）。
7. **缺席即缺席**：沒有值時，子代理與摘要請求都不帶那個鍵（Task 1 第 3 條、Task 4 第 2 條）。
8. `pnpm verify:all` 五步全綠、`--gate` 無新增 row（Task 6）。

**每一條都要有對應的變異證明**（把修法拿掉 ⇒ 該條紅）。

## 殘餘（本階段**不做**，寫出來不是忘了）

- **子代理自己的壓縮**：它會把 shadow 事件寫進子代理的耐久 log，而那份 log 鏡射到父的 coordinator ⇒ 改變的是「子代理的 log 長什麼樣」。獨立的設計決定（spec §3）。
- **子代理的 telemetry**：`token/usage` 需要 `deps.telemetry`，兩個建構點都沒有 ⇒ metrics sink 看不到子代理的 token（spec §3）。
- **`forkTurns` 的預設 `"all"`**：子代理的第一個請求就是父的整份逐字稿 ⇒ 一個父session已接近窗口的 spawn 會從一開始就超過預算，而子代理**沒有壓縮可救**（它會在窗口的九成——`reserveRatio` 預設 0.9——直接 `prompt_too_long`）。這是本階段**刻意的**行為改變（spec §1.4）。
- **配置了模型的 guardian**：它的窗口與 cap **在這個站點不可知**（`deps.model` 是 host 給的裸 client）⇒ 依 spec 的「缺席即缺席」不傳（Task 3 Step 3-8）。要修就得讓 host 連它的 binding 一起交進來。
- **`get_context_remaining` 對子代理不可用**（綁在主 session 上）；若哪天把角色工具清單放寬到它，子代理會被餵**父的**窗口與用量（`child.ts:72-91` 按名字複製工具）。
- **`Number.isFinite` 那半的 guard 四家都沒被釘住**（M72 Ⅲ §4.8，pre-existing）。
