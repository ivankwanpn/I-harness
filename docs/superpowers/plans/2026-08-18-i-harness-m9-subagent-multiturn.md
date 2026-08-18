# M9 Multi-turn Subagent Driver + Cold Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make i-harness subagents genuinely multi-turn and resumable — a shared core-agent turn engine with `followup`, a session-keyed agent registry, a serialized followup driver consuming the durable M8 inbox, and a `resume_agent` that cold-resumes from the persisted child session.

**Architecture:** core-agent gains a shared `runTurn` engine (`run` and `followup` both use it, `run()` contract unchanged) + `createAgentRegistry()`. The subagent package wires the registry into spawnChild (agent retained), adds a `waiting` child status, a per-child serialized followup driver (consuming `subagent/inbox` events as turns), minimal `updateJob` re-activation, and a cold-resume `resume_agent` rebuilt from `roleName` + the loaded durable session.

**Tech Stack:** Node >= 22, TypeScript strict + ESM, vitest, pnpm workspaces. NO bun, NO `@ai-sdk`, NO new external dependencies.

## Global Constraints

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new external dependencies.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **`run(task)` contract UNCHANGED** — runHeadless and the main-agent path byte-identical (the shared turn engine preserves the event sequence and step counting).
- No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps.
- The 11 tool NAMES + return shapes stay. `send_message` = queue only; `followup_task` = queue + wake.
- Touch `packages/core-agent/`, `packages/subagent/`, and `packages/exec/` ONLY if needed (jobs `updateJob` re-activation lives in `packages/subagent/src/jobs.ts`, NOT exec).
- Gates that must pass at every task's end: the package filter test, `pnpm -r test`, `pnpm -r typecheck`.

---

### Task 1: core-agent — shared turn engine + followup + registry

**Files:**
- Modify: `packages/core-agent/src/index.ts`
- Test: `packages/core-agent/test/agent.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 2-5):
  ```ts
  export interface AgentResult { finalText: string; turns: number; reasoning: string[] }
  export interface Agent {
    run(task: string, signal?: AbortSignal): Promise<AgentResult>
    followup(message: string, signal?: AbortSignal): Promise<AgentResult>
  }
  export interface AgentRegistry {
    register(sessionId: string, agent: Agent): void
    get(sessionId: string): Agent | undefined
    remove(sessionId: string): void
    entries(): Map<string, Agent>
  }
  export function createAgentRegistry(): AgentRegistry
  ```

- [ ] **Step 1: Write the failing test**

Append to `packages/core-agent/test/agent.test.ts` (reuse the existing test harness — it builds a ctx + session + mock model; check how the existing tests construct `createAgent` and copy that pattern):

```ts
  it("followup runs a second complete turn on the same session", async () => {
    // mock script: first stream "hi", second stream "again" (see the existing
    // harness's createMockClient usage — a one-shot cassette; for two turns
    // use a call-counter model client like the CLI tests, or two scripts).
    // Assert:
    // - the session log has TWO [turn/start ... turn/end] pairs
    // - the second user/message text is the followup message
    // - AgentResult.finalText of followup is the second turn's last message
  })

  it("maxTurns guards the shared step budget across run + followup", async () => {
    // maxTurns: 3; run consumes 2 steps, followup must throw maxTurns exceeded
    // when the shared counter exceeds 3.
  })

  it("a per-call signal aborts the current turn; a fresh signal allows the next", async () => {
    // controller1 aborts mid-turn → run throws "agent aborted";
    // a followup with a FRESH signal succeeds.
  })

  it("createAgentRegistry registers/gets/removes/entries", async () => {
    const registry = createAgentRegistry()
    // register an agent object; get returns it; entries has it; remove drops it.
  })
```

> The mock for two turns: use a call-counter `ModelClient` (see `apps/cli/test/cli.test.ts` for the pattern — `let calls = 0; async *stream() { if (n === 0) yield text "first"; else yield text "second" }`), OR extend `llm-mock`'s cassette. Prefer the call-counter pattern (deterministic, no cassette exhaustion).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: FAIL — `followup`/`createAgentRegistry` do not exist.

- [ ] **Step 3: Implement**

Rewrite `packages/core-agent/src/index.ts` per the spec §1.1-§1.2. The key structure (the step loop body is extracted VERBATIM from the current `run`, with `deps.signal?.aborted` checks replaced by the per-call `abort`):

```ts
export interface AgentResult {
  finalText: string
  turns: number
  reasoning: string[]
}

export interface Agent {
  run(task: string, signal?: AbortSignal): Promise<AgentResult>
  followup(message: string, signal?: AbortSignal): Promise<AgentResult>
}

export function createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig): Agent {
  const maxTurns = deps.maxTurns ?? 20
  let steps = 0          // shared across the agent's lifetime (maxTurns guard)
  let callSeq = 0
  const reasoning: string[] = []

  async function runTurn(message: string, signal?: AbortSignal): Promise<AgentResult> {
    const abort = signal ?? deps.signal
    append(deps.session, { type: "turn/start" })
    append(deps.session, { type: "user/message", text: message })
    let needsContinuation = true
    while (needsContinuation) {
      if (abort?.aborted) throw new Error("agent aborted")
      steps += 1
      if (steps > maxTurns) throw new Error(`maxTurns exceeded: ${maxTurns}`)
      append(deps.session, { type: "step/start" })
      await ctx.emit("agent/pre-step", { task: message, session: deps.session })
      const messages = deriveMessages(deps.session)
      assertMessagesFromLog(messages, deps.session)
      const request: LLMRequest = { messages, tools: deps.tools.schemas(), systemPrompt: deps.systemPrompt }
      let stepText = ""
      let toolCallsThisStep = 0
      for await (const ev of deps.model.stream(request)) {
        if (abort?.aborted) throw new Error("agent aborted")
        switch (ev.type) {
          case "text/chunk": stepText += ev.text; break
          case "reasoning": reasoning.push(ev.text); break
          case "tool_call":
            callSeq += 1
            const callId = `call_${callSeq}`
            append(deps.session, { type: "tool/call", callId, name: ev.call.name, args: ev.call.args })
            const result = await deps.tools.execute({ name: ev.call.name, args: ev.call.args })
            if (abort?.aborted) throw new Error("agent aborted")
            append(deps.session, { type: "tool/result", callId, name: ev.call.name, output: result.output })
            toolCallsThisStep += 1
            break
          case "error": throw new Error(`model stream error: ${ev.error.message}`)
          case "end": break
        }
      }
      if (stepText) append(deps.session, { type: "assistant/message", text: stepText })
      else if (toolCallsThisStep === 0) append(deps.session, { type: "assistant/message", text: "" })
      append(deps.session, { type: "step/end" })
      needsContinuation = toolCallsThisStep > 0
    }
    append(deps.session, { type: "turn/end" })
    const finalText = deriveMessages(deps.session).at(-1)?.content ?? ""
    return { finalText, turns: steps, reasoning }
  }

  return {
    run: (task, signal) => runTurn(task, signal),
    followup: (message, signal) => runTurn(message, signal),
  }
}

export interface AgentRegistry {
  register(sessionId: string, agent: Agent): void
  get(sessionId: string): Agent | undefined
  remove(sessionId: string): void
  entries(): Map<string, Agent>
}

export function createAgentRegistry(): AgentRegistry {
  const agents = new Map<string, Agent>()
  return {
    register: (sessionId, agent) => { agents.set(sessionId, agent) },
    get: (sessionId) => agents.get(sessionId),
    remove: (sessionId) => { agents.delete(sessionId) },
    entries: () => agents,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: PASS — existing tests (run behavior identical) + the 4 new tests. Then `pnpm -r test` (the subagent/cli suites must still pass — the Agent return gained `followup` but `run` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/index.ts packages/core-agent/test/agent.test.ts
git commit -m "feat: shared turn engine with followup and agent registry (P3)"
```

---

### Task 2: subagent P3a — registry wiring, waiting lifecycle, job re-activation

**Files:**
- Modify: `packages/subagent/src/index.ts` (create the registry + pass to tools)
- Modify: `packages/subagent/src/tools.ts` (`SubagentToolDeps.agents`)
- Modify: `packages/subagent/src/child.ts` (retain agent + settle to waiting)
- Modify: `packages/subagent/src/agent-table.ts` (`ChildStatus` + `ChildAgentEntry` live fields)
- Modify: `packages/subagent/src/persist.ts` (`restoreState` waiting→error)
- Modify: `packages/subagent/src/jobs.ts` (`updateJob` re-activation)
- Test: `packages/subagent/test/child.test.ts`, `packages/subagent/test/jobs.test.ts`, `packages/subagent/test/persist.test.ts`

**Interfaces:**
- Consumes: `createAgentRegistry`, `AgentRegistry` from `@i-harness/core-agent` (Task 1).
- Produces (used by Tasks 3-5):
  ```ts
  // agent-table.ts
  export type ChildStatus = "running" | "waiting" | "completed" | "killed" | "error"
  export interface ChildAgentEntry {
    // ... existing ...
    sessionId?: string
    roleName?: string            // NEW (used by Task 4)
    followupChain?: Promise<void> // NEW live-only (used by Task 3)
    lastInboxSeq?: number         // NEW live-only (used by Task 3)
  }
  // tools.ts
  export interface SubagentToolDeps { /* ... */ agents: AgentRegistry }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/subagent/test/jobs.test.ts` — append:

```ts
  it("updateJob re-opens a terminal job when set to running again", () => {
    const jobs = createJobRegistry()
    const { id } = jobs.registerJob("root", "subagent", "h")
    jobs.updateJob(id, { status: "completed", output: "done" })
    expect(jobs.read(id).status).toBe("completed")
    jobs.updateJob(id, { status: "running" })
    expect(jobs.read(id).status).toBe("running")
    jobs.updateJob(id, { status: "completed", output: "second" })
    expect(jobs.read(id).status).toBe("completed")
    expect(jobs.read(id).output).toBe("second")
  })
```

`packages/subagent/test/persist.test.ts` — append to the M8 describe:

```ts
  it("restoreState maps waiting entries to error (interrupted by resume)", () => {
    const fresh = makeState()
    const snap: SubagentStateSnapshot = {
      formatVersion: 1,
      jobs: [],
      agentTable: [{ path: "root/w", status: "waiting", mailbox: [] }],
      roles: [],
    }
    restoreState(fresh, snap)
    expect(fresh.table.get("root/w")?.status).toBe("error")
  })
```

`packages/subagent/test/child.test.ts` — update line 60 (`entry.status` "completed" → "waiting"; line 61 job "completed" STAYS), and extend the first M8 test to assert the agent is registered:

```ts
    expect(table.get("root/helper")?.status).toBe("waiting")  // was "completed"
    expect(entry?.session.header).toMatchObject({ ... })       // existing
    expect(agents.get(sessionId!)).toBeDefined()               // NEW: agent retained in the registry
```

(The test's `spawnChild` call gains `agents` in its options — see Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — `agents` not in deps/options; "waiting" not a valid ChildStatus; re-activation no-op.

- [ ] **Step 3: Implement**

`packages/subagent/src/agent-table.ts`:

```ts
export type ChildStatus = "running" | "waiting" | "completed" | "killed" | "error"
export interface ChildAgentEntry {
  path: string
  status: ChildStatus
  session: ReturnType<typeof createSession>
  controller: AbortController
  finalText?: string
  error?: string
  mailbox: string[]
  jobId?: string
  unmount?: () => void
  sessionId?: string
  roleName?: string
  followupChain?: Promise<void>
  lastInboxSeq?: number
}
```

`packages/subagent/src/jobs.ts` — replace `updateJob`:

```ts
    updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output">>) {
      const rec = records.get(id)
      if (!rec) return
      if (rec.terminal && patch.status !== "running") return
      if (patch.status === "running") rec.terminal = false
      if (patch.status !== undefined) rec.status = patch.status
      if (patch.output !== undefined) rec.output = patch.output
      if (rec.status !== "running") rec.terminal = true
    },
```

`packages/subagent/src/persist.ts` — in `restoreState`'s agent-table loop, map waiting like running:

```ts
    const wasRunning = entry.status === "running" || entry.status === "waiting"
    const status: ChildStatus = wasRunning ? "error" : entry.status
```

`packages/subagent/src/tools.ts` — `SubagentToolDeps` gains `agents: AgentRegistry` (import the type from `@i-harness/core-agent`).

`packages/subagent/src/index.ts` — create the registry and pass it:

```ts
  const agents = createAgentRegistry()
  const tools = createSubagentTools({
    table, jobs, roles, parentRegistry, parentSession: opts.parentSession, parentCtx: ctx,
    parentModel: opts.parentModel, providers: opts.providers, exec: opts.exec,
    agents,
    ...(opts.persist ? { childSessions: { coordinator: opts.persist.coordinator, parentSessionId: opts.persist.parentSessionId } } : {}),
  })
```

`packages/subagent/src/child.ts` — retain the agent + settle to waiting (per spec §2.2; the `SpawnOptions` gains `agents: AgentRegistry`):

```ts
  const controller = new AbortController()
  const agent = createAgent(childCtx, {
    session: childSession, tools: childReg, model,
    systemPrompt: opts.role.systemPrompt, signal: controller.signal,
  })
  if (sessionId !== undefined) opts.agents.register(sessionId, agent)
  opts.table.add(childPath, {
    path: childPath, status: "running", session: childSession, controller, mailbox: [], jobId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    roleName: opts.role.name,
    unmount: () => childCtx.scope.unmount(),
  })
  agent.run(opts.message, controller.signal).then(
    (result) => {
      const e = opts.table.get(childPath)
      if (e) { e.status = "waiting"; e.finalText = result.finalText }
      opts.jobs.updateJob(jobId, { status: "completed", output: result.finalText })
    },
    (err) => {
      const aborted = controller.signal.aborted
      const e = opts.table.get(childPath)
      if (e) {
        // An interrupted turn leaves the child ALIVE (waiting) so followups still work.
        e.status = "waiting"
        e.error = aborted ? "aborted" : (err instanceof Error ? err.message : String(err))
      }
      opts.jobs.updateJob(jobId, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
    },
  )
```

Update the existing `child.test.ts` spawnChild calls to pass `agents: createAgentRegistry()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS — updated child/persist/jobs tests + all existing. Then `pnpm -r test` (the CLI suite must still pass — grep for any remaining `entry.status === "completed"` assertions on LIVE children and update them to `"waiting"`; job-status assertions stay).

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src packages/subagent/test
git commit -m "feat: retain child agents and add waiting lifecycle (P3)"
```

---

### Task 3: subagent P3b — the serialized followup driver

**Files:**
- Modify: `packages/subagent/src/tools.ts` (driveFollowups + followup_task wake + close_agent unregister)
- Test: `packages/subagent/test/tools.test.ts`

**Interfaces:**
- Consumes: `ChildAgentEntry.followupChain`/`lastInboxSeq` (Task 2); `Agent.followup` (Task 1); `append` + `subagent/inbox` (M8).
- Produces: `followup_task` wakes the child; `close_agent` unregisters; `interrupt_agent` targets the current turn's controller.

- [ ] **Step 1: Write the failing test**

Append to `packages/subagent/test/tools.test.ts` (reuse the existing harness that builds the 11 tools with a table + jobs):

```ts
  it("followup_task drives a turn on the child (appends inbox + wakes the driver)", async () => {
    // Build a table entry with a spy-mirror session (createSession with a spy hook)
    // whose sessionId is registered in an AgentRegistry holding a fake agent whose
    // followup resolves { finalText: "ok2", turns: 2, reasoning: [] }.
    // Call followup_task.execute({ target, message: "again" }).
    // Assert: { delivered: true }; the spy observed a subagent/inbox event with the
    // message; the fake agent's followup was called with "again"; the entry status
    // is "waiting" after the driver settles (await the entry.followupChain).
  })

  it("close_agent unregisters the child agent from the registry", async () => {
    // entry with sessionId registered in the registry; close_agent.execute →
    // registry.get(sessionId) is undefined and the entry is removed.
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — followup_task doesn't wake; close doesn't unregister.

- [ ] **Step 3: Implement**

In `packages/subagent/src/tools.ts`, add the driver helper and wire it:

```ts
import { append, createSession } from "@i-harness/core-session"
import { createAgent, type AgentRegistry } from "@i-harness/core-agent"

// Drain all unconsumed durable inbox events as serialized turns on the child.
function driveFollowups(deps: SubagentToolDeps, entry: ChildAgentEntry, sessionId: string): Promise<void> {
  const prev = entry.followupChain ?? Promise.resolve()
  const next = prev.then(async () => {
    const agent = deps.agents.get(sessionId)
    if (!agent) return
    const pending = entry.session.events.filter(
      (e): e is Extract<SessionEvent, { type: "subagent/inbox" }> =>
        e.type === "subagent/inbox" && (e.seq ?? 0) > (entry.lastInboxSeq ?? -1),
    )
    for (const ev of pending) {
      if (!deps.table.get(entry.path)) return // closed mid-drain → stop
      entry.lastInboxSeq = ev.seq ?? 0
      entry.status = "running"
      entry.controller = new AbortController() // fresh signal per turn (interrupt targets this)
      if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: "running", output: "" })
      try {
        const result = await agent.followup(ev.message, entry.controller.signal)
        entry.status = "waiting"
        entry.finalText = result.finalText
        if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: "completed", output: result.finalText })
      } catch (err) {
        const aborted = entry.controller.signal.aborted
        entry.status = "waiting"
        entry.error = aborted ? "aborted" : (err instanceof Error ? err.message : String(err))
        if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      }
    }
  })
  entry.followupChain = next
  return next
}
```

`followup_task` execute becomes (append + wake):

```ts
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      // Durable inbox + wake: queue the message and drive a turn on the child.
      append(entry.session, { type: "subagent/inbox", messageId: randomUUID(), message: args.message })
      entry.mailbox.push(args.message)
      if (entry.sessionId) void driveFollowups(deps, entry, entry.sessionId)
      return { delivered: true }
    },
```

`close_agent` execute gains the unregister (after `table.remove`):

```ts
      if (entry.sessionId) deps.agents.remove(entry.sessionId)
```

`interrupt_agent` stays as-is (`entry.controller.abort()` — the driver's catch returns the child to `waiting`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS — existing + the 2 new tests. Then `pnpm --filter @i-harness/subagent typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/tools.ts packages/subagent/test/tools.test.ts
git commit -m "feat: serialized followup driver consuming the durable inbox (P3)"
```

---

### Task 4: P4 cold resume — roleName + resume_agent rebuild

**Files:**
- Modify: `packages/subagent/src/persist.ts` (`DurableAgentEntry.roleName` + snapshot/restore)
- Modify: `packages/subagent/src/tools.ts` (`resume_agent`)
- Test: `packages/subagent/test/persist.test.ts`, `packages/subagent/test/tools.test.ts`

**Interfaces:**
- Consumes: `roleName` (Task 2 added the field on ChildAgentEntry); the M8 loaded session; `createAgent` (Task 1); `driveFollowups` (Task 3).
- Produces: `resume_agent` rebuilds the child from the persisted session + role registry.

- [ ] **Step 1: Write the failing test**

`packages/subagent/test/persist.test.ts` — append:

```ts
  it("snapshotState/restoreState round-trip the child roleName", () => {
    const s = makeState()
    s.table.add("root/helper", {
      path: "root/helper", status: "waiting", session: (() => { const x = { formatVersion: 1, events: [] as never[] }; return x })(),
      controller: new AbortController(), mailbox: [], sessionId: "child-abc", roleName: "research",
    })
    const snap = snapshotState(s)
    expect(snap.agentTable[0]?.roleName).toBe("research")
    const fresh = makeState()
    restoreState(fresh, snap)
    expect(fresh.table.get("root/helper")?.roleName).toBe("research")
  })
```

`packages/subagent/test/tools.test.ts` — append (reuse the harness):

```ts
  it("resume_agent rebuilds the child from the loaded session + role", async () => {
    // Entry in the table with sessionId "child-abc", roleName "general",
    // session = the loaded durable session (M8 mirror), status "error".
    // Registry empty. roles has "general".
    // Call resume_agent.execute({ target: "root/helper" }).
    // Assert: { resumed: true }; the entry status is "waiting"; the registry
    // now has the rebuilt agent; a followup_task to the child drives a turn
    // (fake agent via registry — assert followup called).
  })

  it("resume_agent on a path with no entry errors", async () => {
    await expect(resumeTool.execute({ target: "root/ghost" })).rejects.toThrow(/unknown subagent/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — roleName not persisted; resume_agent is still the fresh-session stub.

- [ ] **Step 3: Implement**

`packages/subagent/src/persist.ts` — `DurableAgentEntry` gains `roleName?: string`; in `snapshotState` map `...(e.roleName !== undefined ? { roleName: e.roleName } : {})`; in `restoreState` install `...(entry.roleName !== undefined ? { roleName: entry.roleName } : {})`.

`packages/subagent/src/tools.ts` — replace the `resume_agent` stub per spec §3.2 (model resolution identical to spawnChild; `createAgent`; registry register; `driveFollowups`). The imports needed: `createAgent` (already via child.ts? no — import from `@i-harness/core-agent`), `createToolRegistry` (from `@i-harness/core-tools`), `buildModelClient` (from `@i-harness/provider`). The entry must exist:

```ts
  const resumeTool: Tool<{ target: string }, { resumed: boolean }> = {
    name: "resume_agent",
    description: "Re-activate a previously settled subagent from its persisted session; queued inbox messages are processed.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const existing = deps.table.get(args.target)
      if (!existing) throw new Error(`unknown subagent: ${args.target}`)
      if (existing.status === "running") throw new Error(`subagent already running: ${args.target}`)
      if (existing.sessionId) {
        const resident = deps.agents.get(existing.sessionId)
        if (resident) {
          // already resident (e.g. a waiting child) → just re-drive pending inbox
          void driveFollowups(deps, existing, existing.sessionId)
          return { resumed: true }
        }
      }
      const role = deps.roles.get(existing.roleName ?? "general")
      if (!role) throw new Error(`unknown role: ${existing.roleName}`)
      const childCtx = deps.parentCtx.scope.mount()
      const childReg = createToolRegistry(childCtx)
      for (const name of role.tools) {
        const tool = deps.parentRegistry.get(name)
        if (tool) childReg.register(tool)
      }
      // model resolution identical to spawnChild: role.model → provider → buildModelClient; else parent
      let model = deps.parentModel
      if (role.model) {
        const profile = deps.providers.get(role.model.provider)
        if (!profile) throw new Error(`role '${role.name}' references unknown provider '${role.model.provider}'`)
        model = buildModelClient(profile, role.model.model, role.model.extra)
      }
      const controller = new AbortController()
      const agent = createAgent(childCtx, {
        session: existing.session, tools: childReg, model,
        systemPrompt: role.systemPrompt, signal: controller.signal,
      })
      if (existing.sessionId) deps.agents.register(existing.sessionId, agent)
      existing.status = "waiting"
      existing.controller = controller
      existing.unmount = () => childCtx.scope.unmount()
      if (existing.sessionId) void driveFollowups(deps, existing, existing.sessionId)
      return { resumed: true }
    },
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS — existing + the 3 new tests. Then `pnpm --filter @i-harness/subagent typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/persist.ts packages/subagent/src/tools.ts packages/subagent/test
git commit -m "feat: cold-resume subagent from persisted session (P4)"
```

---

### Task 5: CLI e2e — followup + resume-continue

**Files:**
- Test: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: e2e proof of the M9 §5.3 gates.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/test/cli.test.ts` (reuse the M8 e2e patterns — `pollUntil`, `createSessionCoordinator`, `createJsonlBackend`, the call-counter `ModelClient`):

```ts
describe("headless CLI multi-turn subagents (M9)", () => {
  it("followup_task drives a second turn on the child's durable session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m9-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      // Deterministic driver: n=0 spawn_agent (fork none), n=2 followup_task,
      // every other stream (child turns + main) is text.
      let calls = 0
      const model: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper", fork_turns: "none" } } }
            yield { type: "end" }
            return
          }
          if (n === 2) {
            yield { type: "tool_call", call: { name: "followup_task", args: { target: "root/helper", message: "again" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "ok" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("delegate", { workspace: dir, approveAll: true, sessionId: id, coordinator, model })
      expect(result.exitCode).toBe(0)
      const childId = (await coordinator.list()).find((sid) => sid.startsWith("child-"))
      expect(childId).toBeDefined()
      const { session } = await coordinator.load(childId!)
      // Two turns (initial + followup): two user messages, no fork seed.
      const userMessages = session.events.filter((e) => e.type === "user/message")
      expect(userMessages.map((e) => e.text)).toEqual(["do it", "again"])
      expect(session.events.filter((e) => e.type === "turn/start")).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("resume_agent cold-resumes a child and continues the conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m9-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      // Run 1: spawn (fork none) + followup → child log has 2 turns.
      let calls = 0
      const run1Model: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper", fork_turns: "none" } } }
            yield { type: "end" }
            return
          }
          if (n === 2) {
            yield { type: "tool_call", call: { name: "followup_task", args: { target: "root/helper", message: "again" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "ok" }
          yield { type: "end" }
        },
      }
      const first = await runHeadless("delegate", { workspace: dir, approveAll: true, sessionId: id, coordinator, model: run1Model })
      expect(first.exitCode).toBe(0)
      const childId = (await coordinator.list()).find((sid) => sid.startsWith("child-"))
      expect(childId).toBeDefined()
      // Run 2: resume → resume_agent then followup_task → child log gains a 3rd turn.
      let resumeCalls = 0
      const run2Model: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = resumeCalls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "resume_agent", args: { target: "root/helper" } } }
            yield { type: "end" }
            return
          }
          if (n === 1) {
            yield { type: "tool_call", call: { name: "followup_task", args: { target: "root/helper", message: "third" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "ok" }
          yield { type: "end" }
        },
      }
      const second = await runHeadless("continue", { workspace: dir, approveAll: true, resumeSessionId: id, coordinator, model: run2Model })
      expect(second.exitCode).toBe(0)
      const { session } = await coordinator.load(childId!)
      const userMessages = session.events.filter((e) => e.type === "user/message")
      expect(userMessages.map((e) => e.text)).toEqual(["do it", "again", "third"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/cli test`
Expected: FAIL — followup_task doesn't drive a turn yet (before Tasks 1-4 the child log has 1 turn); resume_agent is the fresh-session stub.

> Note: run this task AFTER Tasks 1-4 are committed; if the tests already pass because the previous tasks landed, adjust the expected red to the resume-continue assertion only, or rely on the commit-order discipline. The point is the e2e proves the §5.3 gates.

- [ ] **Step 3: Run the M9 e2e + full CLI suite**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS — 25 existing (incl. M8) + 2 new M9 e2e. Run the M9 block twice more for determinism: `pnpm --filter @i-harness/cli test -t "multi-turn subagents"` ×2 (2/2 each).

- [ ] **Step 4: Typecheck + full gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/test/cli.test.ts
git commit -m "test: e2e followup and cold-resume continuation (M9)"
```

---

### Task 6: Full acceptance verification

**Files:** None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass (core-agent ~12, subagent ~41, cli ~27, plus every existing package).

- [ ] **Step 2: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → the 5 implementation commits.

- [ ] **Step 3: Self-review spec coverage**

Verify against `docs/superpowers/specs/2026-08-18-i-harness-m9-subagent-multiturn-design.md`:
- §1 core-agent (runTurn, run/followup, Agent, createAgentRegistry; run contract unchanged) — Task 1.
- §2 subagent P3 (deps.agents, spawnChild retain + waiting, followup driver, lifecycle, jobs re-activation) — Tasks 2-3.
- §3 P4 (roleName, resume_agent rebuild) — Task 4.
- §4 data flow — Tasks 1-5.
- §5 tests (core-agent, subagent, CLI e2e) — Tasks 1-5.
- §6 out of scope (P5 ownership, descriptor/approval/depth, job full upgrade, persistent loop, tool-surface migration, no bumps) — NOT implemented. Confirm `CURRENT_FORMAT_VERSION` and `SCHEMA_VERSION` unchanged.

Report: M9 complete — subagents are multi-turn (followup_task drives serialized turns on the durable session) and cold-resumable (resume_agent rebuilds from the persisted session + role); the main agent's run() contract is untouched. No bun, no new external deps, no version bumps.
