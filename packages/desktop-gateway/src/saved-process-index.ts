import { rewindCuts, type SessionView } from "@i-harness/core-session"
type Fact = Record<string, any>
export interface SavedCall {
  callIndex: number; resultIndex: number; callSeq?: number; resultSeq?: number
  surface: 'tool' | 'code'; cellId?: string; callId: string; name: string
  args: unknown; value: unknown; provenance: 'inline' | 'legacy'
}
/** Decode only uniquely paired original facts. This is evidence, not read authority. */
export function decodeSavedCalls(events: readonly unknown[], owner: string): SavedCall[] {
  const facts = events.map(e => e && typeof e === 'object' && !Array.isArray(e) ? e as Fact : {})
  const cuts = rewindCuts({ events } as SessionView)
  const visible = (e: Fact) => typeof e.seq !== 'number' || !cuts.some(c => c.cutFrom <= e.seq && e.seq < c.markerSeq)
  const cells = new Map<string, Fact[]>()
  for (const e of facts) if (visible(e) && e.type === 'code/cell' && typeof e.cellId === 'string') cells.set(e.cellId, [...cells.get(e.cellId) ?? [], e])
  const groups = new Map<string, { calls: number[]; results: number[]; dispatches: number[] }>()
  for (const [i, e] of facts.entries()) {
    if (!visible(e) || typeof e.callId !== 'string') continue
    const match = /^(tool|code)\/(call|result|dispatch)$/.exec(e.type)
    if (!match || match[1] === 'code' && typeof e.cellId !== 'string') continue
    const key = JSON.stringify([match[1], e.cellId ?? null, e.callId])
    const group = groups.get(key) ?? { calls: [], results: [], dispatches: [] }
    group[match[2] === 'call' ? 'calls' : match[2] === 'result' ? 'results' : 'dispatches'].push(i)
    groups.set(key, group)
  }
  const out: SavedCall[] = []
  for (const group of groups.values()) {
    if (group.calls.length !== 1 || group.results.length !== 1 || group.dispatches.length > 1) continue
    const ci = group.calls[0]!, ri = group.results[0]!, call = facts[ci]!, result = facts[ri]!
    if (ci >= ri || call.name !== result.name || typeof call.name !== 'string') continue
    const surface = call.type === 'tool/call' ? 'tool' : 'code'
    if (surface === 'code') {
      const declarations = cells.get(call.cellId) ?? []
      if (!declarations.length || declarations.some(c => c.sessionId !== undefined && c.sessionId !== owner || c.parentCallId !== undefined && call.parentCallId !== undefined && c.parentCallId !== call.parentCallId)) continue
    }
    if (group.dispatches.length) {
      const di = group.dispatches[0]!, dispatch = facts[di]!
      if (di <= ci || di >= ri || dispatch.eventSeq !== undefined && dispatch.eventSeq !== call.seq) continue
    }
    let value: unknown, provenance: SavedCall['provenance']
    if ('envelope' in result) {
      if ('output' in result || 'isError' in result) continue
      const envelope = result.envelope
      if (!envelope || envelope.execution?.outcome !== 'succeeded' || envelope.execution?.dispatch !== 'dispatched' || envelope.retention?.kind !== 'inline' || !Object.hasOwn(envelope.retention, 'value')) continue
      value = envelope.retention.value; provenance = 'inline'
    } else {
      if (!('output' in result) || result.isError) continue
      value = result.output; provenance = 'legacy'
    }
    out.push({ callIndex: ci, resultIndex: ri, callSeq: call.seq, resultSeq: result.seq, surface, cellId: surface === 'code' ? call.cellId : undefined, callId: call.callId, name: call.name, args: call.args, value, provenance })
  }
  return out.sort((a, b) => a.resultIndex - b.resultIndex)
}
