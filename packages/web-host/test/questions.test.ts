import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { askUser } from "@i-harness/interaction"
import { QuestionMuxBridge, QuestionWaterfall } from "../src/questions.ts"
import type { QuestionRequestWire } from "../src/types.ts"

// `askUser` is the seam the agent calls: it throws when no provider is
// registered and delegates `ask` otherwise — exactly what the waterfall's
// attach() provides, so these tests exercise the full plugin contract.
describe("QuestionWaterfall", () => {
  it("fails closed: no client answer within the timeout → the ask rejects, pending entry removed", async () => {
    const ctx = createContext()
    const emitted: QuestionRequestWire[] = []
    const wf = new QuestionWaterfall(ctx, (req) => { emitted.push(req) }, 25)
    wf.attach()

    const ask = askUser(ctx, { id: "confirm", prompt: "proceed with the release?" })

    // The wire request is emitted (synchronously, before the asker parks)
    // with the seam's fields mapped: prompt → text, id → kind; no options →
    // no options key.
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ text: "proceed with the release?", kind: "confirm" })
    expect(emitted[0]!.questionId).toBeTruthy()
    expect("options" in emitted[0]!).toBe(false)

    // No respond() arrives → the timeout decides, fail-closed: the asker gets
    // an error (a question has no safe default answer to fabricate).
    await expect(ask).rejects.toThrow(/unanswered|timeout/i)

    // Timeout cleanup: the stale questionId is gone, a late answer is a no-op.
    expect(wf.respond({ questionId: emitted[0]!.questionId, answer: "yes" })).toBe(false)
  })

  it("resolves with the answer string when a client answer arrives before the timeout", async () => {
    const ctx = createContext()
    const emitted: QuestionRequestWire[] = []
    const wf = new QuestionWaterfall(ctx, (req) => { emitted.push(req) }, 5_000)
    wf.attach()

    const ask = askUser(ctx, { id: "confirm", prompt: "proceed?", options: ["yes", "no"] })

    // Options propagate onto the wire request (quick-pick choices).
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      questionId: emitted[0]!.questionId,
      text: "proceed?",
      kind: "confirm",
      options: ["yes", "no"],
    })

    // Client answers → the parked asker resolves with the exact text.
    expect(wf.respond({ questionId: emitted[0]!.questionId, answer: "yes do it" })).toBe(true)
    await expect(ask).resolves.toBe("yes do it")

    // Idempotency: a second answer for the same (already resolved) id is a no-op.
    expect(wf.respond({ questionId: emitted[0]!.questionId, answer: "no" })).toBe(false)
  })

  it("omits kind when the seam's id is an empty string", () => {
    const ctx = createContext()
    const emitted: QuestionRequestWire[] = []
    const wf = new QuestionWaterfall(ctx, (req) => { emitted.push(req) }, 5_000)
    wf.attach()
    void askUser(ctx, { id: "", prompt: "unlabeled" })
    expect("kind" in emitted[0]!).toBe(false)
    expect(emitted[0]!.text).toBe("unlabeled")
  })

  it("rejects (never resolves) when the client answer is malformed — fail-closed", async () => {
    const ctx = createContext()
    const emitted: QuestionRequestWire[] = []
    const wf = new QuestionWaterfall(ctx, (req) => { emitted.push(req) }, 5_000)
    wf.attach()

    const ask = askUser(ctx, { id: "q", prompt: "?" })
    expect(wf.respond({ questionId: emitted[0]!.questionId, answer: 42 as unknown as string })).toBe(true)
    await expect(ask).rejects.toThrow(/malformed/i)
  })

  it("respond() on an unknown questionId is a no-op", () => {
    const ctx = createContext()
    const wf = new QuestionWaterfall(ctx, () => {})
    wf.attach()
    expect(wf.respond({ questionId: "nonexistent", answer: "x" })).toBe(false)
  })

  // Review fix mirrored from approval: the pending entry must be registered
  // BEFORE emit — a client that answers synchronously inside the emit callback
  // would otherwise find no pending entry (respond → false) and the asker
  // would park until the fail-closed timeout rejects it.
  it("registers pending before emit: a synchronous respond() during emit resolves", async () => {
    const ctx = createContext()
    const wf = new QuestionWaterfall(ctx, (req) => {
      expect(wf.respond({ questionId: req.questionId, answer: "inline" })).toBe(true)
    }, 25)
    wf.attach()
    await expect(askUser(ctx, { id: "q", prompt: "?" })).resolves.toBe("inline")
  })
})

describe("QuestionMuxBridge", () => {
  it("open() yields each emitted question; a client answer resolves the waterfall; the stream stays open across questions", async () => {
    const ctx = createContext()
    const bridge = new QuestionMuxBridge(ctx, 5_000)
    bridge.attach()
    const stream = bridge.open()
    // Pull FIRST (unawaited): the generator body — which registers this
    // stream's sink — runs synchronously on the first pull and parks until an
    // emit, so the question below cannot race past it.
    const pendingFirst = stream.next()

    // First question: the asker parks; the wire request surfaces on the open stream.
    const firstAsk = askUser(ctx, { id: "confirm", prompt: "first question" })
    const first = await pendingFirst
    expect(first.done).toBe(false)
    const firstRequest = first.value as QuestionRequestWire
    expect(firstRequest).toMatchObject({ text: "first question", kind: "confirm" })
    expect(firstRequest.questionId).toBeTruthy()

    // The client's answer (mux `{type:"answer"}` message value) routes through
    // respond() → the parked asker resolves.
    expect(bridge.respond({ questionId: firstRequest.questionId, answer: "yes one" })).toBe(true)
    await expect(firstAsk).resolves.toBe("yes one")

    // The stream stays open (multiple questions per session, approval ruling 2
    // mirrored): a second question flows over the SAME stream.
    const secondAsk = askUser(ctx, { id: "plan", prompt: "second question" })
    const second = await stream.next()
    expect(second.done).toBe(false)
    const secondRequest = second.value as QuestionRequestWire
    expect(secondRequest).toMatchObject({ text: "second question", kind: "plan" })
    expect(secondRequest.questionId).not.toBe(firstRequest.questionId)
    expect(bridge.respond({ questionId: secondRequest.questionId, answer: "no two" })).toBe(true)
    await expect(secondAsk).resolves.toBe("no two")
  })

  it("respond() on an unknown questionId is a no-op (delegates waterfall idempotency)", async () => {
    const ctx = createContext()
    const bridge = new QuestionMuxBridge(ctx, 5_000)
    expect(bridge.respond({ questionId: "nonexistent", answer: "x" })).toBe(false)
  })

  it("dispose() ends open question streams", async () => {
    const ctx = createContext()
    const bridge = new QuestionMuxBridge(ctx, 5_000)
    const stream = bridge.open()
    const pending = stream.next() // parks until a question, abort, or dispose
    bridge.dispose()
    expect((await pending).done).toBe(true)
  })

  it("an aborted signal ends the stream (mux cancel / socket-close teardown)", async () => {
    const ctx = createContext()
    const bridge = new QuestionMuxBridge(ctx, 5_000)
    const controller = new AbortController()
    const stream = bridge.open(controller.signal)
    const pending = stream.next()
    controller.abort()
    expect((await pending).done).toBe(true)
  })

  it("questions are broadcast to every open stream (two mux clients, one answer each)", async () => {
    const ctx = createContext()
    const bridge = new QuestionMuxBridge(ctx, 5_000)
    bridge.attach()
    const streamA = bridge.open()
    const streamB = bridge.open()
    // Pull both streams BEFORE the question fires (see the pull-first note above).
    const pendingA = streamA.next()
    const pendingB = streamB.next()

    const ask = askUser(ctx, { id: "broadcast", prompt: "who answers?" })
    const [a, b] = await Promise.all([pendingA, pendingB])
    expect(a.done).toBe(false)
    expect(b.done).toBe(false)
    const requestA = a.value as QuestionRequestWire
    const requestB = b.value as QuestionRequestWire
    expect(requestA.questionId).toBe(requestB.questionId)

    // The waterfall's respond() is idempotent: A answers first, B's duplicate
    // answer is a no-op — the ask itself is unaffected.
    expect(bridge.respond({ questionId: requestA.questionId, answer: "from A" })).toBe(true)
    expect(bridge.respond({ questionId: requestB.questionId, answer: "from B" })).toBe(false)
    await expect(ask).resolves.toBe("from A")
  })
})
