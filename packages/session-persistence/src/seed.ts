import { createHash } from "node:crypto"
import { CURRENT_FORMAT_VERSION, isContextEventType, validateConversationHistory, type SessionEvent, type InputProvenance } from "@i-harness/core-session"

export class SessionForkUnavailableError extends Error {
  readonly code = "fork-unavailable" as const

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SessionForkUnavailableError"
  }
}

export function materializeMissingImageAdmissions(source: readonly SessionEvent[], retained: readonly SessionEvent[]): SessionEvent[] {
  const retainedSet = new Set(retained)
  const admissions = new Map<string, Extract<SessionEvent, { type: "agent/input/admitted" }>>()
  const replacements = new Map<SessionEvent, SessionEvent>()
  for (const event of source) {
    if (event.type === "agent/input/admitted") admissions.set(event.inputId, event)
    if (event.type !== "user/message" || event.imageInputId === undefined || !retainedSet.has(event)) continue
    const admission = admissions.get(event.imageInputId)
    if (!admission?.images?.length) throw new Error(`image admission not found for forked user/message: ${event.imageInputId}`)
    if (retainedSet.has(admission)) continue
    const { imageInputId: _imageInputId, ...message } = event
    replacements.set(event, { ...message, images: admission.images })
  }
  return retained.map((event) => replacements.get(event) ?? event)
}

export function remapSeedEvent(event: SessionEvent, index: number, renumbered: ReadonlyMap<number, number>): SessionEvent {
  if (event.type === "conversation/semantics" || event.type === "model/exchange-accepted") throw new SessionForkUnavailableError("accepted semantics require batch seed transformation")
  return remapSeedCoordinates(event, index, renumbered)
}

function remapSeedCoordinates(event: SessionEvent, index: number, renumbered: ReadonlyMap<number, number>): SessionEvent {
  const remap = (seqs: number[] | undefined): number[] =>
    (seqs ?? []).flatMap((seq) => {
      const mapped = renumbered.get(seq)
      return mapped === undefined ? [] : [mapped]
    })
  if (event.type === "compaction/summary") return { ...event, seq: index, shadowedSeqs: remap(event.shadowedSeqs) }
  if (event.type === "compaction/reset") return { ...event, seq: index, removedSeqs: remap(event.removedSeqs) }
  if (event.type === "session/title") return { ...event, seq: index, messageSeqs: remap(event.messageSeqs) }
  if (event.type === "model/exchange-accepted") {
    const required = [event.stepStartSeq, event.assistantSeq, ...event.callSeqs]
    if (required.some(seq => !renumbered.has(seq))) throw new SessionForkUnavailableError("partial accepted exchange in seed")
    return { ...event, seq: index, stepStartSeq: renumbered.get(event.stepStartSeq)!, assistantSeq: renumbered.get(event.assistantSeq)!, callSeqs: remap(event.callSeqs) }
  }
  if (event.type === "tool/dispatch" && event.eventSeq !== undefined) {
    const eventSeq = renumbered.get(event.eventSeq)
    if (eventSeq === undefined) { const { eventSeq: _parent, ...rest } = event; return { ...rest, seq: index } }
    return { ...event, seq: index, eventSeq }
  }
  // M76: `anchorSeq` names a seq the same way — it is the FIRST event the marker
  // hides, and `rewindCuts` reads the window as [anchorSeq, the marker's own seq)
  // — so it rides the SAME map. The session fork never noticed: it DROPS rewind
  // markers before this pass (:150-152). The subagent's `forkTurns` keeps them,
  // and there a carried-over PARENT coordinate names an unrelated child event:
  // `rewindCuts` resolves a subset window — or none at all, once the stale anchor
  // lands at or past the marker's child-side seq — and the region the rewind hid
  // comes back onto the child's surface.
  //
  // An anchor this child never received (the seed begins INSIDE the window the
  // marker opened, so no child-side target exists) opens the window on the
  // child's FIRST event. That is the parent's surface restricted to this log:
  // every event the child owns before the marker was hidden on the parent's,
  // whereas a stale coordinate would name an unrelated event (or be discarded).
  //
  // M76 final review: `?? 0` is the fallback for THAT miss only, and the numeric
  // test below is what keeps it there. A marker with no numeric `anchorSeq` at
  // all (a persisted line that lost the field — resume does not re-run append's
  // validation) is different input with its own rule: `rewindCuts` refuses it
  // outright (`core-session/src/index.ts:281`, "unsealed events are NEVER
  // hidden"), so a `0` minted for it would answer that malformed input with a
  // LIVE `[0, marker)` window hiding the child's whole prefix — silent
  // over-hiding on the one input the projection elsewhere keeps inert. A
  // non-numeric anchor is therefore carried through untouched and the
  // malformed-marker rule keeps deciding.
  if (event.type === "rewind/point") {
    const anchorSeq = typeof event.anchorSeq === "number"
      ? renumbered.get(event.anchorSeq) ?? 0
      : event.anchorSeq
    return { ...event, seq: index, anchorSeq }
  }
  return { ...event, seq: index }
}

/** Batch semantics must precede coordinate remapping. An isolated event cannot recover a sliced fence. */
export function remapConversationSeed(input: { source: readonly SessionEvent[]; retained: readonly SessionEvent[]; sourceFormat: number }): SessionEvent[] {
  const { source, retained } = input
  validateConversationHistory(source, input.sourceFormat)
  const retainedSeqs = new Set(retained.map(event => event.seq))
  const calls = new Map<string, number | null>()
  for (const event of source) if (event.type === "tool/call" && event.seq !== undefined) calls.set(event.callId, calls.has(event.callId) ? null : event.seq)
  const relatedCalls = new Set<number>()
  for (const event of retained) if (event.type === "tool/result" || event.type === "tool/dispatch") {
    const seq = event.type === "tool/dispatch" && event.eventSeq !== undefined ? event.eventSeq : calls.get(event.callId)
    if (seq != null) relatedCalls.add(seq)
  }
  for (const event of source) if (event.type === "model/exchange-accepted") {
    const bundle = [event.seq!, event.stepStartSeq, event.assistantSeq, ...event.callSeqs]
    const touched = bundle.some(seq => retainedSeqs.has(seq)) || event.callSeqs.some(seq => relatedCalls.has(seq))
    if (touched && !bundle.every(seq => retainedSeqs.has(seq))) throw new SessionForkUnavailableError("partial accepted exchange in seed")
  }
  const originalFence = source.findIndex(event => event.type === "conversation/semantics")
  const sourcePositions = new Map(source.map((event, index) => [event.seq, index]))
  const seed: SessionEvent[] = []
  let fenced = false
  for (const event of retained) {
    if (event.type === "conversation/semantics" || isContextEventType(event.type)) continue
    if (!fenced && originalFence >= 0 && (sourcePositions.get(event.seq) ?? -1) > originalFence) {
      seed.push({ ...source[originalFence]! }); fenced = true
    }
    if (event.type === "model/exchange-accepted" && event.version === 2) { const { request: _request, ...structural } = event; seed.push({ ...structural, version: 1 }) }
    else seed.push(event)
  }
  const materialized = materializeMissingImageAdmissions(source, seed)
  const renumbered = new Map<number, number>()
  for (const [index, event] of materialized.entries()) if (event.seq !== undefined) renumbered.set(event.seq, index)
  const namespace = (kind: string, id: string) => `seed:${createHash("sha256").update(JSON.stringify([kind, id])).digest("hex")}`
  const inherit = (provenance?: InputProvenance): InputProvenance => ({ kind: "inherited", authority: "observation", scope: provenance?.scope ?? "turn", producer: provenance?.producer ?? "session.seed", ...(provenance?.originSessionId ? { originSessionId: provenance.originSessionId } : {}) })
  const result = materialized.map((event, index) => {
    let mapped = remapSeedCoordinates(event, index, renumbered)
    if (mapped.type === "step/start" && mapped.actionId && mapped.attemptId) mapped = { ...mapped, actionId: namespace("action", mapped.actionId), attemptId: namespace("attempt", mapped.attemptId) }
    if (mapped.type === "model/exchange-accepted") mapped = { ...mapped, actionId: namespace("action", mapped.actionId), attemptId: namespace("attempt", mapped.attemptId), exchangeId: namespace("exchange", mapped.exchangeId) }
    if (mapped.type === "agent/input/admitted" || mapped.type === "subagent/inbox") mapped = { ...mapped, provenance: inherit(mapped.provenance) }
    if (mapped.type === "user/message") mapped = { ...mapped, provenance: inherit(mapped.provenance), ...(mapped.input ? { input: { ...mapped.input, provenance: inherit(mapped.input.provenance) } } : {}) }
    return mapped
  })
  try { validateConversationHistory(result, CURRENT_FORMAT_VERSION) }
  catch (cause) { throw new SessionForkUnavailableError("retained seed cannot preserve conversation semantics", { cause }) }
  return result
}
