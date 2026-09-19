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
import { createMockClient } from "@i-harness/llm-mock"
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
   * continuation, and the not-ready resolver ends the whole run in a throw. */
  async function spawnRoleWithModel(resolveRoleModel?: AssemblyOptions["resolveRoleModel"]): Promise<unknown> {
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
    })
    try {
      return await assembly.agent.run("start")
    } finally {
      await assembly.dispose()
    }
  }

  it("a wired but not-ready resolver fails the spawn with ITS reason", async () => {
    await expect(spawnRoleWithModel(async () => ({ status: "invalid", reason: 'Unknown provider "gw"' })))
      .rejects.toThrow(/role 'rolemodel' cannot resolve its model: Unknown provider "gw"/)
  }, 30_000)

  it("an ABSENT resolver fails naming the selection (no silent inherit)", async () => {
    await expect(spawnRoleWithModel())
      .rejects.toThrow(/no role-model resolver is configured \(role asked for gw:small\)/)
  }, 30_000)
})
