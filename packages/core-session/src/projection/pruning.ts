import { eventArchive, type ConversationEventArchive } from '../conversation/archive.ts'
import type { SessionView as Session } from "../managed/types.ts"

// M33: one pruned tool/result — the stringified output is narrowed on the
// projection surface to `head` + a placeholder + `tail` (`removedBytes` is the
// byte count of the middle that was cut). This record is what
// `compaction/prune` events carry; the projection alone applies it.
export interface PruneRecord {
  callId: string
  head: string
  tail: string
  removedBytes: number
}

/** The projection-side substitute for a pruned tool/result. */
export function renderPruneSubstitute(record: PruneRecord): string {
  return `${record.head}\n…(pruned ${record.removedBytes} bytes)…\n${record.tail}`
}

// M33: fold EVERY compaction/prune event into callId → record (last wins per
// callId — later prune passes may re-plan an earlier pass's callId). The map
// drives deriveMessages' tool/result projection AND the compaction engine's
// summary-input render; the durable log is never rewritten.
export function derivePruneSubstitutes(session: Session): Map<string, PruneRecord> {
  return archivePruneSubstitutes(eventArchive(session.events))
}

/** Shared archive reader for committed and prospective payload projection. */
export function archivePruneSubstitutes(archive: ConversationEventArchive): Map<string, PruneRecord> {
  const map = new Map<string, PruneRecord>()
  for (let index = 0; index < archive.length; index++) {
    const ev = archive.get(index)
    if (ev.type !== "compaction/prune") continue
    // defensive `?? []`: persisted logs bypass append validation (fromJSONL
    // does not validate), so a malformed marker must not throw here
    for (const record of ev.pruned ?? []) map.set(record.callId, record)
  }
  return map
}
import type { SessionEventView } from '../managed/types.ts'
import type { ConversationPruneDependencyView } from '../conversation/restoration-types.ts'

type PrunePosition = { eventIndex: number; recordIndex: number; seq: unknown }
const pruneViews = new WeakMap<ConversationPruneDependencyView, { positions: Map<string, PrunePosition>; current(): boolean }>()

/** Original prune owner retains positions only; substitute bodies are prepared on demand. */
export function createPruneDependencyIndex() {
  let positions = new Map<string, PrunePosition>(), eventCount = 0, revision = 0
  const read = (): ConversationPruneDependencyView => {
    const version = revision
    const view = Object.freeze({ eventCount }) as ConversationPruneDependencyView
    pruneViews.set(view, { positions, current: () => revision === version })
    return view
  }
  return { read, stage(events: readonly SessionEventView[]) {
    const version = revision, next = new Map(positions), count = eventCount + events.length
    events.forEach((event, offset) => {
      if (event.type === 'compaction/prune') (event.pruned ?? []).forEach((record, recordIndex) => next.set(record.callId, { eventIndex: eventCount + offset, recordIndex, seq: event.seq }))
    })
    events = [] // Do not retain prune payloads through a held stage handle.
    return { commit() {
      if (revision !== version) throw new TypeError('Stale prune stage')
      positions = next; eventCount = count; revision++
      return read()
    } }
  } }
}

export async function preparePruneSubstitutes(view: ConversationPruneDependencyView, selectedCallIds: Iterable<string>, readEvent: (ordinal: number) => Promise<SessionEventView>): Promise<Map<string, PruneRecord>> {
  const state = pruneViews.get(view)
  const check = () => { if (!state || !state.current()) throw new TypeError('Invalid or stale prune dependency view') }
  check()
  const result = new Map<string, PruneRecord>()
  for (const callId of new Set(selectedCallIds)) {
    check()
    const position = state!.positions.get(callId)
    if (!position) throw new TypeError('Missing prune dependency: ' + callId)
    const event = await readEvent(position.eventIndex)
    check()
    const record = event.seq === position.seq && event.type === 'compaction/prune' ? event.pruned?.[position.recordIndex] : undefined
    if (!record || record.callId !== callId) throw new TypeError('Prune dependency source mismatch')
    result.set(callId, record)
  }
  check()
  return result
}

/** Distinguish legitimately unpruned calls before any payload acquisition. */
export function selectPruneDependencies(view: ConversationPruneDependencyView, selectedCallIds: Iterable<string>): ReadonlySet<string> {
  const state = pruneViews.get(view)
  const check = () => { if (!state || !state.current()) throw new TypeError('Invalid or stale prune dependency view') }
  check(); const selected = new Set<string>()
  for (const callId of selectedCallIds) { check(); if (state!.positions.has(callId)) selected.add(callId) }
  check(); return selected
}

/** Prospective original dependency metadata only, never prune payload retention. */
export function extendPruneDependencyView(view:ConversationPruneDependencyView,events:readonly SessionEventView[]):ConversationPruneDependencyView {
 const original=pruneViews.get(view);if(!original||!original.current())throw new TypeError('Invalid or stale prune dependency view')
 const positions=new Map(original.positions);events.forEach((event,offset)=>{if(event.type==='compaction/prune')event.pruned?.forEach((record,recordIndex)=>positions.set(record.callId,{eventIndex:view.eventCount+offset,recordIndex,seq:event.seq}))})
 const result=Object.freeze({eventCount:view.eventCount+events.length}) as ConversationPruneDependencyView;pruneViews.set(result,{positions,current:()=>original.current()});return result
}

/** Retain a prefix under the original writer's lifetime guard. */
export function retainPruneDependencyView(view: ConversationPruneDependencyView, assertCurrent: () => void): ConversationPruneDependencyView {
 const original=pruneViews.get(view); if(!original || !original.current()) throw new TypeError('Invalid or stale prune dependency view')
 assertCurrent(); const retained=Object.freeze({eventCount:view.eventCount}) as ConversationPruneDependencyView
 pruneViews.set(retained,{positions:original.positions,current:()=>{assertCurrent();return true}}); return retained
}
