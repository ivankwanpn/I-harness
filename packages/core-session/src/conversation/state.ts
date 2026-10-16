import type { SessionView as Session } from "../managed/types.ts"
import type { ConversationProjection, ConversationCall } from "./types.ts"
import { conversationSources } from "./sources.ts"
import { conversationVisibility } from "./visibility.ts"

export interface ConversationState {
  archive: { eventCount: number; lastSeq?: number }
  branch: { sourceId: string; anchorSeq: number }[]
  rewrites: { sourceId: string; type: string }[]
  itemIds: string[]; sourceIds: string[]; pendingInputIds: string[]; unsettledDelegationIds: string[]
  pending: { inputId: string; state: "admitted" | "promoted"; sourceIds: string[] }[]
  effects?: { itemId: string; callId: string; outcome: ConversationCall["outcome"]; sourceIds: string[] }[]
  turnSourceId?: string
}
export type ConversationStateRead = { kind: "available"; state: ConversationState } | { kind: "ambiguous"; sourceIds: readonly string[] }

/** Replay facts only: no claim, execution, scheduling or delivery authority. */
export function readConversationState(session: Session, projection: ConversationProjection): ConversationStateRead {
  const visibility = conversationVisibility(session)
  const sources = conversationSources(session, projection.ownerSessionId, [])
  const seedEnd = session.header?.parentSession === undefined ? 0 : session.header.seedLength ?? 0
  let turn: number | undefined
  const pending = new Map<string, { inputId: string; state: "admitted" | "promoted"; sourceIds: string[] }>()
  const consumed = new Set<string>(), delegations = new Map<string, string>()
  const branch: ConversationState["branch"] = [], rewrites: ConversationState["rewrites"] = []
  for (const [index, event] of session.events.entries()) {
    if (!visibility.branch(event)) continue
    const sourceId = sources.ref(index, "event").id
    if (event.type === "rewind/point") branch.push({ sourceId, anchorSeq: event.anchorSeq })
    if (["rewind/point", "compaction/summary", "compaction/reset", "compaction/prune"].includes(event.type)) rewrites.push({ sourceId, type: event.type })
    if (index < seedEnd) continue
    // Both lifecycle boundaries survive compaction content hiding.
    if (event.type === "turn/start") {
      if (turn !== undefined) return { kind: "ambiguous", sourceIds: [sources.ref(turn, "event").id, sourceId] }
      turn = index
    } else if (event.type === "turn/end") {
      if (turn === undefined) return { kind: "ambiguous", sourceIds: [sourceId] }
      turn = undefined
    } else if (event.type === "agent/input/admitted") pending.set(event.inputId, { inputId: event.inputId, state: "admitted", sourceIds: [sources.ref(index, "admission").id] })
    else if (event.type === "agent/input/promoted") {
      const previous = pending.get(event.inputId)
      pending.set(event.inputId, { inputId: event.inputId, state: "promoted", sourceIds: [...previous?.sourceIds ?? [], sourceId] })
    } else if (event.type === "agent/input/cancelled") pending.delete(event.inputId)
    else if (event.type === "user/message") {
      const id = event.input?.inputId ?? event.imageInputId
      if (id) consumed.add(id)
    } else if (event.type === "subagent/start") delegations.set(event.taskId, sourceId)
    else if (event.type === "subagent/end" && event.outcome !== "recovery-required") delegations.delete(event.taskId)
  }
  for (const id of consumed) pending.delete(id)
  const effects = projection.items.flatMap(item => (item.exchange?.calls ?? []).filter(call => call.outcome === "unknown" || call.outcome === "pending")
    .map(call => ({ itemId: item.id, callId: call.callId, outcome: call.outcome, sourceIds: [call.call, call.dispatch, call.result].flatMap(source => source ? [source.id] : []) })))
  const unsettledItems = new Set(effects.map(effect => effect.itemId))
  const protectedItems = projection.items.filter(item => item.provenance.scope === "session" || item.kind === "input" && turn !== undefined && item.sources.some(source => source.eventIndex > turn!) || item.exchange && item.exchange.state !== "closed" || unsettledItems.has(item.id))
  const itemIds = protectedItems.map(item => item.id)
  const sourceIds = [...new Set([...protectedItems.flatMap(item => [...item.sources, ...item.provenance.evidence].map(source => source.id)), ...[...pending.values()].flatMap(input => input.sourceIds), ...delegations.values()])]
  const lastSeq = session.events.at(-1)?.seq
  return { kind: "available", state: {
    archive: { eventCount: session.events.length, ...(lastSeq === undefined ? {} : { lastSeq }) }, branch, rewrites,
    itemIds, sourceIds, pendingInputIds: [...pending.keys()], unsettledDelegationIds: [...delegations.keys()], pending: [...pending.values()], effects,
    ...(turn === undefined ? {} : { turnSourceId: sources.ref(turn, "event").id }),
  } }
}
