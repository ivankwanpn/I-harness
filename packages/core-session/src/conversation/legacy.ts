import type { Session, SessionEvent } from "../events/types.ts"
import type { ConversationCall, ConversationDiagnostic } from "./types.ts"
import type { ConversationSources } from "./sources.ts"
import type { ConversationVisibility } from "./visibility.ts"
import type { ExchangeAcceptedEvent } from "../events/conversation.ts"
import { outcomeField } from "./payload.ts"

export interface LegacyStep {
  start: number
  members: number[]
  calls: number[]
  assistants: number[]
  failed: boolean
  ended: boolean
  suppressed: boolean
  explicitRegion?: boolean
  acceptance?: ExchangeAcceptedEvent
  acceptanceIndex?: number
}

/** Legacy evidence and failure prepass; it never constructs model messages. */
export function inferLegacy(session: Session, visibility: ConversationVisibility, sources: ConversationSources, diagnostics: ConversationDiagnostic[]) {
  const calls = new Map<string, number[]>()
  const results = new Map<string, number[]>()
  const dispatches = new Map<string, number[]>()
  const stepByEvent = new Map<number, LegacyStep>()
  const steps: LegacyStep[] = []
  const suppressedCalls = new Set<string>()
  const suppressedAssistants = new Set<number>()
  const add = (map: Map<string, number[]>, id: string, index: number) => { const entries = map.get(id) ?? []; entries.push(index); map.set(id, entries) }
  const fenceIndex = session.events.findIndex(event => event.type === "conversation/semantics")
  const accepted = new Map<number, { event: ExchangeAcceptedEvent; index: number }>()
  const acceptedAssistants = new Set<number>(), acceptedCallSeqs = new Set<number>(), acceptedCallIds = new Set<string>(), unacceptedResults = new Set<number>()
  for (const [index, event] of session.events.entries()) if (event.type === "model/exchange-accepted" && visibility.selected(event)) {
    accepted.set(event.stepStartSeq, { event, index }); acceptedAssistants.add(event.assistantSeq)
    for (const seq of event.callSeqs) acceptedCallSeqs.add(seq)
  }
  for (const [index, event] of session.events.entries()) if (fenceIndex >= 0 && index > fenceIndex) {
    if (event.type === "assistant/message" && !acceptedAssistants.has(event.seq!)) suppressedAssistants.add(index)
    if (event.type === "tool/call") { if (acceptedCallSeqs.has(event.seq!)) acceptedCallIds.add(event.callId); else suppressedCalls.add(event.callId) }
  }
  for (const [index, event] of session.events.entries()) if (fenceIndex >= 0 && index > fenceIndex && event.type === "tool/result" && !acceptedCallIds.has(event.callId)) unacceptedResults.add(index)
  for (const [index, event] of session.events.entries()) {
    if (!visibility.content(event)) continue
    if (event.type === "tool/call") add(calls, event.callId, index)
    else if (event.type === "tool/result") add(results, event.callId, index)
    else if (event.type === "tool/dispatch") add(dispatches, event.callId, index)
  }
  let active: LegacyStep | undefined
  const close = (ended: boolean) => {
    if (!active) return
    active.ended = ended
    active.suppressed = (active.explicitRegion ? !active.acceptance : active.failed) || active.calls.some(index => !results.has((session.events[index] as Extract<SessionEvent, { type: "tool/call" }>).callId))
    if (active.suppressed) {
      for (const index of active.calls) suppressedCalls.add((session.events[index] as Extract<SessionEvent, { type: "tool/call" }>).callId)
      for (const index of active.assistants) suppressedAssistants.add(index)
    }
    active = undefined
  }
  for (const [index, event] of session.events.entries()) {
    if (!visibility.branch(event)) continue
    if (!visibility.lifecycle(event)) {
      // Hidden content still proves a partial shadow, without participating in
      // acceptance/suppression or being restored to the rendered conversation.
      active?.members.push(index)
      continue
    }
    if (event.type === "step/start") {
      close(true)
      active = { start: index, members: [], calls: [], assistants: [], failed: false, ended: false, suppressed: false }
      if (fenceIndex >= 0 && index > fenceIndex) { active.explicitRegion = true; const acceptance = accepted.get(event.seq!); active.acceptance = acceptance?.event; active.acceptanceIndex = acceptance?.index }
      steps.push(active)
    }
    if (active) {
      active.members.push(index)
      stepByEvent.set(index, active)
      if (event.type === "tool/call") active.calls.push(index)
      else if (event.type === "assistant/message") active.assistants.push(index)
    }
    if (event.type === "step/failed") { if (active) active.failed = true; close(true) }
    else if (event.type === "step/end" || event.type === "turn/start") close(true)
  }
  close(false)
  for (const [id, indices] of calls) {
    if (indices.length > 1 || (results.get(id)?.length ?? 0) > 1) diagnostics.push({ code: "duplicate-call-id", sourceIds: [...indices.map(index => sources.ref(index, "call").id), ...(results.get(id) ?? []).map(index => sources.ref(index, "result").id)] })
  }
  for (const [id, indices] of results) if (!calls.has(id)) diagnostics.push({ code: "orphan-result", sourceIds: indices.map(index => sources.ref(index, "result").id) })
  const matchingDispatches = (index: number, event: Extract<SessionEvent, { type: "tool/call" }>) => (dispatches.get(event.callId) ?? []).filter(dispatchIndex => {
    const dispatch = session.events[dispatchIndex] as Extract<SessionEvent, { type: "tool/dispatch" }>
    return dispatch.eventSeq === undefined ? calls.get(event.callId)?.length === 1 : sources.ref(index, "call").addressable && dispatch.eventSeq === event.seq
  })
  for (const [id, indices] of dispatches) for (const index of indices) {
    const matching = (calls.get(id) ?? []).filter(callIndex => matchingDispatches(callIndex, session.events[callIndex] as Extract<SessionEvent, { type: "tool/call" }>).includes(index))
    if (matching.length !== 1 || suppressedCalls.has(id)) diagnostics.push({ code: "unaccepted-dispatch", sourceIds: [sources.ref(index, "dispatch").id] })
  }
  for (const step of steps) {
    const hidden = step.members.filter(index => visibility.shadowed(session.events[index]!))
    const visible = step.members.filter(index => visibility.content(session.events[index]!) && ["tool/call", "tool/result", "assistant/message"].includes(session.events[index]!.type))
    if (hidden.length && visible.length) diagnostics.push({ code: "partial-exchange-shadow", sourceIds: [...hidden, ...visible].map(index => sources.ref(index, "event").id) })
  }
  const callMetadata = (index: number): ConversationCall => {
    const event = session.events[index] as Extract<SessionEvent, { type: "tool/call" }>
    const ambiguous = calls.get(event.callId)!.length !== 1 || (results.get(event.callId)?.length ?? 0) > 1
    const resultIndex = ambiguous ? undefined : results.get(event.callId)?.[0]
    const dispatchIndices = matchingDispatches(index, event)
    const dispatchIndex = dispatchIndices.length === 1 ? dispatchIndices[0] : undefined
    const result = resultIndex === undefined ? undefined : session.events[resultIndex] as Extract<SessionEvent, { type: "tool/result" }>
    const step = stepByEvent.get(index)
    return {
      callId: event.callId, name: event.name, call: sources.ref(index, "call"),
      ...(resultIndex === undefined ? {} : { result: sources.ref(resultIndex, "result") }),
      ...(dispatchIndex === undefined ? {} : { dispatch: sources.ref(dispatchIndex, "dispatch") }),
      outcome: ambiguous || dispatchIndices.length > 1 ? "unknown" : recordedOutcome(result, dispatchIndices.length > 0, !!step?.failed, !!step?.ended, dispatches.size > 0),
    }
  }
  return { calls, results, steps, stepByEvent, suppressedCalls, suppressedAssistants, unacceptedResults, fenceIndex, callMetadata }
}

/** Reported outcome only: legacy records cannot authenticate a synthetic producer. */
function recordedOutcome(result: Extract<SessionEvent, { type: "tool/result" }> | undefined, dispatched: boolean, failed: boolean, ended: boolean, hasDispatchBoundary: boolean): ConversationCall["outcome"] {
  if (!result) return dispatched || ended ? "unknown" : "pending"
  if (!result.isError) return "success"
  const output = outcomeField(result, "output")
  const code = outcomeField(output, "code"), replay = outcomeField(output, "replay")
  if (code === "TOOL_OUTCOME_UNKNOWN" && replay === false) return "unknown"
  if (code === "TOOL_ABORTED_BEFORE_DISPATCH" || code === "TOOL_CANCELLED_BY_SIBLING") {
    if (dispatched) return "unknown"
    if (failed || hasDispatchBoundary) return "not-dispatched"
  }
  return "error"
}
