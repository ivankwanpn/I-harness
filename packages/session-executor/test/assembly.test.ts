import { describe, expect, it } from "vitest"

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
import { createSessionExecutor } from "@i-harness/core-agent"
import { createMockClient } from "@i-harness/llm-mock"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { McpServerStatusEvent } from "@i-harness/mcp-client"
import {
  bindAuthRefreshStatus,
  createSessionAssembly,
  estimateAssemblyOverhead,
  ModelUnavailableError,
} from "../src/assembly.ts"

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

  it("M33: estimateAssemblyOverhead prices systemPrompt/4 + schemas JSON/4 (chars-4 estimator, scheduling-only)", () => {
    const schemas = [{ name: "read", description: "b".repeat(1200) }]
    const expected = Math.ceil(400 / 4) + Math.ceil(JSON.stringify(schemas).length / 4)
    expect(estimateAssemblyOverhead("a".repeat(400), schemas)).toBe(expected)
  })

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
    let captured: string | undefined
    const spy: ModelClient = {
      async *stream(request: LLMRequest) {
        captured = (request.messages[0]!.content as string)
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
      expect(captured).toContain("## User instructions")
      expect(captured).toContain("keep the constraint X in mind")
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
// not change (the stored token is kept; the 401/M53 path owns recovery).
describe("bindAuthRefreshStatus (M56)", () => {
  it("emits an additive authRefreshFailed event, leaving the lifecycle state untouched", () => {
    const events: McpServerStatusEvent[] = []
    const notify = bindAuthRefreshStatus("oauth-x", (ev) => events.push(ev))
    notify("invalid_grant: refresh token revoked")
    expect(events).toEqual([
      { server: "oauth-x", state: "ready", authRefreshFailed: "invalid_grant: refresh token revoked" },
    ])
  })

  // M57 T1: the event must carry the server's REAL lifecycle state — a hardcoded
  // "ready" is only accidentally right.
  it("reports the server's real lifecycle state when the caller supplies currentState", () => {
    const events: McpServerStatusEvent[] = []
    const notify = bindAuthRefreshStatus("oauth-x", (ev) => events.push(ev), {
      currentState: () => "reconnecting",
    })
    notify("invalid_grant: refresh token revoked")
    expect(events).toEqual([
      { server: "oauth-x", state: "reconnecting", authRefreshFailed: "invalid_grant: refresh token revoked" },
    ])
  })

  it("falls back to ready when the server has not emitted any state yet", () => {
    const events: McpServerStatusEvent[] = []
    const notify = bindAuthRefreshStatus("oauth-x", (ev) => events.push(ev), {
      currentState: () => undefined,
    })
    notify("network down")
    expect(events).toEqual([{ server: "oauth-x", state: "ready", authRefreshFailed: "network down" }])
  })

  // M57 T2: a host-supplied onAuthRefreshFailed must be composed, not overwritten —
  // host first, then our visibility event (a broken host handler must never
  // silence it).
  it("calls the host handler first, then still emits the visibility event", () => {
    const calls: string[] = []
    const events: McpServerStatusEvent[] = []
    const notify = bindAuthRefreshStatus(
      "oauth-x",
      (ev) => { calls.push("event"); events.push(ev) },
      { hostHandler: () => { calls.push("host") } },
    )
    notify("refresh failed")
    expect(calls).toEqual(["host", "event"])
    expect(events).toEqual([{ server: "oauth-x", state: "ready", authRefreshFailed: "refresh failed" }])
  })

  it("swallows a throwing host handler, reports it, and still emits the event", () => {
    const events: McpServerStatusEvent[] = []
    const errors: unknown[] = []
    const boom = new Error("host handler exploded")
    const notify = bindAuthRefreshStatus("oauth-x", (ev) => events.push(ev), {
      hostHandler: () => { throw boom },
      onHostError: (err) => { errors.push(err) },
    })
    expect(() => notify("refresh failed")).not.toThrow()
    expect(errors).toEqual([boom])
    expect(events).toEqual([{ server: "oauth-x", state: "ready", authRefreshFailed: "refresh failed" }])
  })

  it("emits with an opts object that carries no host handler", () => {
    const events: McpServerStatusEvent[] = []
    const notify = bindAuthRefreshStatus("oauth-x", (ev) => events.push(ev), { currentState: () => "ready" })
    notify("refresh failed")
    expect(events).toEqual([{ server: "oauth-x", state: "ready", authRefreshFailed: "refresh failed" }])
  })

  // M57 fix-wave F2: a throwing state reader is the one remaining hole in the
  // fail-soft story — it must degrade to the "ready" fallback, not silence the
  // event.
  it("degrades to ready when currentState itself throws", () => {
    const events: McpServerStatusEvent[] = []
    const notify = bindAuthRefreshStatus("oauth-x", (ev) => events.push(ev), {
      currentState: () => { throw new Error("boom") },
    })
    expect(() => notify("refresh failed")).not.toThrow()
    expect(events).toEqual([{ server: "oauth-x", state: "ready", authRefreshFailed: "refresh failed" }])
  })

  // M57 fix-wave F3: an `async` host handler rejects on a microtask — neither the
  // sync try/catch here nor the provider's own guard can see it, so it must be
  // routed to onHostError instead of escaping as an unhandledRejection.
  it("routes a rejecting async host handler to onHostError without losing the event", async () => {
    const events: McpServerStatusEvent[] = []
    const errors: unknown[] = []
    const boom = new Error("async host handler exploded")
    const notify = bindAuthRefreshStatus("oauth-x", (ev) => events.push(ev), {
      hostHandler: async () => { throw boom },
      onHostError: (err) => { errors.push(err) },
    })
    notify("refresh failed")
    expect(events).toEqual([{ server: "oauth-x", state: "ready", authRefreshFailed: "refresh failed" }])
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).toEqual([boom])
  })
})
