import { createHash } from "node:crypto"
import { CURRENT_FORMAT_VERSION, isContextEventType, validateConversationHistory, createConversationValidationIndex, copyConversationData, type SessionEvent, type SessionEventView, type InputProvenance, type ConversationValidationIndex, type ConversationAddress, type ConversationItemRef } from "@i-harness/core-session"

export class SessionForkUnavailableError extends Error {
  readonly code = "fork-unavailable" as const

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SessionForkUnavailableError"
  }
}

export function materializeMissingImageAdmissions(source: readonly SessionEventView[], retained: readonly SessionEventView[]): SessionEventView[] {
  const retainedSet = new Set(retained)
  const admissions = new Map<string, Extract<SessionEventView, { type: "agent/input/admitted" }>>()
  const replacements = new Map<SessionEventView, SessionEventView>()
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

export function remapSeedEvent(event: SessionEventView, index: number, renumbered: ReadonlyMap<number, number>): SessionEvent {
  if (event.type === "conversation/semantics" || event.type === "model/exchange-accepted" || event.type === 'compaction/replacement') throw new SessionForkUnavailableError("conversation semantics require batch seed transformation")
  return remapSeedCoordinates(event, index, renumbered)
}

function remapSeedCoordinates(input: SessionEventView, index: number, renumbered: ReadonlyMap<number, number>): SessionEvent {
  const event = copyConversationData(input)
  const remap = (seqs: readonly number[] | undefined): number[] =>
    (seqs ?? []).flatMap((seq) => {
      const mapped = renumbered.get(seq)
      return mapped === undefined ? [] : [mapped]
    })
  if (event.type === 'compaction/replacement') {
    const address = (at: ConversationAddress): ConversationAddress => {
      const seq = renumbered.get(at.seq)
      if (seq === undefined) throw new SessionForkUnavailableError('partial replacement proof in seed')
      return { seq, part: at.part }
    }
    const ref = (item: ConversationItemRef): ConversationItemRef => ({ kind: item.kind, at: address(item.at) })
    return { ...event, seq: index, replacementId: seedNamespace('replacement', event.replacementId),
      coverage: event.coverage.map(entry => ({ item: ref(entry.item), sources: entry.sources.map(address) })), insertBefore: ref(event.insertBefore) }
  }
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
export function remapConversationSeed(input: { source: readonly SessionEventView[]; retained: readonly SessionEventView[]; sourceFormat: number }): SessionEvent[] {
  const { source, retained } = input
  const sourceIndex = createConversationValidationIndex(source, { formatVersion: input.sourceFormat })
  const replacements = source.some(event => event.type === 'compaction/replacement')
  if (replacements) requireReplacementSeedProof(source, retained, sourceIndex)
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
  const seed: SessionEventView[] = []
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
  const inherit = (provenance?: InputProvenance): InputProvenance => ({ kind: "inherited", authority: "observation", scope: provenance?.scope ?? "turn", producer: provenance?.producer ?? "session.seed", ...(provenance?.originSessionId ? { originSessionId: provenance.originSessionId } : {}) })
  const result = materialized.map((event, index) => {
    let mapped = remapSeedCoordinates(event, index, renumbered)
    if (mapped.type === "step/start" && mapped.actionId && mapped.attemptId) mapped = { ...mapped, actionId: seedNamespace("action", mapped.actionId), attemptId: seedNamespace("attempt", mapped.attemptId) }
    if (mapped.type === "model/exchange-accepted") mapped = { ...mapped, actionId: seedNamespace("action", mapped.actionId), attemptId: seedNamespace("attempt", mapped.attemptId), exchangeId: seedNamespace("exchange", mapped.exchangeId) }
    if (mapped.type === "agent/input/admitted" || mapped.type === "subagent/inbox") mapped = { ...mapped, provenance: inherit(mapped.provenance) }
    if (mapped.type === "user/message") mapped = { ...mapped, provenance: inherit(mapped.provenance), ...(mapped.input ? { input: { ...mapped.input, provenance: inherit(mapped.input.provenance) } } : {}) }
    return mapped
  })
  try { validateConversationHistory(result, CURRENT_FORMAT_VERSION) }
  catch (cause) { throw new SessionForkUnavailableError("retained seed cannot preserve conversation semantics", { cause }) }
  if (replacements) compareReplacementSeedView(sourceIndex, result, retained, renumbered)
  return result
}

function seedNamespace(kind: string, id: string): string {
  return `seed:${createHash('sha256').update(JSON.stringify([kind, id])).digest('hex')}`
}

/** Resolve proof over source identities before operational removal or remapping.
 * Missing proof is a refusal, never an instruction to widen the chosen tail. */
function requireReplacementSeedProof(source: readonly SessionEventView[], retained: readonly SessionEventView[], index: ConversationValidationIndex): void {
  const retainedIdentities = new Set(retained), sourceIdentities = new Set(source)
  if (retained.some(event => !sourceIdentities.has(event))) throw new SessionForkUnavailableError('seed event does not belong to source')
  const bySeq = new Map<number, SessionEventView | null>()
  for (const event of source) if (event.seq !== undefined) bySeq.set(event.seq, bySeq.has(event.seq) ? null : event)
  const visited = new Set<number>(), dependencies = index.replacementDependencies()
  const pending = retained.flatMap(event => event.type === 'compaction/replacement' ? [event.seq!] : [])
  while (pending.length) {
    const seq = pending.pop()!
    if (visited.has(seq)) continue
    const event = bySeq.get(seq)
    if (!event || !retainedIdentities.has(event) || isContextEventType(event.type)) throw new SessionForkUnavailableError('partial replacement proof in selected boundary')
    visited.add(seq)
    for (const dependency of dependencies.get(seq) ?? []) pending.push(dependency)
    if (event.type === 'compaction/summary') for (const dependency of event.shadowedSeqs) pending.push(dependency)
    if (event.type === 'compaction/reset') for (const dependency of event.removedSeqs ?? []) pending.push(dependency)
    if (event.type === 'rewind/point') pending.push(event.anchorSeq)
  }
  // Later markers affecting the selected prefix cannot be smuggled in, nor
  // omitted while claiming that the selected source view was preserved.
  const end = retained.reduce((last, event) => Math.max(last, event.seq ?? -1), -1)
  const selectedSeqs = new Set(retained.map(event => event.seq))
  for (const event of source) if ((event.seq ?? -1) > end && (
    event.type === 'compaction/replacement' && event.coverage.some(entry => entry.sources.some(at => selectedSeqs.has(at.seq)))
    || event.type === 'compaction/summary' && event.shadowedSeqs.some(seq => selectedSeqs.has(seq))
    || event.type === 'compaction/reset' && (event.removedSeqs ?? []).some(seq => selectedSeqs.has(seq))
    || event.type === 'rewind/point' && retained.some(item => item.seq !== undefined && item.seq >= event.anchorSeq && item.seq < event.seq!))) throw new SessionForkUnavailableError('source view requires a marker outside selected boundary')
}

function compareReplacementSeedView(source: ConversationValidationIndex, result: SessionEvent[], retained: readonly SessionEventView[], remap: ReadonlyMap<number, number>): void {
  const end = retained.reduce((last, event) => Math.max(last, event.seq ?? -1), -1)
  const parent = source.history(end).items.filter(item => remap.has(item.establishment.seq!))
  const child = createConversationValidationIndex(result, { formatVersion: CURRENT_FORMAT_VERSION }).history().items
  const identity = (item: typeof parent[number], map: (seq: number) => number | undefined) => [item.kind, map(item.establishment.seq!), item.establishment.part,
    [...new Set([...item.sources, ...item.provenance.evidence].map(at => JSON.stringify([map(at.seq!), at.part])))].sort()]
  if (JSON.stringify(parent.map(item => identity(item, seq => remap.get(seq)))) !== JSON.stringify(child.map(item => identity(item, seq => seq)))) throw new SessionForkUnavailableError('seed cannot preserve ordered active source view')
}
