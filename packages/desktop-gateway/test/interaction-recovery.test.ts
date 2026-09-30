import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import type { ApprovalRequest, QuestionProvider } from "@i-harness/interaction"
import type { SessionAssembly } from "@i-harness/session-executor"
import { createInteractionBridge, type InteractionRecoveryInput, type PendingInteraction } from "../src/interaction.ts"

function assembly(sessionId = "s1"): SessionAssembly {
  return { sessionId, ctx: createContext() } as unknown as SessionAssembly
}
function approval(ctx: PluginContext): (request: ApprovalRequest) => Promise<boolean> {
  return ctx.services.get("approval/answerer")
}
function question(ctx: PluginContext): QuestionProvider { return ctx.services.get("questions/provider") }
function persistence() {
  let rows: PendingInteraction[] = []
  return {
    read: () => structuredClone(rows),
    write: (next: PendingInteraction[]) => { rows = structuredClone(next) },
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => { vi.useRealTimers() })

describe("durable interrupted interactions", () => {
  it("restores pending questions after graceful restart and saves a new durable input once", async () => {
    const store = persistence()
    const emit = vi.fn()
    const original = createInteractionBridge(emit, { persistence: store })
    const owner = assembly()
    original.attach(owner)
    const interrupted = question(owner.ctx).ask({ id: "q1", prompt: "Which plan?", options: ["A", "B"] })
    const rejection = expect(interrupted).rejects.toThrow(/closed/)
    const requestId = original.pending()[0]!.requestId
    original.close()
    await rejection
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ method: "desktop/interaction/request", params: expect.objectContaining({ requestId, state: "interrupted" }) }))
    const recover = vi.fn(async (_input: InteractionRecoveryInput) => {})
    const restarted = createInteractionBridge(() => {}, { persistence: store, recover })
    try {
      expect(restarted.pending()).toEqual([expect.objectContaining({ requestId, state: "interrupted" })])
      await restarted.reply({ requestId, sessionId: "s1", decision: { kind: "question", answer: "B" } })
      expect(recover).toHaveBeenCalledTimes(1)
      expect(recover).toHaveBeenCalledWith(expect.objectContaining({
        inputId: `interaction-recovery-${requestId}`,
        text: expect.stringContaining("B"),
        request: expect.objectContaining({ payload: { id: "q1", prompt: "Which plan?", options: ["A", "B"] } }),
      }))
      expect(restarted.pending()).toEqual([])
      expect(() => restarted.reply({ requestId, sessionId: "s1", decision: { kind: "question", answer: "B" } })).toThrow(/unknown|settled/)
      expect(createInteractionBridge(() => {}, { persistence: store }).pending()).toEqual([])
    } finally { restarted.close() }
  })

  it("does not grant the original approval when recovering a request to reassess", async () => {
    const store = persistence()
    const original = createInteractionBridge(() => {}, { persistence: store })
    const owner = assembly()
    original.attach(owner)
    let executions = 0
    const oldTool = approval(owner.ctx)({ name: "write", reason: "edit file", argumentsSummary: '{"path":"notes.md"}' }).then((allowed) => {
      if (allowed) executions++
      return allowed
    })
    const requestId = original.pending()[0]!.requestId
    original.close()
    expect(await oldTool).toBe(false)
    const recover = vi.fn(async (_input: InteractionRecoveryInput) => {})
    const restarted = createInteractionBridge(() => {}, { persistence: store, recover })
    try {
      await restarted.reply({ requestId, sessionId: "s1", decision: { kind: "approval", approved: true } })
      expect(executions).toBe(0)
      expect(recover).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/reassess/i) }))
      expect(recover.mock.calls[0]![0].text).toMatch(/not.*grant|no.*permission/i)
      expect(recover.mock.calls[0]![0].signal.aborted).toBe(false)
    } finally { restarted.close() }
  })

  it("dismisses a recovered approval without executing or appending a resume request", async () => {
    const store = persistence()
    const original = createInteractionBridge(() => {}, { persistence: store })
    const owner = assembly()
    original.attach(owner)
    const waiting = approval(owner.ctx)({ name: "write", reason: "edit" })
    const requestId = original.pending()[0]!.requestId
    original.close()
    await waiting
    const recover = vi.fn(async () => {})
    const restarted = createInteractionBridge(() => {}, { persistence: store, recover })
    restarted.reply({ requestId, sessionId: "s1", decision: { kind: "approval", approved: false } })
    expect(recover).not.toHaveBeenCalled()
    expect(store.read()).toEqual([])
    restarted.close()
  })

  it("rejects wrong-session and wrong-kind replies for interrupted requests", async () => {
    const store = persistence()
    store.write([{ requestId: "r1", sessionId: "s1", kind: "question", payload: { prompt: "Choose" }, openedAt: Date.now() }])
    const recover = vi.fn(async () => {})
    const bridge = createInteractionBridge(() => {}, { persistence: store, recover })
    try {
      expect(() => bridge.reply({ requestId: "r1", sessionId: "s2", decision: { kind: "question", answer: "A" } })).toThrow(/session mismatch/)
      expect(() => bridge.reply({ requestId: "r1", sessionId: "s1", decision: { kind: "approval", approved: true } })).toThrow(/kind mismatch/)
      expect(recover).not.toHaveBeenCalled()
      expect(bridge.pending()).toHaveLength(1)
    } finally { bridge.close() }
  })

  it("prunes expired snapshots and expires restored requests at their original deadline", async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const lifetime = 24 * 60 * 60 * 1000
    const store = persistence()
    store.write([
      { requestId: "expired", sessionId: "s1", kind: "approval", payload: {}, openedAt: now - lifetime },
      { requestId: "recent", sessionId: "s1", kind: "approval", payload: {}, openedAt: now - lifetime + 10 },
    ])
    const bridge = createInteractionBridge(() => {}, { persistence: store })
    expect(bridge.pending().map((row) => row.requestId)).toEqual(["recent"])
    await vi.advanceTimersByTimeAsync(10)
    expect(bridge.pending()).toEqual([])
    expect(store.read()).toEqual([])
    bridge.close()
  })

  it("cancels restored requests durably and preserves other sessions", () => {
    const store = persistence()
    store.write(["s1", "s2"].map((sessionId) => ({ requestId: sessionId, sessionId, kind: "approval", payload: {}, openedAt: Date.now() })))
    const bridge = createInteractionBridge(() => {}, { persistence: store })
    bridge.cancelSession("s1")
    bridge.close()
    const restarted = createInteractionBridge(() => {}, { persistence: store })
    expect(restarted.pending().map((row) => row.sessionId)).toEqual(["s2"])
    expect(() => restarted.reply({ requestId: "s1", sessionId: "s1", decision: { kind: "approval", approved: true } })).toThrow()
    restarted.cancelSession("s2")
    restarted.close()
  })

  it("rejects duplicate concurrent consumption and aborts recovery on cancellation", async () => {
    const store = persistence()
    store.write([{ requestId: "r1", sessionId: "s1", kind: "question", payload: { prompt: "Choose" }, openedAt: Date.now() }])
    const gate = deferred()
    let signal!: AbortSignal
    const bridge = createInteractionBridge(() => {}, { persistence: store, recover: async (input) => {
      signal = input.signal
      await gate.promise
      signal.throwIfAborted()
    } })
    const reply = { requestId: "r1", sessionId: "s1", decision: { kind: "question" as const, answer: "A" } }
    const first = bridge.reply(reply)
    const rejection = expect(first).rejects.toThrow()
    expect(() => bridge.reply(reply)).toThrow(/in progress/)
    bridge.cancelSession("s1")
    expect(signal.aborted).toBe(true)
    gate.resolve()
    await rejection
    expect(store.read()).toEqual([])
    bridge.close()
  })

  it("retains the interrupted card when durable admission fails and retries with a stable input id", async () => {
    const store = persistence()
    store.write([{ requestId: "r1", sessionId: "s1", kind: "question", payload: { prompt: "Choose" }, openedAt: Date.now() }])
    const recover = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined)
    const bridge = createInteractionBridge(() => {}, { persistence: store, recover })
    try {
      const reply = { requestId: "r1", sessionId: "s1", decision: { kind: "question" as const, answer: "A" } }
      await expect(bridge.reply(reply)).rejects.toThrow("disk full")
      expect(bridge.pending()).toHaveLength(1)
      await bridge.reply(reply)
      expect(recover.mock.calls.map(([input]) => input.inputId)).toEqual(["interaction-recovery-r1", "interaction-recovery-r1"])
      expect(store.read()).toEqual([])
    } finally { bridge.close() }
  })

  it("reuses the same durable input after a crash between admission and snapshot removal", async () => {
    const backing = persistence()
    backing.write([{ requestId: "r1", sessionId: "s1", kind: "question", payload: { prompt: "Choose" }, openedAt: Date.now() }])
    let failed = false
    const store = { read: backing.read, write: (next: PendingInteraction[]) => {
      if (!failed && next.length === 0) { failed = true; throw new Error("snapshot save failed") }
      backing.write(next)
    } }
    // A real host uses the admitted-input id in the durable session inbox.
    // The test's durable set exercises this callback's idempotency contract.
    const admissions = new Map<string, string>()
    const recover = async (input: InteractionRecoveryInput) => {
      const previous = admissions.get(input.inputId)
      if (previous !== undefined && previous !== input.text) throw new Error("recovered answer was already saved differently")
      admissions.set(input.inputId, input.text)
    }
    const first = createInteractionBridge(() => {}, { persistence: store, recover })
    const reply = { requestId: "r1", sessionId: "s1", decision: { kind: "question" as const, answer: "A" } }
    await expect(first.reply(reply)).rejects.toThrow("snapshot save failed")
    expect(admissions.size).toBe(1)
    first.close()
    const restarted = createInteractionBridge(() => {}, { persistence: store, recover })
    try {
      await expect(restarted.reply({ ...reply, decision: { kind: "question", answer: "B" } })).rejects.toThrow(/saved differently/)
      await restarted.reply(reply)
      expect(admissions.size).toBe(1)
      expect(backing.read()).toEqual([])
    } finally { restarted.close() }
  })

  it("fails live prompts closed if their snapshot cannot be saved before notification", async () => {
    const emit = vi.fn()
    const bridge = createInteractionBridge(emit, { persistence: { read: () => [], write: () => { throw new Error("disk full") } } })
    const owner = assembly()
    bridge.attach(owner)
    expect(await approval(owner.ctx)({ name: "write", reason: "edit" })).toBe(false)
    await expect(question(owner.ctx).ask({ id: "q1", prompt: "Choose" })).rejects.toThrow(/closed/)
    expect(emit).not.toHaveBeenCalled()
    expect(bridge.pending()).toEqual([])
    bridge.close()
  })

  it("keeps a recovered request retryable when an adapter throws synchronously", async () => {
    const store = persistence()
    store.write([{ requestId: "r1", sessionId: "s1", kind: "question", payload: { prompt: "Choose" }, openedAt: Date.now() }])
    const bridge = createInteractionBridge(() => {}, { persistence: store, recover: () => { throw new Error("unavailable") } })
    const reply = { requestId: "r1", sessionId: "s1", decision: { kind: "question" as const, answer: "A" } }
    await expect(bridge.reply(reply)).rejects.toThrow("unavailable")
    await expect(bridge.reply(reply)).rejects.toThrow("unavailable")
    expect(bridge.pending()).toHaveLength(1)
    bridge.close()
  })

  it("denies new calls through stale assembly providers after close even in full access", async () => {
    const bridge = createInteractionBridge(() => {}, { approvalMode: () => "full-access" })
    const owner = assembly()
    bridge.attach(owner)
    bridge.close()
    expect(await approval(owner.ctx)({ name: "write", reason: "stale runtime" })).toBe(false)
  })
})
