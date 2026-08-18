# I-harness M9 — multi-turn subagent driver + cold resume — Design Spec

Date: 2026-08-18
Status: Approved by user (brainstorming: inbox-driven on-demand turns over a full persistent-loop port; core-agent gets a shared turn engine + followup + registry; the three design decisions confirmed — send=queue/followup=wake, `waiting` status, registry in core-agent)
Supersedes: the M3-C `followup_task`/`resume_agent` stubs (queue-only / fresh-session). Builds on M8 (durable child sessions with lineage header + model-hidden `subagent/inbox` events) and M7 (write-behind durability). This is M9 = P3 (multi-turn loop driver + re-drive) + P4 (cold resume) of the dsh continuation port; P5 (ownership/settlement/teardown) stays deferred.

## Purpose

Make i-harness subagents genuinely multi-turn and resumable: a child spawned once can receive follow-up messages and run further turns on the SAME durable session; a closed/restarted child can be cold-resumed from its persisted session and continue the conversation. This requires a moderate core-agent refactor (shared turn engine, `followup`, a session-keyed agent registry) so the subagent tools can re-drive a live child.

Reference: dsh rc.7 `packages/core/agent` (inbox-driven agents, `Agent.followup`, `ctx.agents` registry, cold resume via `agents.resume`) and `packages/subagent/subagent/src/continuation.ts`. dsh is the single authoritative reference (user decision). We deliberately do NOT port dsh's persistent inbox loop (it serves an always-on session-centric host; i-harness's CLI host invokes the main agent once per process) — instead the turn engine is shared and turns are driven on demand, preserving the `run()` contract.

## References (verified)

- **core-agent** (`packages/core-agent/src/index.ts`): `createAgent(ctx, deps)` returns `{ run(task) }`. `run` appends `turn/start` + `user/message`, runs the step loop (model stream → inline tool execution → `step/end`) until no tool calls, appends `turn/end`. `turns` counts STEPS (maxTurns guard, default 20). The loop is buried inside `run` and cannot be reused for a second turn.
- **subagent** (`packages/subagent/src/{child,tools}.ts`): `spawnChild` fires `agent.run(message)` WITHOUT retaining the agent object; `send_message`/`followup_task` append `subagent/inbox` events (M8) + mailbox; nothing consumes the inbox; `interrupt_agent` aborts `entry.controller` (permanent); `resume_agent` creates a FRESH session (stub); `close_agent` aborts + unmounts + kills the job + removes the entry.
- **M8** (`packages/subagent/src/{child,persist,agent-table}.ts`, `apps/cli/src/run.ts`): child sessions are durable (`child-<uuid>`, lineage header `{parentSession, seedLength, origin:"subagent", delegationDepth:1}`, mirrored through the M7 write-behind); `DurableAgentEntry` has `sessionId?`; `--resume` loads child logs into live mirror sessions.
- **jobs** (`packages/subagent/src/jobs.ts`): `updateJob` is a silent no-op once a job is terminal (`if (!rec || rec.terminal) return`).

## Global Constraints (binding)

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new external dependencies.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **`run(task)` contract UNCHANGED** — `runHeadless` and the main-agent path are byte-identical in behavior (the shared turn engine preserves the event sequence and the step counting).
- No `CURRENT_FORMAT_VERSION` bump (no session-event vocabulary change; `subagent/inbox` already exists from M8). No `SCHEMA_VERSION` bump.
- The 11 tool NAMES and their existing return shapes stay. `send_message` = queue only; `followup_task` = queue + wake.
- Touch `packages/core-agent/`, `packages/subagent/`, `packages/exec/` (jobs `updateJob` re-activation — one-line semantics change, see §3.5).
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.

## §1 core-agent refactor (P3 foundation)

### 1.1 Shared turn engine

`createAgent` returns an `Agent` with `run` AND `followup`, both delegating to one shared turn runner. The step loop is EXTRACTED verbatim from the current `run` body:

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
      // ... the rest of the current step loop verbatim (deriveMessages →
      // assertMessagesFromLog → request → stream → tool execute → step/end),
      // replacing `deps.signal?.aborted` checks with `abort?.aborted`.
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
```

Behavior preserved: a single `run` produces exactly the events and step count of today's loop. `turns` remains the step counter (per-call `AgentResult.turns` reflects the lifetime count).

### 1.2 Agent registry (`packages/core-agent/src/index.ts`)

```ts
export interface AgentRegistry {
  register(sessionId: string, agent: Agent): void
  get(sessionId: string): Agent | undefined
  remove(sessionId: string): void
  entries(): Map<string, Agent>
}

export function createAgentRegistry(): AgentRegistry
```

Map-backed, no disposal semantics (agents own their lifecycle; the registry is an address book for the subagent driver and future hosts).

## §2 subagent P3 — multi-turn driver

### 2.1 Wiring

- `SubagentToolDeps` gains `agents: AgentRegistry`.
- `registerSubagent` creates `const agents = createAgentRegistry()` and passes it into `createSubagentTools`.
- `SubagentToolDeps` gains a per-composition followup driver (see §2.3) shared by `followup_task`.

### 2.2 spawnChild retains the agent

`spawnChild` becomes agent-retaining:

```ts
  const controller = new AbortController()
  const agent = createAgent(childCtx, {
    session: childSession, tools: childReg, model,
    systemPrompt: opts.role.systemPrompt, signal: controller.signal,
  })
  if (sessionId !== undefined) opts.agents.register(sessionId, agent)
  opts.table.add(childPath, { path: childPath, status: "running", session: childSession, controller, mailbox: [], jobId, ...(sessionId ? { sessionId } : {}), unmount: () => childCtx.scope.unmount() })
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

### 2.3 The followup driver (per child, serialized)

A per-child serialization chain lives on the agent-table entry (a non-durable live field) and is driven by `followup_task`:

```ts
// on the ChildAgentEntry (live-only, NOT in the M6 snapshot):
followupChain?: Promise<void>          // serialization: one turn at a time
lastInboxSeq?: number                  // consumption cursor: inbox events > this are unconsumed
```

`followup_task` execute:

```ts
  const entry = deps.table.get(args.target)
  if (!entry) throw new Error(`unknown subagent: ${args.target}`)
  const messageId = randomUUID()
  append(entry.session, { type: "subagent/inbox", messageId, message: args.message })
  entry.mailbox.push(args.message)
  if (entry.sessionId) void driveFollowups(deps, entry, entry.sessionId)
  return { delivered: true }
```

`driveFollowups` drains ALL unconsumed inbox events as serialized turns:

```ts
function driveFollowups(deps, entry, sessionId): Promise<void> {
  const prev = entry.followupChain ?? Promise.resolve()
  const next = prev.then(async () => {
    const agent = deps.agents.get(sessionId)
    if (!agent) return
    const pending = entry.session.events.filter(
      (e): e is Extract<SessionEvent, { type: "subagent/inbox" }> =>
        e.type === "subagent/inbox" && (e.seq ?? 0) > (entry.lastInboxSeq ?? -1),
    )
    for (const ev of pending) {
      if (!deps.table.get(entry.path)) return   // closed mid-drain → stop
      entry.lastInboxSeq = ev.seq ?? 0
      entry.status = "running"
      entry.controller = new AbortController()  // fresh signal per turn (interrupt targets this)
      deps.jobs.updateJob(entry.jobId!, { status: "running", output: "" })  // re-open (see §3.5)
      try {
        const result = await agent.followup(ev.message, entry.controller.signal)
        entry.status = "waiting"
        deps.jobs.updateJob(entry.jobId!, { status: "completed", output: result.finalText })
      } catch (err) {
        const aborted = entry.controller.signal.aborted
        entry.status = "waiting"  // interrupted turn → alive; genuine failure also returns to waiting with error recorded
        entry.error = aborted ? "aborted" : (err instanceof Error ? err.message : String(err))
        deps.jobs.updateJob(entry.jobId!, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      }
    }
  })
  entry.followupChain = next
  return next
}
```

### 2.4 Lifecycle + status

- `ChildStatus` gains `"waiting"` (quiescent-alive between turns).
- `spawnChild` initial run: `running` → `waiting` on completion (NOT `completed`).
- `followup` turns: `running` → `waiting`.
- `interrupt_agent`: aborts the CURRENT turn's controller (`entry.controller`); the child returns to `waiting` (error field records `"aborted"`). The next followup creates a fresh controller.
- `close_agent`: unchanged (abort current turn + unmount + kill job + remove entry + `agents.remove(sessionId)`).
- `wait_agent`: waits for NO entry in `running` state (a `waiting` child is not running → wait returns).
- `restoreState` (M6): `running` → `error` AND `waiting` → `error` ("interrupted by resume" — the process is gone).

### 2.5 jobs re-activation (one-line semantics change, `packages/subagent/src/jobs.ts`)

To make followup turns observable via `job_output`, `updateJob` must allow re-opening a terminal job:

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

This is the minimal change needed for the driver; the full job-service upgrade stays a later roadmap item.

## §3 P4 cold resume

### 3.1 `DurableAgentEntry.roleName` (M6 snapshot)

`DurableAgentEntry` gains `roleName?: string`; `spawnChild` records it (`opts.role.name`); `snapshotState`/`restoreState` round-trip it. Needed to rebuild the agent (systemPrompt/tools/model) on resume.

### 3.2 `resume_agent` rebuilds from the persisted session

`resume_agent` replaces the fresh-session stub:

```ts
  const existing = deps.table.get(args.target)
  if (existing && existing.status === "running") throw new Error(`subagent already running: ${args.target}`)
  const path = args.target
  const roleName = existing?.roleName
  if (existing?.sessionId) {
    const agent = deps.agents.get(existing.sessionId)
    if (agent) {
      // already resident (e.g. a waiting child) → just re-drive pending inbox
      if (existing.sessionId) void driveFollowups(deps, existing, existing.sessionId)
      return { resumed: true }
    }
  }
  // cold resume: rebuild from the loaded session + the role registry
  const role = deps.roles.get(roleName ?? "general")
  if (!role) throw new Error(`unknown role: ${roleName}`)
  const childCtx = deps.parentCtx.scope.mount()
  const childReg = createToolRegistry(childCtx)
  for (const name of role.tools) {
    const tool = deps.parentRegistry.get(name)
    if (tool) childReg.register(tool)
  }
  // model resolution identical to spawnChild (child.ts): role.model → provider
  // profile → buildModelClient; else inherit deps.parentModel.
  let model = deps.parentModel
  if (role.model) {
    const profile = deps.providers.get(role.model.provider)
    if (!profile) throw new Error(`role '${role.name}' references unknown provider '${role.model.provider}'`)
    model = buildModelClient(profile, role.model.model, role.model.extra)
  }
  const controller = new AbortController()
  const agent = createAgent(childCtx, {
    session: existing!.session, tools: childReg, model,
    systemPrompt: role.systemPrompt, signal: controller.signal,
  })
  if (existing!.sessionId) deps.agents.register(existing!.sessionId, agent)
  existing!.status = "waiting"
  existing!.controller = controller
  existing!.unmount = () => childCtx.scope.unmount()
  if (existing!.sessionId) void driveFollowups(deps, existing!, existing!.sessionId)
  return { resumed: true }
```

Requirements: the entry MUST already exist in the table (restored by M8's resume-load with the loaded durable session) and carry `roleName` (M6 snapshot). A path with NO entry errors with `unknown subagent` — a child REMOVED by `close_agent` is not resumable in M9 (its durable session is orphaned; the parent must not close a child it intends to resume).

## §4 Data flow

### Spawn + followup
```
spawn_agent ──> spawnChild (async): create child session (M8) + agent + registry
  └─ agent.run(message, controller.signal) [turn 1] ──> status waiting
followup_task ──> append subagent/inbox (M8) + driveFollowups
  └─ [chain] turn 2..N: status running → agent.followup(message, fresh controller.signal) → status waiting
  └─ job re-opened (running → completed with finalText)
interrupt_agent ──> abort current controller ──> child returns to waiting (error "aborted")
close_agent ──> abort + unmount + kill job + agents.remove + table.remove
```

### Cold resume
```
--resume ──> M8: load child logs into entry.session (mirror) + M6 snapshot (sessionId, roleName)
resume_agent ──> rebuild agent on entry.session + registry + driveFollowups (drain pending inbox)
```

## §5 Testing

### 5.1 core-agent
- `run(task)` produces the SAME events + step count as before (existing tests unchanged).
- `followup(message)` runs a second complete turn on the same session: the log gains `[turn/start, user/message(message), ..., turn/end]`; `AgentResult.finalText` = the followup's last message.
- `maxTurns` guard spans both turns (a run + followup sharing the step budget).
- per-call `signal` aborts the current turn; a fresh signal allows a subsequent turn.
- `createAgentRegistry` register/get/remove/entries.

### 5.2 subagent
- `spawnChild` registers the agent under the child sessionId and settles the entry to `waiting` after the initial run.
- `followup_task` appends the inbox event AND drives a turn: a fake coordinator observes the followup's session events (user/message + turn) appended through the mirror.
- Serialization: two rapid followups run one-after-another (deterministic via the chain).
- `interrupt_agent` aborts the current turn; the child returns to `waiting`; a later followup succeeds (fresh controller).
- `close_agent` removes the entry AND unregisters the agent.
- `restoreState` maps `waiting` → `error` ("interrupted by resume").
- `updateJob` re-activation: terminal `completed` job re-opened by `{ status: "running" }`, then `completed` again with new output.

### 5.3 CLI e2e (apps/cli/test/cli.test.ts)
- **Followup e2e**: a run where the main agent spawns a child then `followup_task`s it — after the run, the child session log contains TWO turns (the initial + the followup) with the followup's user message; `job_output` of the child shows the followup's final text.
- **Resume-continue e2e**: run (spawn + followup) → `--resume` → `resume_agent` on the child → `followup_task` again → the child session log gains a THIRD turn continuing the same conversation.
- All existing M3-C/M6/M8 CLI tests pass (status assertions updated: a settled child is now `waiting`, not `completed`).

## §6 Out of Scope

- **Ownership/settlement/teardown machinery (P5)**: activation state machine, `ownedChildren` graph, settlement notices to the parent, scoped drain — later.
- **`subagent/descriptor` event folding, delegated approval `'never'`, depth budget enforcement/maxDepth** — later.
- **Full job-service upgrade** (owner fencing, producer hooks, completion listeners, `stopping` status) — later; M9 only adds the minimal `updateJob` re-activation.
- **Persistent inbox loop** (dsh `ReactLoopAgent`) — deliberately not ported (CLI host).
- **Tool-surface migration** (codex-style names stay). Front ends deferred per roadmap.
- **No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps.**
