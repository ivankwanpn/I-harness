import { expect, it } from "vitest"
import { append, createSession, createNondurableFactOwner } from "@i-harness/core-session"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { reductionGroups, reductionSourceCurrent, selectReductionRuns } from "@i-harness/context-engine"
import { createAdmission } from "../src/agent/admission.ts"
import { createAgentContext } from "../src/agent/context.ts"
import { createStepInput } from "../src/agent/step-input.ts"
import { createRecovery } from "../src/agent/recovery.ts"
import { captureRequestCandidate, sameRequestCandidate } from "../src/agent/request-snapshot.ts"

it.each([false, true])("contradictory dispatch invalidates the actual candidate guard for a closed exchange (explicit=%s)", async explicit => {
  const session = createSession()
  if (explicit) append(session, { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1" })
  const step = session.events.length
  append(session, { type: "step/start", ...(explicit ? { actionId: "a", attemptId: "attempt" } : {}) })
  const call = session.events.length
  append(session, { type: "tool/call", callId: "c", name: "probe", args: {} })
  const assistant = session.events.length
  append(session, { type: "assistant/message", text: "called" })
  const acceptance = session.events.length
  if (explicit) append(session, { type: "model/exchange-accepted", version: 1, exchangeId: "accepted", actionId: "a", attemptId: "attempt", stepStartSeq: step, assistantSeq: assistant, callSeqs: [call] })
  const result = session.events.length
  append(session, { type: "tool/result", callId: "c", name: "probe", isError: true, output: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } })
  append(session, { type: "step/end" })
  let transports = 0
  const model = { async *stream() { transports++; yield { type: "end" as const } } }
  const action = createNondurableFactOwner(session).beginAction()
  const sources: ReturnType<typeof action.registerSettlementSource>[] = []
  const deps = { session, model, tools: createToolRegistry(createContext()), systemPrompt: "s",
    facts: action.facts, assertFactOpen: action.assertOpen,
    registerFactSource(drain: () => Promise<void>) {
      const source = action.registerSettlementSource(drain)
      sources.push(source)
      return source
    },
  }
  let candidate: Awaited<ReturnType<ReturnType<typeof createAdmission>>> | undefined
  try {
    const context = createAgentContext(deps, "owner")
    const admit = createAdmission(deps, context, createStepInput(deps, context), createRecovery(deps, context))
    const admitted = await admit(action.signal, { sessionId: "owner", turnId: "guard" }, () => 1)
    candidate = admitted
    const before = candidate.captured
    const exchange = before.snapshot.conversation.items.find(item => item.exchange)!
    expect(exchange.exchange).toMatchObject({ state: "closed", calls: [{ outcome: "error" }] })
    expect(before.snapshot.protection.itemIds).toEqual([])
    const selected = reductionGroups(before.snapshot)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ complete: true, protected: false })
    expect(reductionSourceCurrent(before.snapshot, selected, before.snapshot)).toBe(true)
    const dispatch = session.events.length
    append(session, { type: "tool/dispatch", callId: "c", eventSeq: call })
    const after = context.captureCandidate()
    expect(after.snapshot.conversation.items.find(item => item.exchange)?.exchange).toMatchObject({ state: "unresolved", calls: [{ outcome: "unknown" }] })
    expect(after.snapshot.coordinates.semanticRevision).toBe(before.snapshot.coordinates.semanticRevision)
    expect(after.snapshot.coordinates.branchId).toBe(before.snapshot.coordinates.branchId)
    expect(after.snapshot.coordinates.contextEpoch).toBe(before.snapshot.coordinates.contextEpoch)
    expect(after.snapshot.surfaceRevision).toBe(before.snapshot.surfaceRevision)
    expect(after.snapshot.coordinates.protectionRevision).not.toBe(before.snapshot.coordinates.protectionRevision)
    expect(after.snapshot.protection.itemIds).toEqual([exchange.id])
    expect(after.snapshot.protection.sourceIds).toEqual([
      JSON.stringify(["owner", step, "step"]), JSON.stringify(["owner", call, "call"]),
      ...(explicit ? [JSON.stringify(["owner", acceptance, "acceptance"])] : []),
      JSON.stringify(["owner", dispatch, "dispatch"]), JSON.stringify(["owner", result, "result"]), JSON.stringify(["owner", assistant, "message"]),
    ])
    const changed = after.snapshot.conversation.items.find(item => item.exchange)!
    expect(changed.id).toBe(exchange.id)
    expect(changed.exchange!.calls).toEqual([{
      ...exchange.exchange!.calls[0], outcome: "unknown",
      dispatch: { id: JSON.stringify(["owner", dispatch, "dispatch"]), eventIndex: dispatch, seq: dispatch, part: "dispatch", addressable: true },
    }])
    expect(sameRequestCandidate(before, after)).toBe(false)
    expect(reductionSourceCurrent(before.snapshot, selected, after.snapshot)).toBe(false)
    expect(reductionGroups(after.snapshot)).toEqual([expect.objectContaining({ complete: false, protected: true })])
    expect(selectReductionRuns(after.snapshot, {})).toEqual([])
    const guardedStream = async () => {
      for await (const _event of admitted.prepared.stream({ validateBeforeTransport: admitted.validateBeforeTransport })) { /* consume the real prepared boundary */ }
    }
    await expect(guardedStream()).rejects.toMatchObject({ code: "CONTEXT_INPUT_STALE" })
    expect(transports).toBe(0)
    expect(session.events.filter(event => event.type.startsWith("compaction/"))).toEqual([])
  } finally {
    try { candidate?.execution.close() }
    finally {
      action.finish()
      const settled = await Promise.allSettled(sources.map(source => source.close()))
      const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, "Freshness fixture settlement requires recovery")
    }
  }
})

it("keeps a settled closed success eligible and stable under matching dispatch evidence", () => {
  const session = createSession()
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "c", name: "probe", args: {} })
  append(session, { type: "assistant/message", text: "called" }); append(session, { type: "tool/result", callId: "c", name: "probe", output: "ok" }); append(session, { type: "step/end" })
  const model = { async *stream() {} }, surface = { systemPrompt: "s", tools: [] }
  const before = captureRequestCandidate(session, "owner", { model }, surface, 0)
  append(session, { type: "tool/dispatch", callId: "c", eventSeq: 1 })
  const after = captureRequestCandidate(session, "owner", { model }, surface, 0)
  expect(after.snapshot.protection.itemIds).toEqual([])
  expect(sameRequestCandidate(before, after)).toBe(true)
})

it("hashes pending-to-unknown effect state even when protected source IDs stay equal", () => {
  const session = createSession()
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "c", name: "probe", args: {} })
  const model = { async *stream() {} }, surface = { systemPrompt: "s", tools: [] }
  const before = captureRequestCandidate(session, "owner", { model }, surface, 0)
  append(session, { type: "step/end" })
  const after = captureRequestCandidate(session, "owner", { model }, surface, 0)
  expect(before.snapshot.conversation.items[0]!.exchange!.calls[0]!.outcome).toBe("pending")
  expect(after.snapshot.conversation.items[0]!.exchange!.calls[0]!.outcome).toBe("unknown")
  expect(after.snapshot.protection).toEqual(before.snapshot.protection)
  expect(after.snapshot.coordinates.semanticRevision).toBe(before.snapshot.coordinates.semanticRevision)
  expect(sameRequestCandidate(before, after)).toBe(false)
})
