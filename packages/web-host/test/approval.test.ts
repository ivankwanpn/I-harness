import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import type { ApprovalRequest } from "@i-harness/interaction"
import { ApprovalMuxBridge, ApprovalWaterfall } from "../src/approval.ts"
import type { ApprovalRequestWire } from "../src/types.ts"

// registerApprovalAnswerer normalizes the richer `{ approved }` decision shape
// to a plain boolean at the service boundary (interaction audit F05-5), so the
// waterfall is exercised through that seam exactly as core-tools sees it:
// `ctx.services.get("approval/answerer")` returns `(req) => Promise<boolean>`.
type Answerer = (req: ApprovalRequest) => Promise<boolean>

function getAnswerer(ctx: ReturnType<typeof createContext>): Answerer {
  return ctx.services.get<Answerer>("approval/answerer")
}

describe("ApprovalWaterfall", () => {
  it("fails closed: no client response within the timeout → approved false, pending entry removed", async () => {
    const ctx = createContext()
    const emitted: ApprovalRequestWire[] = []
    const wf = new ApprovalWaterfall(ctx, (req) => { emitted.push(req) }, 25)
    wf.attach()

    const decision = getAnswerer(ctx)({ name: "bash", reason: "unit test" })

    // The wire request is emitted (synchronously, before the answerer parks)
    // with only the provided fields — optional fields stay absent.
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ name: "bash", reason: "unit test" })
    expect(emitted[0]!.approvalId).toBeTruthy()
    expect("command" in emitted[0]!).toBe(false)
    expect("argv" in emitted[0]!).toBe(false)
    expect("dangerClass" in emitted[0]!).toBe(false)
    expect("pathSummary" in emitted[0]!).toBe(false)

    // No respond() arrives → the timeout decides, fail-closed.
    await expect(decision).resolves.toBe(false)

    // Timeout cleanup: the stale approvalId is gone, a late response is a no-op.
    expect(wf.respond({ approvalId: emitted[0]!.approvalId, approved: true })).toBe(false)
  })

  it("resolves approved true when a client response arrives before the timeout", async () => {
    const ctx = createContext()
    const emitted: ApprovalRequestWire[] = []
    const wf = new ApprovalWaterfall(ctx, (req) => { emitted.push(req) }, 5_000)
    wf.attach()

    const decision = getAnswerer(ctx)({
      name: "bash",
      reason: "unit test",
      command: "ls -la",
      argv: ["ls", "-la"],
      dangerClass: "none",
      pathSummary: "D:\\tmp",
    })

    // Optional fields propagate onto the wire request.
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      approvalId: emitted[0]!.approvalId,
      name: "bash",
      reason: "unit test",
      command: "ls -la",
      argv: ["ls", "-la"],
      dangerClass: "none",
      pathSummary: "D:\\tmp",
    })

    // Client approves → the parked answerer resolves true.
    expect(wf.respond({ approvalId: emitted[0]!.approvalId, approved: true })).toBe(true)
    await expect(decision).resolves.toBe(true)

    // Idempotency: a second response for the same (already resolved) id is a no-op.
    expect(wf.respond({ approvalId: emitted[0]!.approvalId, approved: false })).toBe(false)
  })

  it("resolves approved false on an explicit client denial", async () => {
    const ctx = createContext()
    const emitted: ApprovalRequestWire[] = []
    const wf = new ApprovalWaterfall(ctx, (req) => { emitted.push(req) }, 5_000)
    wf.attach()

    const decision = getAnswerer(ctx)({ name: "bash", reason: "unit test" })
    expect(emitted).toHaveLength(1)
    expect(wf.respond({ approvalId: emitted[0]!.approvalId, approved: false })).toBe(true)
    await expect(decision).resolves.toBe(false)
  })

  it("respond() on an unknown approvalId is a no-op", () => {
    const ctx = createContext()
    const wf = new ApprovalWaterfall(ctx, () => {})
    wf.attach()
    expect(wf.respond({ approvalId: "nonexistent", approved: true })).toBe(false)
  })

  // Review fix: the pending entry must be registered BEFORE emit(wire) — a
  // client that responds synchronously inside the emit callback would
  // otherwise find no pending entry (respond → false) and the answerer would
  // park until the fail-closed timeout decides false.
  it("registers pending before emit: a synchronous respond() during emit resolves", async () => {
    const ctx = createContext()
    const wf = new ApprovalWaterfall(ctx, (req) => {
      expect(wf.respond({ approvalId: req.approvalId, approved: true })).toBe(true)
    }, 25)
    wf.attach()
    await expect(getAnswerer(ctx)({ name: "bash", reason: "unit test" })).resolves.toBe(true)
  })
})

describe("ApprovalMuxBridge", () => {
  it("open() yields each emitted request; a client response resolves the waterfall; the stream stays open across approvals", async () => {
    const ctx = createContext()
    const bridge = new ApprovalMuxBridge(ctx, 5_000)
    bridge.attach()
    const stream = bridge.open()
    // Pull FIRST (unawaited): the generator body — which registers this
    // stream's sink — runs synchronously on the first pull and parks until an
    // emit, so the request below cannot race past it.
    const pendingFirst = stream.next()

    // First approval: the answerer parks; the wire request surfaces on the
    // open stream.
    const firstDecision = getAnswerer(ctx)({ name: "bash", reason: "first" })
    const first = await pendingFirst
    expect(first.done).toBe(false)
    const firstRequest = first.value as ApprovalRequestWire
    expect(firstRequest).toMatchObject({ name: "bash", reason: "first" })
    expect(firstRequest.approvalId).toBeTruthy()

    // The client's decision (mux `{type:"approval"}` message value) routes
    // through respond() → the parked answerer resolves.
    expect(bridge.respond({ approvalId: firstRequest.approvalId, approved: true })).toBe(true)
    await expect(firstDecision).resolves.toBe(true)

    // The stream stays open (multiple approvals per session, ruling 2): a
    // second request flows over the SAME stream.
    const secondDecision = getAnswerer(ctx)({ name: "write", reason: "second" })
    const second = await stream.next()
    expect(second.done).toBe(false)
    const secondRequest = second.value as ApprovalRequestWire
    expect(secondRequest).toMatchObject({ name: "write", reason: "second" })
    expect(secondRequest.approvalId).not.toBe(firstRequest.approvalId)
    expect(bridge.respond({ approvalId: secondRequest.approvalId, approved: false })).toBe(true)
    await expect(secondDecision).resolves.toBe(false)
  })

  it("respond() on an unknown approvalId is a no-op (delegates waterfall idempotency)", async () => {
    const ctx = createContext()
    const bridge = new ApprovalMuxBridge(ctx, 5_000)
    expect(bridge.respond({ approvalId: "nonexistent", approved: true })).toBe(false)
  })

  it("dispose() ends open approval streams", async () => {
    const ctx = createContext()
    const bridge = new ApprovalMuxBridge(ctx, 5_000)
    const stream = bridge.open()
    const pending = stream.next() // parks until a request, abort, or dispose
    bridge.dispose()
    expect((await pending).done).toBe(true)
  })

  it("an aborted signal ends the stream (mux cancel / socket-close teardown)", async () => {
    const ctx = createContext()
    const bridge = new ApprovalMuxBridge(ctx, 5_000)
    const controller = new AbortController()
    const stream = bridge.open(controller.signal)
    const pending = stream.next()
    controller.abort()
    expect((await pending).done).toBe(true)
  })

  it("requests are broadcast to every open stream (two mux clients, one decision each)", async () => {
    const ctx = createContext()
    const bridge = new ApprovalMuxBridge(ctx, 5_000)
    bridge.attach()
    const streamA = bridge.open()
    const streamB = bridge.open()
    // Pull both streams BEFORE the request fires (see the pull-first note above).
    const pendingA = streamA.next()
    const pendingB = streamB.next()

    const decision = getAnswerer(ctx)({ name: "bash", reason: "broadcast" })
    const [a, b] = await Promise.all([pendingA, pendingB])
    expect(a.done).toBe(false)
    expect(b.done).toBe(false)
    const requestA = a.value as ApprovalRequestWire
    const requestB = b.value as ApprovalRequestWire
    expect(requestA.approvalId).toBe(requestB.approvalId)

    // The waterfall's respond() is idempotent: A answers first, B's duplicate
    // answer is a no-op — the decision itself is unaffected.
    expect(bridge.respond({ approvalId: requestA.approvalId, approved: true })).toBe(true)
    expect(bridge.respond({ approvalId: requestB.approvalId, approved: false })).toBe(false)
    await expect(decision).resolves.toBe(true)
  })
})
