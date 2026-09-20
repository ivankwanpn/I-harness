import { describe, expect, it, vi } from "vitest"

/** Poll `cond` (the projection settles asynchronously — the child's abort
 * path lands after the gate release). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (cond()) return
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met within budget")
  }
}
import { append, createSession, type SessionEvent } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createSessionExecutor, type AgentConfig, type AgentDeps } from "@i-harness/core-agent"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { McpMountDeps, McpServerConfig, McpServerStatusEvent } from "@i-harness/mcp-client"
import { approxTokens } from "@i-harness/compaction"
import { createTelemetry, type TelemetryEvent } from "@i-harness/telemetry"
import type { SubagentRole } from "@i-harness/subagent"
import { createSessionAssembly, ModelUnavailableError, type AssemblyOptions } from "../src/assembly.ts"

// ── Observation seams for the two wirings the M33/M56/M57 cases below cover ──
// Neither has a read-back on the assembly handle: the overhead estimate exists
// only as the config the assembly hands `createAgent`, and the auth-refresh
// binder only as the config it hands `mountMcpClient`. Both wrappers are
// PASS-THROUGH recorders — they capture the call and then delegate (or hand
// back an inert handle), so every other case in this file still runs against
// the real implementations.
const agentCalls = vi.hoisted(() => ({ deps: [] as (AgentDeps & AgentConfig)[] }))
vi.mock("@i-harness/core-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@i-harness/core-agent")>()
  return {
    ...actual,
    createAgent: (ctx: Parameters<typeof actual.createAgent>[0], deps: Parameters<typeof actual.createAgent>[1]) => {
      agentCalls.deps.push(deps)
      return actual.createAgent(ctx, deps)
    },
  }
})

type CapturedMount = { config: McpServerConfig; deps?: McpMountDeps }
const mcpMounts = vi.hoisted(() => ({ calls: [] as CapturedMount[] }))
vi.mock("@i-harness/mcp-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@i-harness/mcp-client")>()
  return {
    ...actual,
    // The real mount dials the server and a live OAuth AS is out of scope here;
    // the CONFIG the assembly built is the object under test, so record it and
    // hand back an inert handle (dispose only ever calls `unmount`).
    mountMcpClient: async (
      _ctx: unknown,
      _tools: unknown,
      config: McpServerConfig,
      deps?: McpMountDeps,
    ): Promise<{ serverName: string; unmount(): Promise<void> }> => {
      mcpMounts.calls.push({ config, deps })
      return { serverName: config.serverName, unmount: async () => {} }
    },
  }
})

describe("createSessionAssembly", () => {
  it("omitted model policy refuses an assembly without a client", async () => {
    await expect(createSessionAssembly({
      workspace: process.cwd(),
    })).rejects.toThrow(ModelUnavailableError)
  })

  it("required model policy refuses an assembly without a client", async () => {
    await expect(createSessionAssembly({
      workspace: process.cwd(),
      modelPolicy: "required",
    })).rejects.toThrow(ModelUnavailableError)
  })

  it("test-mock policy is an explicit test-only opt in", async () => {
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      modelPolicy: "test-mock",
      mockCycles: true,
    })
    try {
      await expect(assembly.agent.run("hello")).resolves.toMatchObject({ finalText: "ok" })
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("composes an agent and a session and disposes cleanly with an explicit test model", async () => {
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      sessionId: "s1",
      modelPolicy: "test-mock",
    })
    expect(assembly.session.events).toEqual([])
    expect(assembly.agent).toBeDefined()
    expect(assembly.model).toBeDefined()
    await assembly.dispose()
  }, 30_000)

  it("runs one agent turn with the explicit test mock", async () => {
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      sessionId: "s1",
      modelPolicy: "test-mock",
    })
    const result = await assembly.agent.run("hello")
    expect(result.finalText).toBeDefined()
    expect(assembly.session.events.length).toBeGreaterThan(0)
    await assembly.dispose()
  }, 30_000)

  it("M31 T3: a resolved contextWindow feeds the M20 budget ladder (over-budget session fails closed)", async () => {
    const seeded = createSession(() => {})
    // ~600 chars ≈ ~150 tokens — over a window-50 budget (45) at step 1
    append(seeded, { type: "user/message", text: "z".repeat(600) })
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session: seeded,
      contextWindow: 50,
      model: createMockClient([{ role: "assistant", text: "never reached" }]),
    })
    try {
      const executor = createSessionExecutor({ session: seeded, agent: assembly.agent, inbox: assembly.inbox })
      executor.submit({ tier: "send", text: "go" })
      await expect(executor.drain()).rejects.toThrow(/prompt_too_long/)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("M33: the assembly prices the agent's overhead as systemPrompt/4 + schemas JSON/4 (chars-4 estimator, scheduling-only)", async () => {
    agentCalls.deps.length = 0
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      contextWindow: 200_000,
      compact: { contextWindow: 200_000 },
      model: createMockClient([{ role: "assistant", text: "ok" }]),
    })
    try {
      const deps = agentCalls.deps.at(-1)!
      const prompt = typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt
      const schemas = deps.tools.schemas()
      // The premise the estimate is distinguishable on: the registry the agent
      // received really carries schemas (an empty set would price as "[]").
      expect(schemas.length).toBeGreaterThan(0)
      const overhead = approxTokens(prompt) + approxTokens(JSON.stringify(schemas))
      // The SAME number reaches BOTH count surfaces: the M11 compaction config
      // (no host-supplied `overheadTokens`) ...
      expect(deps.compact?.overheadTokens).toBe(overhead)
      // ... and the M20 budget ladder.
      expect(deps.budget).toEqual({ contextWindow: 200_000, overheadTokens: overhead })
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("M33: a resolved contextWindow with NO host overhead tips the budget ladder (estimate is injected)", async () => {
    // base session ≈ 885 tokens at the first boundary: under a window-1000
    // budget (900) — only the injected overhead estimate trips it.
    const seeded = createSession(() => {})
    for (let i = 0; i < 20; i++) append(seeded, { type: "user/message", text: "x".repeat(160) })
    const noWindow = await createSessionAssembly({
      workspace: process.cwd(),
      session: seeded,
      model: createMockClient([{ role: "assistant", text: "ok" }]),
    })
    try {
      const executor = createSessionExecutor({ session: seeded, agent: noWindow.agent, inbox: noWindow.inbox })
      executor.submit({ tier: "send", text: "go" })
      await executor.drain()
      expect(seeded.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
    } finally {
      await noWindow.dispose()
    }
    // with the window resolved, the estimate (system prompt + tool schemas)
    // charges the ~15-token margin and the run fails closed
    const seeded2 = createSession(() => {})
    for (let i = 0; i < 20; i++) append(seeded2, { type: "user/message", text: "x".repeat(160) })
    const withWindow = await createSessionAssembly({
      workspace: process.cwd(),
      session: seeded2,
      contextWindow: 1_000,
      model: createMockClient([{ role: "assistant", text: "never reached" }]),
    })
    try {
      const executor = createSessionExecutor({ session: seeded2, agent: withWindow.agent, inbox: withWindow.inbox })
      executor.submit({ tier: "send", text: "go" })
      await expect(executor.drain()).rejects.toThrow(/prompt_too_long/)
    } finally {
      await withWindow.dispose()
    }
  }, 60_000)

  it("M33: compactNow binds the agent's compaction seam (manual surface)", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "initial work" })
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session: s,
      model: createMockClient([{ role: "assistant", text: "## Primary Request and Intent\n- " + "work ".repeat(120) }]), // ≥ 500 chars (M34 ⑦c floor)
      compact: { contextWindow: 100_000 },
    })
    try {
      expect(typeof assembly.compactNow).toBe("function")
      const res = await assembly.compactNow()
      expect(res.compacted).toBe(true)
      expect(res.shadowedSeqs).toEqual([0])
      expect(assembly.session.events.slice(-3).map((e) => e.type)).toEqual([
        "compaction/start", "compaction/summary", "compaction/end",
      ])
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("M40 A1: todo_write (session-scoped) + read_image are mounted model-visible", async () => {
    let toolNames: string[] = []
    const spy: ModelClient = {
      async *stream(request: LLMRequest) {
        toolNames = request.tools.map((t) => t.name)
        yield { type: "text/chunk", text: "ok" }
        yield { type: "end" }
      },
    }
    const assembly = await createSessionAssembly({ workspace: process.cwd(), model: spy, sessionId: "a1" })
    try {
      await assembly.agent.run("hi")
      expect(toolNames).toContain("todo_write")
      expect(toolNames).toContain("read_image")
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("M33: compactNow with instructions forwards them to the summarizer prompt", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "kickoff" })
    // M5/D2 changed WHERE the instructions land, so this captures the position
    // rather than just the text. The summarizer now replays the region as real
    // messages and appends the directive as the FINAL user message — that is what
    // makes its call a byte-prefix of the last main request and lets the
    // provider's cache serve the whole conversation. It used to be the only
    // message, so asserting on messages[0] would now be asserting on the
    // replayed conversation instead.
    let first: string | undefined
    let last: string | undefined
    const spy: ModelClient = {
      async *stream(request: LLMRequest) {
        first = request.messages[0]!.content as string
        last = request.messages.at(-1)!.content as string
        yield { type: "text/chunk", text: "summary".repeat(100) } // ≥ 500 chars (M34 ⑦c floor)
        yield { type: "end" }
      },
    }
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session: s,
      model: spy,
      compact: { contextWindow: 100_000 },
    })
    try {
      await assembly.compactNow("keep the constraint X in mind")
      // The instructions reach the summarizer — as the FINAL user message.
      expect(last).toContain("## User instructions")
      expect(last).toContain("keep the constraint X in mind")
      // And the conversation before it is the replayed region, not the directive.
      expect(first).toBe("kickoff")
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("M34: a requested compaction with NO resolvable window is DISABLED and says so", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "initial work" })
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    }
    let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
    try {
      assembly = await createSessionAssembly({
        workspace: process.cwd(),
        session: s,
        model: createMockClient([{ role: "assistant", text: "unused" }]),
        // Requested, but neither `contextWindow` nor a window inside the config.
        compact: { auto: true },
      })
    } finally {
      console.warn = original
    }
    try {
      // The request cannot be honoured, so the engine is absent and the manual
      // surface reports nothing compacted — but the operator was TOLD, which is
      // the part that used to be missing.
      await expect(assembly!.compactNow()).resolves.toEqual({ compacted: false, shadowedSeqs: [] })
      expect(warnings.some((w) => w.includes("auto-compaction is DISABLED"))).toBe(true)
    } finally {
      await assembly!.dispose()
    }
  }, 30_000)

  it("M34: a window carried in the compact config ENABLES auto-compaction (the CLI's shape)", async () => {
    // The positive direction, and it must go through the AUTO path: `compactNow`
    // deliberately bypasses the pressure gate (compaction/src/index.ts calls
    // compactOnce(..., "manual")), so asserting on it would pass no matter which
    // window the engine received. Only a turn proves the engine is wired AND that
    // its window is real.
    const s = createSession()
    append(s, { type: "user/message", text: "work ".repeat(400) }) // ~2000 chars ≈ 500 tokens
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session: s,
      model: createMockClient([
        { role: "assistant", text: "## Primary Request and Intent\n- " + "summary ".repeat(100) },
        { role: "assistant", text: "done" },
      ]),
      // No `contextWindow` here — the window arrives ONLY in the config, which is
      // exactly how the CLI now supplies it.
      compact: { contextWindow: 100, auto: true },
    })
    try {
      const executor = createSessionExecutor({ session: s, agent: assembly.agent, inbox: assembly.inbox })
      executor.submit({ tier: "send", text: "go" })
      await executor.drain()
      expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(true)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("does not duplicate persistence for a host-owned session", async () => {
    const mirrored: SessionEvent[] = []
    const coordinator = {
      enqueue: (_sessionId: string, events: SessionEvent[]) => { mirrored.push(...events) },
      flush: async (_sessionId: string) => {},
    } as unknown as SessionCoordinator
    const sessionId = "mirror-session"
    const session = createSession((ev) => {
      mirrored.push(ev)
    })
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      sessionId,
      session,
      coordinator,
      model: createMockClient([{ role: "assistant", text: "ok" }]),
    })
    try {
      await assembly.agent.run("hello")
      expect(mirrored).toEqual(session.events)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})

// ── M49 Task 12: real per-assembly task projection (spec §8.2) ─────────────

describe("createSessionAssembly — task projection (Task 12)", () => {
  /** Scripted model: the parent turn (whose messages carry only "spawn a
   * helper") first spawns a `helper` subagent through the assembly's own
   * subagent mount and then produces its final text; the CHILD's turns are
   * recognized by their message content ("inspect code") and block on the
   * gate — the entry stays "running" (canCancel) until the test settles it.
   * Routing by message content keeps the ordering robust (the child run's
   * first stream call races the parent's continuation).
   */
  function spawnBlockingModel(): { model: ModelClient; release(): void } {
    let spawned = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const model: ModelClient = {
      async *stream(request: LLMRequest) {
        // The child's requests end with ITS authored task message ("inspect
        // code"); the parent's continuation ends with the spawn tool result.
        const last = request.messages.at(-1)
        const isChild = last?.role === "user" && typeof last.content === "string" && last.content.includes("inspect code")
        if (isChild) {
          await gate
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
    return { model, release: () => release() }
  }

  it("tasks() projects subagent + job + (owner-only) workflow rows; cancelTask routes through the owning registry", async () => {
    const { model, release } = spawnBlockingModel()
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      sessionId: "s1",
      approveAll: true,
      model,
    })
    try {
      // nothing mounted into the registries yet — honest rowless projection
      expect(assembly.tasks()).toEqual([])

      await assembly.agent.run("spawn a helper")

      const rows = assembly.tasks()
      // the subagent row rides the REAL agent-table entry (stable path id;
      // its label is the role name the child was spawned with — "general").
      expect(rows).toContainEqual(expect.objectContaining({
        id: "root/helper",
        parentId: "root",
        group: "subagent",
        label: "general",
        status: "running",
        canCancel: true,
      }))
      // the job row rides the REAL jobs registry (stable job id).
      expect(rows).toContainEqual(expect.objectContaining({
        group: "job",
        status: "running",
        canCancel: true,
      }))

      // cancel through the owning registry: the agent entry's abort channel
      // + its job registry kill (they cannot disagree).
      expect(assembly.cancelTask("root/helper")).toBe("cancellation-requested")
      // let the child's blocked turn settle (it settles as aborted).
      release()
      await waitFor(() => assembly.tasks().find((r) => r.id === "root/helper")?.status === "cancelled")
      expect(assembly.tasks().find((r) => r.id === "root/helper")!.canCancel).toBe(false)
      expect(assembly.cancelTask("root/helper")).toBe("already-finished")

      // unknown id → the existing registry not-found semantics (never a
      // fabricated silent success).
      expect(() => assembly.cancelTask("never-a-task")).toThrow(/unknown/)
    } finally {
      release()
      await assembly.dispose()
    }
  }, 60_000)
})

// ------------------------------------------------------------------ M49 Task 14 (spec §11): default agent prompt composition

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMStreamEvent } from "@i-harness/llm-seam"

/** Real ModelClient double: records every LLMRequest and yields one text chunk
 * then end (the plan's capturingModel fixture contract). */
function capturingModel(): ModelClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  return {
    requests,
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      requests.push(request)
      yield { type: "text/chunk", text: "inspect done" }
      yield { type: "end" }
    },
  }
}

describe("createSessionAssembly — default prompt composition (spec §11)", () => {
  it("uses the I-harness default preset when no override is supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-assembly-prompt-"))
    const model = capturingModel()
    const assembly = await createSessionAssembly({ workspace: dir, model })
    try {
      await assembly.agent.run("inspect")
      const prompt = model.requests[0]!.systemPrompt
      expect(prompt).toContain("I-harness")
      expect(prompt).toContain("verify before claiming completion")
      expect(prompt).not.toContain("Grok")
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("keeps an explicit preset override authoritative", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-assembly-prompt-"))
    const model = capturingModel()
    const assembly = await createSessionAssembly({
      workspace: dir,
      model,
      preset: JSON.stringify({ name: "custom", systemPrompt: "custom-system", tools: [] }),
    })
    try {
      await assembly.agent.run("inspect")
      const prompt = model.requests[0]!.systemPrompt
      expect(prompt).toContain("custom-system")
      expect(prompt).not.toContain("verify before claiming completion")
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})

// ── R-B1 (phase B): the resolved client is ONE handle ───────────────────────
// Spec §4.1 said a session's resolved client has "two consumers, one change
// covers both"; measured, a session's lifetime has EIGHT holders of a resolved
// client — the turn loop, the compaction engine, a CONFIGURED summarization
// model, spawned sub-agents, the guardian, teammates, auto-title, and the
// service's memoised binding. §4.1's own reason for caring is cost ("only
// swapping one leaves the summarizer on the old endpoint — and that is a call
// that costs money"), and the same reason holds verbatim for the other five.
// The handle is how ONE assignment reaches all of them: every holder already
// holds this same object, so none of them is ever re-wired.
describe("createSessionAssembly — the model handle (R-B1)", () => {
  it("a rebound model reaches the handle, and the turn loop reads through it", async () => {
    // The design said "two consumers, one change covers both" — measured, a
    // session's lifetime has EIGHT holders of a resolved client. This test pins
    // the handle itself and the turn loop that reads through it; the per-holder
    // enumeration — the ones no assertion here reaches — is the plan's Task 2.
    const first = capturingModel()
    const second = capturingModel()
    const dir = mkdtempSync(join(tmpdir(), "ih-assembly-handle-"))
    const assembly = await createSessionAssembly({ workspace: dir, model: first })
    try {
      // ⚠ `assembly.model` is the HANDLE, never the injected client — if it
      // were the client, a rebind would have nothing to forward through. So
      // identity is asserted against the handle, not against `first` — and the
      // handle is what EVERY holder was handed, the agent's own deps included,
      // which this file's createAgent capture records at construction.
      const handle = assembly.model
      expect(handle).not.toBe(first)
      expect(agentCalls.deps.at(-1)?.model).toBe(handle)

      assembly.setModel(second)

      // (a) the handle forwards — and its IDENTITY is stable, which is exactly
      // what lets every holder keep working without being re-wired.
      expect(assembly.model).toBe(handle)       // still the SAME handle…
      for await (const _ of assembly.model.stream({ messages: [], tools: [], systemPrompt: "" })) void _
      expect(second.requests).toHaveLength(1)   // …but the request went to the NEW client
      expect(first.requests).toHaveLength(0)

      // (b) the agent the lane runs on reads through the same handle — proven
      // with a REAL turn, not by asserting the agent object exists.
      await assembly.agent.run("go")
      expect(second.requests.length).toBeGreaterThan(1)   // the turn landed on the NEW client
      expect(first.requests).toHaveLength(0)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})

// ── R-B1 (phase B), Task 2: EVERY holder follows a rebind — enumerated ──────
// Task 1 proved the HANDLE; this block proves each HOLDER, one case each, so a
// holder that stops following fails HERE, by name, rather than silently billing
// an old endpoint. "Holder" = a place that captured a resolved client at
// construction (R-B1's table) and will make real, billable requests through it.
// R-B1's table enumerates NINE such places; EIGHT are reachable by the handle
// (rows 1, 2, 3, 5a, 5b, 5c, 6, 7) and the ninth — a CONFIGURED
// `summarizationModel` — is not, so it is Task 3's row and appears here only as
// the exclusion this block's fixtures must avoid.
//
// Each case: build ONE assembly with `first` (this file's own fixtures), REBIND
// the CLIENT half of the model surface with `assembly.setModel(second)` — since
// Task 4 review F-1 the surface has TWO paired mutations (`setModel` and
// `setReasoningEffort`, installed together by the service's `rebindModel`; these
// cases build without an effort, so only the client half moves) — then drive
// exactly one holder and assert ITS request landed on `second`, with
// `first.requests` still empty. The empty first recorder is the control: it is
// the assertion that fails if the holder kept the raw client instead of the
// handle. Cases are separate (rather than one shared assembly) so a targeted
// wiring regression reds only the case whose holder it broke.
//
// Coverage, holder by holder, and where each row is driven:
//
//  1    the agent's turn loop              — case 1  (agent deps, assembly.ts:955 `session, tools, model,`)
//  2+3  the compaction engine              — case 2  (construction core-agent/src/index.ts:142 `model: deps.model,`;
//                                                    its own read compaction/src/index.ts:125)
//  5a   a spawned sub-agent                — case 3  (assembly.ts:802 `parentModel: model,`)
//  5b   the guardian, INHERITED model      — case 4  (assembly.ts:847 `parentModel: model,` → reviewer.ts:149's
//                                                    `deps.model ?? deps.parentModel` — its CONFIGURED model is Task 3's)
//  5c   a team-mate                        — case 5  (assembly.ts:883 `parentModel: model,` → scheduler.ts:204
//                                                    `parentModel: deps.parentModel,`)
//  6    auto-title's model                 — case 6  (assembly.ts:982 `model,` → run.ts:697 `session, model: assembly.model,`)
//  7    the service's dispensed assembly    — "R-B1 holder 7 — the service dispenses the LIVE assembly…" in
//                                             service.test.ts (that file owns the service harness)
//  —    the handle + a manual stream        — Task 1's test above, not repeated here
//  4    a CONFIGURED `summarizationModel`   — Task 3's boundary, deliberately ABSENT from this block's fixtures:
//                                             a configured model WINS over the handle (`config.summarizationModel ?? deps.model`).
//                                             A summarization model in case 2's fixture would make that case assert the REVERSE of shipped behaviour.
//
// DECLARED GAP — auto-title's CALL SITE: case 6 pins the value auto-title reads
// (`assembly.model`, read at call time). The end-to-end drive (`run.ts:697` →
// `maybeAutoTitle` → `session-title/src/index.ts:56`) is NOT driven with a
// rebind by any existing harness: `runHeadless` builds its assembly internally
// and exposes no seam to rebind it mid-run, and this package has no dependency
// edge to `@i-harness/session-title` (adding one for a test would be a new
// dependency, which this task does not take). TWO routes close it, and the
// CHEAPER one needs no production change: an `apps/cli` test that mock-wraps the
// assembly — `vi.mock("@i-harness/session-executor", …)` passing through to the
// real factory and rebinding on the returned object once `agent.run` resolves,
// so `run.ts:697`'s read sees it. That is the pass-through-recorder pattern this
// file already uses for `core-agent` (:31-41), and the mocking precedent exists
// (apps/cli/test/cli.test.ts:102, apps/cli/test/run-flag-routing.test.ts:32).
// The OTHER route is production surface: an `onAssembly`-style hook on
// `HeadlessOptions` (the service already has one — `createSessionService`'s
// hooks, used at apps/cli/src/index.ts:553 `service.onAssembly(`). The mock
// route is the cheaper of the two and is the one to reach for first; neither
// exists today, so the gap is stated here rather than asserted around.
/** In-memory SessionCoordinator for the team case only. The team's spawn path
 * needs durable child sessions, and this package declares no JSONL backend (so
 * no real coordinator is constructible here). Shape copied from the precedent at
 * packages/agent-team/test/lifecycle.test.ts:515 (`const coordinator = {`
 * … `as unknown as SessionCoordinator` at :533): a coordinator double, NOT a
 * model client — the recorder shapes above are untouched. */
function memoryCoordinator(): SessionCoordinator {
  const events = new Map<string, SessionEvent[]>()
  return {
    create: async (meta?: { sessionId?: string }) => {
      const id = meta?.sessionId ?? `mem-${events.size}`
      events.set(id, [])
      return { id }
    },
    append: async (sessionId: string, evs: SessionEvent[]) => { events.get(sessionId)?.push(...evs) },
    enqueue: (sessionId: string, evs: SessionEvent[]) => {
      const list = events.get(sessionId) ?? []
      list.push(...evs)
      events.set(sessionId, list)
    },
    load: async (sessionId: string) => ({ session: { formatVersion: 1, events: [...(events.get(sessionId) ?? [])] } }),
    list: async () => [...events.keys()],
    flush: async () => {},
    close: async () => {},
    putDocument: async () => {},
    getDocument: async () => undefined,
  } as unknown as SessionCoordinator
}

describe("createSessionAssembly — every holder follows a rebind (Task 2, R-B1)", () => {
  /** This file's recording-client shape (`capturingModel`, :462 — the same shape
   * as `recordingModel`, subagent/test/child.test.ts:253) with the replies served
   * by the file's own `createMockClient` cassette — exactly the recorder+cassette
   * composition the pluginAgents fixture's `spawnVia` uses — `async function
   * spawnVia(roleName: string, pluginAgents?: SubagentRole[])` at :1163. Not a fourth fixture: the
   * recorder is `capturingModel`'s and the script is `createMockClient`'s; only
   * the two existing pieces are joined, because these holders are driven by
   * TOOL CALLS and so need scripted replies `capturingModel`'s fixed text cannot give. */
  function scriptedModel(script: MockStep[]): ModelClient & { requests: LLMRequest[] } {
    const requests: LLMRequest[] = []
    const cassette = createMockClient(script)
    return {
      requests,
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        requests.push(request)
        yield* cassette.stream(request)
      },
    }
  }

  it("holder 1 — the agent's turn loop runs on the rebound client", async () => {
    const first = capturingModel()
    // The proof is the SCRIPT: only `second` can produce this finalText — a turn
    // that stayed on `first` would answer "inspect done".
    const second = scriptedModel([{ role: "assistant", text: "turn ran on the rebound client" }])
    const assembly = await createSessionAssembly({ workspace: process.cwd(), model: first })
    try {
      assembly.setModel(second)
      await expect(assembly.agent.run("go")).resolves.toMatchObject({ finalText: "turn ran on the rebound client" })
      expect(second.requests.length).toBeGreaterThan(0)
      expect(first.requests).toHaveLength(0)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("holders 2+3 — the compaction engine follows a rebind, with NO summarizationModel configured", async () => {
    const session = createSession()
    // One user message and nothing else: with the default retention budget
    // (retainTokens 0) the whole surface is shadowable, so compact() has a
    // region to summarize (compaction/src/region.ts selectShadowableRange).
    append(session, { type: "user/message", text: "kickoff ".repeat(20) })
    const first = capturingModel()
    // ≥ 500 chars: the M34 ⑦c minSummaryChars floor, so this is a clean success
    // rather than the degenerate-retry path.
    const second = scriptedModel([{ role: "assistant", text: "## Primary Request and Intent\n- " + "summary ".repeat(80) }])
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session,
      model: first,
      // ⚠ NO `summarizationModel` — deliberately. With one CONFIGURED, the engine
      // keeps it across a rebind (R-B2 — `config.summarizationModel ?? deps.model`,
      // compaction/src/index.ts:125), which is Task 3's boundary. Setting one in
      // THIS fixture would make the assertion below assert the reverse of shipped
      // behaviour.
      compact: { contextWindow: 100_000 },
    })
    try {
      assembly.setModel(second)
      const result = await assembly.compactNow()
      // The holder assertion comes FIRST so it can red on its own line: the
      // summarizer's call is the evidence of BOTH capture sites — the engine
      // CONSTRUCTED from the agent's deps (core-agent/src/index.ts:142
      // `model: deps.model,`) and its own read at compact time
      // (compaction/src/index.ts:125). Exactly one call: the engine's reply was
      // a clean summary, not the degenerate-retry path.
      expect(second.requests).toHaveLength(1)
      expect(first.requests).toHaveLength(0)
      expect(result.compacted).toBe(true)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("holder 5a — a spawned sub-agent inherits the rebound client", async () => {
    const first = capturingModel()
    const second = scriptedModel([
      // the parent's step: spawn, blocking, so the child's turn lands first
      { role: "assistant", toolCalls: [{ name: "spawn_agent", args: { message: "inspect code", task_name: "helper", background: false } }] },
      { role: "assistant", text: "child finished" }, // the child's own turn
      { role: "assistant", text: "parent finished" }, // the parent's continuation
    ])
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      model: first,
      // spawn_agent is approval-gated; absent an answerer the mount is fail-closed
      // (the same option the pluginAgents fixture below uses).
      approveAll: true,
    })
    try {
      assembly.setModel(second)
      // The run is captured, NOT asserted first: under a broken subagent wiring
      // the child answers from `first` and the parent's continuation then eats
      // the child's script step — so a run-level assertion would red first and
      // MASK the holder-specific line below (measured: exactly that, before this
      // reordering).
      const run = await assembly.agent.run("start")
      // The CHILD's request is what this assertion names — only the child
      // carries the general role's prompt, so the parent's own requests on
      // `second` cannot satisfy it.
      expect(second.requests.filter((r) => r.systemPrompt.includes("You are a general-purpose coding agent."))).toHaveLength(1)
      expect(first.requests).toHaveLength(0)
      // …and the run completed through the handle: the parent saw its OWN
      // continuation step, not the child's.
      expect(run.finalText).toBe("parent finished")
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("holder 5b — the guardian's INHERITED model follows (its configured model is Task 3's boundary)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-assembly-guardian-rebind-"))
    const first = capturingModel()
    const second = scriptedModel([
      // the parent's step: a write OUTSIDE the workspace → the approval
      // classifier's `ask` branch → the guardian is consulted (core-tools
      // prepare step 3; assembly mounts the policy at :607)
      { role: "assistant", toolCalls: [{ name: "write", args: { path: join(dir, "..", "outside.txt"), content: "x" } }] },
      // the REVIEWER's own turn (forkTurns "none": it sees only the request)
      { role: "assistant", text: '{"outcome":"deny","rationale":"writes are denied today","risk_level":"moderate"}' },
    ])
    const assembly = await createSessionAssembly({
      workspace: dir,
      model: first,
      // `{}` — the INHERITED case: no `guardian.model`, so the reviewer runs on
      // `parentModel` (assembly.ts:847), which is the handle. A configured
      // `guardian.model` wins by construction (`deps.model ?? deps.parentModel`,
      // reviewer.ts:149) and is Task 3's boundary, not this case's.
      guardian: {},
    })
    try {
      assembly.setModel(second)
      // The run's OUTCOME is captured, not asserted, first — same reason as 5a:
      // a broken guardian wiring lets the write through, so asserting the
      // rejection first would mask the holder-specific line below.
      const outcome = assembly.agent.run("write the file").then(
        () => "resolved",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      await outcome
      // The review RAN on the rebound client — the reviewer is the request
      // carrying the guardian policy prompt, so a parent-only match cannot
      // satisfy this.
      expect(second.requests.filter((r) => r.systemPrompt.includes("You are the approval guardian."))).toHaveLength(1)
      expect(first.requests).toHaveLength(0)
      // …and the verdict was the one the run acted on, so the reviewer's call
      // was a real one whose answer reached the tool gate.
      expect(await outcome).toMatch(/guardian denied: writes are denied today/)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("holder 5c — a team-mate's first turn inherits the rebound client", async () => {
    const coordinator = memoryCoordinator()
    const first = capturingModel()
    const second = scriptedModel([
      { role: "assistant", toolCalls: [{ name: "spawn_teammate", args: { name: "helper", description: "d", prompt: "do the work" } }] },
      { role: "assistant", text: "teammate finished" }, // the teammate's own turn
      { role: "assistant", text: "lead finished" }, // the lead's continuation
    ])
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      model: first,
      approveAll: true,
      team: {},
      // The team's spawn path REQUIRES durable child sessions (roster.ts:
      // "durable child sessions required", then the holdsPrompt checkpoint read
      // through `coordinator.load`), which the assembly only wires when BOTH
      // sessionId and coordinator are present. The shared cassette makes the
      // teammate's turn and the lead's continuation race for the next script
      // step, so the assertions below never depend on WHO got which step.
      sessionId: "lead-1",
      coordinator,
    })
    try {
      assembly.setModel(second)
      // A rejected lead turn needs no assertion to fail this case (it rejects
      // out of the await below); the holder assertion is the waitFor, whose
      // subject is the TEAMMATE's request — only a teammate turn carries the
      // teammate role's prompt.
      await assembly.agent.run("use the team")
      await waitFor(() => second.requests.some((r) => r.systemPrompt.includes("You are a teammate in an agent team.")))
      expect(first.requests).toHaveLength(0)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("holder 6 — auto-title's model: `assembly.model` read at CALL time forwards to the rebound client", async () => {
    const first = capturingModel()
    const second = scriptedModel([{ role: "assistant", text: "a title" }])
    const assembly = await createSessionAssembly({ workspace: process.cwd(), model: first })
    try {
      assembly.setModel(second)
      // auto-title is the ONE production reader of `assembly.model`
      // (run.ts:697 `session, model: assembly.model,` — read AFTER the turn, at
      // call time, handed to `maybeAutoTitle`, which streams through it at
      // session-title/src/index.ts:56). The read is taken here where that call
      // site takes it — after the rebind, through the same expression — and the
      // client it yields is then exercised with one request. What this measures
      // is the VALUE the call site reads; the request's shape is incidental
      // (session-title builds its own, and it is tested there). Scope, stated
      // plainly: the call site itself is the declared gap at the top of this
      // block — no existing harness can rebind a runHeadless run mid-flight.
      const readsAtCallTime = assembly.model
      for await (const _ of readsAtCallTime.stream({ messages: [{ role: "user", content: "hello" }], tools: [], systemPrompt: "title" })) void _
      expect(second.requests).toHaveLength(1)
      expect(first.requests).toHaveLength(0)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})

// ── R-B2 (phase B), Task 3: the TWO holders named by CONFIGURATION ──────────
// Task 2's block above enumerates every holder that FOLLOWS a rebind, and its
// fixtures deliberately avoid both of these. These two cases pin the other side
// of that same line, so the exception is tested and spoken instead of silent:
//   (a) `compaction/src/index.ts` `config.summarizationModel ?? deps.model`
//   (b) `guard-approval/src/guardian/reviewer.ts` `deps.model ?? deps.parentModel`
//     — the host's `guardian.model`; found by Task 1's reviewer, absent from the
//       plan's first version, and with NO production caller today (only test
//       code sets it). A buried landmine rather than an open wound — and still
//       treated, because a rebind that leaves even one holder behind is the
//       silent partial success this unit exists to kill.
// Both keep winning on purpose (R-B2: a configured model is the user's explicit
// choice, and a rebind must not silently discard it). The cost is real and is
// stated where the boundary lives: after a rebind, summaries / guardian reviews
// under such a configuration keep billing the CONFIGURED endpoint.
describe("createSessionAssembly — the two CONFIGURED holders keep winning (Task 3, R-B2)", () => {
  /** The file's recorder shape (`capturingModel`, :462) around a
   * `createMockClient` cassette — the same two existing pieces Task 2's
   * `scriptedModel` joins. That helper is scoped to the Task 2 block, whose
   * fixtures this task must not disturb, so this block joins the two pieces
   * again rather than moving it. Not a third fixture: recorder = this file's,
   * script = `createMockClient`'s. */
  function scriptedModel(script: MockStep[]): ModelClient & { requests: LLMRequest[] } {
    const requests: LLMRequest[] = []
    const cassette = createMockClient(script)
    return {
      requests,
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        requests.push(request)
        yield* cassette.stream(request)
      },
    }
  }

  it("a CONFIGURED summarization model wins over the handle — a documented boundary, not an oversight", async () => {
    // R-B2: the rebind does not silently discard a user's explicit summarization
    // model. The cost is stated: for such a configuration the summarizer stays on
    // the configured endpoint after a rebind. This test is what makes that
    // visible instead of invisible.
    const session = createSession()
    // Task 2's holders 2+3 fixture, with the ONE difference that makes this the
    // boundary: a `summarizationModel` IS configured. One user message and the
    // default retention budget (retainTokens 0) → the whole surface is
    // shadowable, so compact() has a region to summarize.
    append(session, { type: "user/message", text: "kickoff ".repeat(20) })
    const first = capturingModel()
    // Each client's answer is unique, so the summary text names which client
    // actually served — the script-as-proof Task 2's holder 1 uses. Both answers
    // clear the 500-char minSummaryChars floor, so either is a clean pass and
    // WHICH client ran is the only thing the assertions can see.
    const configured = scriptedModel([{ role: "assistant", text: "CONFIGURED summarizer ran\n" + "configured ".repeat(60) }])
    const second = scriptedModel([{ role: "assistant", text: "REBOUND summarizer ran\n" + "rebound ".repeat(80) }])
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session,
      model: first,
      compact: { contextWindow: 100_000, summarizationModel: configured },
    })
    try {
      assembly.setModel(second)
      const result = await assembly.compactNow()
      // The boundary line comes FIRST so breaking the `??` reds HERE:
      // `config.summarizationModel ?? deps.model` means the CONFIGURED client
      // takes the summary request, rebind or no rebind.
      expect(configured.requests).toHaveLength(1)
      expect(second.requests).toHaveLength(0)
      expect(first.requests).toHaveLength(0)
      // …and the configured client's answer is the one the engine used.
      expect(result.summary).toContain("CONFIGURED summarizer ran")
      expect(result.compacted).toBe(true)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("a CONFIGURED guardian model wins over the handle too — the same boundary, the same cost", async () => {
    // Found by T1's reviewer, absent from this plan's first version. Same class as
    // R-B2's summarizationModel: a host-configured model is a deliberate choice and
    // the rebind does not discard it. Same visible cost: for such a configuration
    // every guardian review keeps billing the configured endpoint.
    const dir = mkdtempSync(join(tmpdir(), "ih-assembly-guardian-configured-"))
    const first = capturingModel()
    // The verdict text is unique, so BOTH proofs name the configured client: the
    // reviewer's REQUEST landed on it, and its ANSWER is the one the gate acted
    // on (the run's rejection carries the rationale).
    const configured = scriptedModel([{ role: "assistant", text: '{"outcome":"deny","rationale":"the configured reviewer denied it","risk_level":"moderate"}' }])
    // The parent runs on the REBOUND client. Its first step is the
    // outside-workspace write — the approval classifier's `ask` branch, which is
    // what consults the guardian. The second step exists only so that a broken
    // `??` (reviewer falling back to the handle) still produces a parseable
    // verdict instead of an exhausted cassette; it is never consumed on the
    // shipped path.
    const second = scriptedModel([
      { role: "assistant", toolCalls: [{ name: "write", args: { path: join(dir, "..", "outside.txt"), content: "x" } }] },
      { role: "assistant", text: '{"outcome":"approve","rationale":"the handle reviewer approved it","risk_level":"none"}' },
    ])
    const assembly = await createSessionAssembly({
      workspace: dir,
      model: first,
      // `model` — the CONFIGURED case. `deps.model ?? deps.parentModel`
      // (reviewer.ts) makes the reviewer spawn on THIS client even though the
      // parent it inherits from moved to `second` (the assembly hands the handle
      // as parentModel and the configured client as model).
      guardian: { model: configured },
    })
    try {
      assembly.setModel(second)
      // The run's OUTCOME is captured, not asserted, first — same reason as Task
      // 2's holder 5b: under a broken guardian wiring the write goes through and
      // an outcome assertion would red before the boundary line below.
      const outcome = assembly.agent.run("write the file").then(
        () => "resolved",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      await outcome
      // The reviewer's request is the one carrying the guardian policy prompt
      // (the reviewer role's systemPrompt), so a parent-only match cannot satisfy
      // it. Boundary line FIRST: the configured client is the one that serves.
      expect(configured.requests.filter((r) => r.systemPrompt.includes("You are the approval guardian."))).toHaveLength(1)
      // …and it served instead of the rebound client, not alongside it.
      expect(second.requests.filter((r) => r.systemPrompt.includes("You are the approval guardian."))).toHaveLength(0)
      expect(first.requests).toHaveLength(0)
      // The rebind itself was live: the parent's own turn ran on `second`, so
      // the boundary above is a rebind-time fact, not a rebind that never landed.
      expect(second.requests.length).toBeGreaterThan(0)
      // …and the configured client's verdict is the one the gate acted on.
      expect(await outcome).toMatch(/guardian denied: the configured reviewer denied it/)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})

// M56 T1.5: the provider's fail-soft refresh-failure signal is bound to the
// mcp/server-status sink as an ADDITIVE event field — the lifecycle state does
// not change (the stored token is kept; the 401/M53 path owns recovery). The
// binding is exercised through the PUBLIC assembly surface: the auth config the
// assembly hands `mountMcpClient` IS the production binding, and the assertions
// read the telemetry stream that binding writes to.
describe("createSessionAssembly — MCP auth refresh-failure binding (M56/M57)", () => {
  /** ONE assembly mounting ONE streamable-http OAuth server. The server is never
   * dialled (the mount is recorded, not performed), so the test drives the two
   * signals production would: the supervisor's lifecycle `onStatus` and the
   * provider's refresh-failure callback. `trace` interleaves the host handler
   * and the telemetry sink for the composition-order case. */
  async function withOAuthMcp(opts: {
    hostHandler?: (message: string) => unknown
    trace?: string[]
  } = {}) {
    mcpMounts.calls.length = 0
    const events: TelemetryEvent[] = []
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      model: createMockClient([{ role: "assistant", text: "ok" }]),
      telemetry: createTelemetry([{
        onEvent: (ev) => {
          events.push(ev)
          if (ev.type === "mcp/server-status") opts.trace?.push("event")
        },
      }]),
      pluginMcp: [{
        transport: "streamable-http",
        serverName: "oauth-x",
        url: "http://127.0.0.1:9/mcp",
        auth: opts.hostHandler === undefined ? {} : { onAuthRefreshFailed: opts.hostHandler },
      }],
    })
    const call = mcpMounts.calls.at(-1)
    // The config built for a streamable-http mount is the variant carrying `auth`.
    const config = call?.config as Extract<McpServerConfig, { transport: "streamable-http" }> | undefined
    const refreshFailed = config?.auth?.onAuthRefreshFailed
    if (call === undefined || refreshFailed === undefined) {
      await assembly.dispose()
      throw new Error("the assembly did not bind onAuthRefreshFailed into the mount config")
    }
    const statusEvents = (): Record<string, unknown>[] =>
      events.filter((e) => e.type === "mcp/server-status").map((e) => e.data)
    const authEvents = (): Record<string, unknown>[] =>
      statusEvents().filter((d) => d.authRefreshFailed !== undefined)
    return {
      assembly,
      refreshFailed,
      status: (ev: McpServerStatusEvent): void => call.deps?.onStatus?.(ev),
      statusEvents,
      authEvents,
    }
  }

  it("routes the provider's refresh-failure signal to mcp/server-status with the server's REAL lifecycle state, additively", async () => {
    const { assembly, refreshFailed, status, statusEvents } = await withOAuthMcp()
    try {
      status({ server: "oauth-x", state: "reconnecting" })
      refreshFailed("invalid_grant: refresh token revoked")
      // Additive: the failure REPORTS the state the supervisor last emitted and
      // does not replace it — a second failure still reads "reconnecting".
      refreshFailed("network down")
      expect(statusEvents()).toEqual([
        { server: "oauth-x", state: "reconnecting" },
        { server: "oauth-x", state: "reconnecting", authRefreshFailed: "invalid_grant: refresh token revoked" },
        { server: "oauth-x", state: "reconnecting", authRefreshFailed: "network down" },
      ])
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("falls back to ready when the server has not emitted any state yet", async () => {
    const { assembly, refreshFailed, authEvents } = await withOAuthMcp()
    try {
      refreshFailed("network down")
      expect(authEvents()).toEqual([
        { server: "oauth-x", state: "ready", authRefreshFailed: "network down" },
      ])
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("composes a host onAuthRefreshFailed handler, host first, without losing the visibility event", async () => {
    const trace: string[] = []
    const { assembly, refreshFailed, authEvents } = await withOAuthMcp({
      hostHandler: (message) => { trace.push(`host:${message}`) },
      trace,
    })
    try {
      refreshFailed("refresh failed")
      expect(trace).toEqual(["host:refresh failed", "event"])
      expect(authEvents()).toEqual([
        { server: "oauth-x", state: "ready", authRefreshFailed: "refresh failed" },
      ])
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("swallows a throwing host handler, reports it, and still emits the event", async () => {
    const { assembly, refreshFailed, authEvents } = await withOAuthMcp({
      hostHandler: () => { throw new Error("host handler exploded") },
    })
    try {
      const warnings: string[] = []
      const original = console.warn
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
      try {
        expect(() => refreshFailed("refresh failed")).not.toThrow()
      } finally {
        console.warn = original
      }
      expect(authEvents()).toEqual([
        { server: "oauth-x", state: "ready", authRefreshFailed: "refresh failed" },
      ])
      expect(warnings.some((w) => w.includes("host onAuthRefreshFailed handler threw") && w.includes("host handler exploded"))).toBe(true)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("routes a rejecting async host handler to the warn path without losing the event", async () => {
    const { assembly, refreshFailed, authEvents } = await withOAuthMcp({
      hostHandler: async () => { throw new Error("async host handler exploded") },
    })
    try {
      const warnings: string[] = []
      const original = console.warn
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
      try {
        refreshFailed("refresh failed")
        // The rejection lands on a microtask (the binder's own guard), so the
        // capture must outlive it.
        await new Promise((resolve) => setImmediate(resolve))
      } finally {
        console.warn = original
      }
      expect(authEvents()).toEqual([
        { server: "oauth-x", state: "ready", authRefreshFailed: "refresh failed" },
      ])
      expect(warnings.some((w) => w.includes("async host handler exploded"))).toBe(true)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  // NOT rerouted: the former "degrades to ready when currentState itself throws"
  // case drove the binder's `currentState` seam directly. Through the assembly
  // that reader is `mcpStates.get(serverName)` — a Map lookup that cannot throw —
  // so the defensive branch has no reachable public trigger. The loss is recorded
  // in the task report (it is the one unit case the un-export costs).
})

// ── pluginAgents: a plugin contributes a subagent role ──────────────────────
// The RoleRegistry is deliberately NOT on the assembly handle ("the projection
// owns NO registry object — rows only"), so the contract is checked where it IS
// observable: the per-role result map, and a REAL spawn through the mounted
// spawn_agent — which resolves roles by name and throws `unknown role: X` when
// one is absent. The first case runs the same fixture with and without the
// option, so it is the OPTION that makes the difference rather than an
// assertion that merely passes.
describe("createSessionAssembly — pluginAgents", () => {
  /** One turn whose model asks spawn_agent for `roleName`. `background: false`
   * makes the child's turn land before the parent's continuation, so the
   * cassette order is deterministic. Returns what the model saw (a role's
   * identity becomes observable through the child's systemPrompt) plus the whole
   * recorded turn. An UNRESOLVABLE role makes the spawn tool throw straight out
   * of `agent.run` — so the control case asserts a rejection, which is the
   * sharper form of the same fact rather than a weaker one. */
  async function spawnVia(roleName: string, pluginAgents?: SubagentRole[]) {
    const cassette = createMockClient([
      { role: "assistant", toolCalls: [{ name: "spawn_agent", args: { message: "simplify this", task_name: "helper", agent_type: roleName, background: false } }] },
      { role: "assistant", text: "child finished" }, // the child's turn
      { role: "assistant", text: "parent finished" }, // the parent's continuation
    ])
    const requests: LLMRequest[] = []
    const model: ModelClient = { async *stream(req) { requests.push(req); yield* cassette.stream(req) } }
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      model,
      // spawn_agent is an approval-gated tool; absent an answerer the mount is
      // fail-closed, which would fail these cases for a reason unrelated to the
      // seam (same option the service subagent fixture uses).
      approveAll: true,
      ...(pluginAgents !== undefined ? { pluginAgents } : {}),
    })
    try {
      const run = await assembly.agent.run("start")
      return {
        requests,
        agentResults: [...assembly.pluginAgentResults],
        log: JSON.stringify({ run, events: assembly.session.events }),
      }
    } finally {
      await assembly.dispose()
    }
  }

  it("a plugin role is what spawn_agent resolves against; without the option the same call does not", async () => {
    const role: SubagentRole = {
      name: "code-simplifier",
      description: "simplifies code",
      systemPrompt: "You simplify code.",
      tools: ["read"],
    }

    // Control: the SAME fixture, option absent — the role does not exist, and
    // the spawn tool's throw ends the run.
    await expect(spawnVia("code-simplifier")).rejects.toThrow(/unknown role: code-simplifier/)

    const withRole = await spawnVia("code-simplifier", [role])
    expect(withRole.log).not.toContain("unknown role")
    expect(withRole.agentResults).toEqual([["code-simplifier", true]])
    // and it is genuinely THIS role: its own prompt reached the child
    expect(withRole.requests.some((r) => r.systemPrompt.includes("You simplify code."))).toBe(true)
  }, 30_000)

  it("a plugin role colliding with a builtin is SKIPPED and reported, never substituted", async () => {
    const impostor: SubagentRole = {
      name: "general",
      description: "IMPOSTOR",
      systemPrompt: "You are the impostor.",
      tools: [],
    }
    const run = await spawnVia("general", [impostor])

    expect(run.agentResults).toEqual([["general", false]])
    // the spawn still resolves — against the BUILTIN, which the plugin did not replace
    expect(run.log).not.toContain("unknown role")
    expect(run.requests.some((r) => r.systemPrompt.includes("You are the impostor."))).toBe(false)
    expect(run.requests.some((r) => r.systemPrompt.includes("You are a general-purpose coding agent."))).toBe(true)
  }, 30_000)

  it("omitting pluginAgents is a no-op — empty report, builtin roles untouched", async () => {
    const run = await spawnVia("general")
    expect(run.agentResults).toEqual([])
    expect(run.log).not.toContain("unknown role")
  }, 30_000)
})

// ── resolveRoleModel: the HOST's resolver is what a role's model runs on ────
// Both ends of the seam are load-bearing. A wired resolver must be the thing a
// model-carrying role runs on — its own reason reaching the failure is what
// says so — and an ABSENT one must fail NAMING the selection, never let the
// child inherit the session's model in silence (a role that names one model and
// runs another is the wrong answer stated as a right one).
describe("createSessionAssembly — resolveRoleModel", () => {
  const roleWithModel: SubagentRole = {
    name: "rolemodel",
    description: "carries its own model",
    systemPrompt: "You are rolemodel.",
    tools: [],
    model: { provider: "gw", model: "small" },
  }

  /** One turn whose model asks spawn_agent for the model-carrying role.
   * `background: false` makes the child's turn land before the parent's
   * continuation, and the not-ready resolver ends the whole run in a throw.
   *
   * `allowSubagentModelSelection` is passed EXPLICITLY by the cases below: the
   * option is the `plugins.subagentModel` switch, absent means off, and a
   * model-carrying role is refused before the resolver is reached without it —
   * so a case asserting anything about the RESOLVER must turn it on. The one
   * case that leaves it off asserts exactly that refusal. */
  async function spawnRoleWithModel(
    resolveRoleModel?: AssemblyOptions["resolveRoleModel"],
    allowSubagentModelSelection?: boolean,
    roleSelectionFor?: AssemblyOptions["roleSelectionFor"],
  ): Promise<unknown> {
    const cassette = createMockClient([
      { role: "assistant", toolCalls: [{ name: "spawn_agent", args: { message: "x", task_name: "helper", agent_type: "rolemodel", background: false } }] },
    ])
    const model: ModelClient = { async *stream(req) { yield* cassette.stream(req) } }
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      model,
      // spawn_agent is approval-gated; the same option the pluginAgents fixture
      // uses, so this fails (or not) for the seam's reason and no other.
      approveAll: true,
      pluginAgents: [roleWithModel],
      ...(resolveRoleModel !== undefined ? { resolveRoleModel } : {}),
      ...(allowSubagentModelSelection !== undefined ? { allowSubagentModelSelection } : {}),
      ...(roleSelectionFor !== undefined ? { roleSelectionFor } : {}),
    })
    try {
      return await assembly.agent.run("start")
    } finally {
      await assembly.dispose()
    }
  }

  it("a wired but not-ready resolver fails the spawn with ITS reason", async () => {
    await expect(spawnRoleWithModel(async () => ({ status: "invalid", reason: 'Unknown provider "gw"' }), true))
      .rejects.toThrow(/role 'rolemodel' cannot resolve its model: Unknown provider "gw"/)
  }, 30_000)

  it("an ABSENT resolver fails naming the selection (no silent inherit)", async () => {
    await expect(spawnRoleWithModel(undefined, true))
      .rejects.toThrow(/no role-model resolver is configured \(role asked for gw:small\)/)
  }, 30_000)

  // The switch itself, seen from the real assembly: ABSENT is off. Nothing was
  // passed here, which is exactly what an unwired host does — and the refusal
  // names both fixes (this is the `unconsulted-setting` row finally read).
  // `rolemodel` is not a built-in name, so the second fix is the settings key:
  // `roles unset` only accepts the four built-ins.
  it("without plugins.subagentModel the model-carrying spawn is refused, naming both fixes", async () => {
    await expect(spawnRoleWithModel())
      .rejects.toThrow(/role "rolemodel" declares a model, but sub-agent model selection is disabled: set plugins\.subagentModel=true in settings, or clear `agents\.roles\.rolemodel` in settings\.json/)
  }, 30_000)

  // …and the HOST's declared selection is what a spawn asks the resolver for:
  // settings beat the role's own `model` at the assembly end of the seam too.
  it("the host's declared role selection reaches the spawn and WINS over the role's own", async () => {
    await expect(spawnRoleWithModel(
      async (selection) => ({ status: "invalid", reason: `saw ${selection.provider}:${selection.model}` }),
      true,
      (roleName) => (roleName === "rolemodel" ? { provider: "gw", model: "from-settings" } : undefined),
    )).rejects.toThrow(/saw gw:from-settings/)
  }, 30_000)
})
