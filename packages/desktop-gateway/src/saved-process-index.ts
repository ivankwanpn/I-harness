import { savedResultDescriptor } from './saved-result-json.ts'
import { rewindCuts, type SessionView } from "@i-harness/core-session"
type Fact = Record<string, any>
export interface SavedCall {
  callIndex: number; resultIndex: number; callSeq?: number; resultSeq?: number
  surface: 'tool' | 'code'; cellId?: string; callId: string; name: string
  args: unknown; value: unknown; provenance: 'inline' | 'legacy' | 'artifact'; descriptor?: NonNullable<ReturnType<typeof savedResultDescriptor>>
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
    let value: unknown, provenance: SavedCall['provenance'], descriptor: SavedCall['descriptor']
    if ('envelope' in result) {
      if ('output' in result || 'isError' in result) continue
      const envelope = result.envelope
      if (!envelope || envelope.execution?.outcome !== 'succeeded' || envelope.execution?.dispatch !== 'dispatched') continue
      if (envelope.retention?.kind === 'inline' && Object.hasOwn(envelope.retention, 'value')) { value = envelope.retention.value; provenance = 'inline' }
      else { descriptor = savedResultDescriptor(envelope); if (!descriptor) continue; provenance = 'artifact' }
    } else {
      if (!('output' in result) || result.isError) continue
      value = result.output; provenance = 'legacy'
    }
    out.push({ callIndex: ci, resultIndex: ri, callSeq: call.seq, resultSeq: result.seq, surface, cellId: surface === 'code' ? call.cellId : undefined, callId: call.callId, name: call.name, args: structuredClone(call.args), value: structuredClone(value), provenance, descriptor })
  }
  return out.sort((a, b) => a.resultIndex - b.resultIndex)
}

export interface NativeIdentity { version: 1; jobId: string; instanceId: string; ownerSessionId: string; sourceId: string }
export interface SavedCandidate { id: string; nativeJob?: NativeIdentity; declaration: SavedCall; snapshot?: Record<string, unknown>; observation?: SavedCall; descriptor?: NonNullable<ReturnType<typeof savedResultDescriptor>>; conflict: boolean }
const object = (v: unknown): Record<string, any> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined
function identity(value: unknown, owner: string, id: string): NativeIdentity | undefined {
  const n = object(value)
  if (!n || n.version !== 1 || n.jobId !== id || n.ownerSessionId !== owner || typeof n.instanceId !== 'string' || !n.instanceId || typeof n.sourceId !== 'string' || !n.sourceId) return
  return { version: 1, jobId: id, instanceId: n.instanceId, ownerSessionId: owner, sourceId: n.sourceId }
}
export function buildSavedProcessIndex(events: readonly unknown[], owner: string) {
  const calls = decodeSavedCalls(events, owner)
  const candidates: SavedCandidate[] = []
  for (const call of calls) {
    const value = object(call.value), args = object(call.args)
    if (!args) continue
    if (call.provenance === 'artifact') {
      if (call.name !== 'job_output' || typeof args.job_id !== 'string' || typeof args.job_instance_id !== 'string') continue
      const matches = candidates.filter(c => c.id === args.job_id && c.nativeJob?.instanceId === args.job_instance_id && (args.source_id === undefined || args.source_id === c.nativeJob?.sourceId))
      if (matches.length === 1 && (args.offset_bytes === undefined || args.offset_bytes === 0)) { matches[0]!.descriptor = call.descriptor; matches[0]!.observation = call }
      continue
    }
    if (!value || 'error' in value) continue
    if (['shell', 'bash', 'pwsh'].includes(call.name) && typeof value.job_id === 'string' && value.job_id && value.job_id.length <= 256 && !value.job_id.includes('\0')) {
      const nativeJob = call.provenance === 'inline' ? identity(value.native_job, owner, value.job_id) : undefined
      if (call.provenance === 'inline' && !nativeJob) continue
      const same = nativeJob && candidates.find(c => c.nativeJob?.instanceId === nativeJob.instanceId)
      if (same) {
        if (same.id !== nativeJob!.jobId || same.nativeJob!.sourceId !== nativeJob!.sourceId) same.conflict = true
      } else candidates.push({ id: value.job_id, nativeJob, declaration: call, conflict: false })
    }
    if (call.name !== 'job_output' || typeof args.job_id !== 'string') continue
    const matches = candidates.filter(c => c.id === args.job_id && (!c.nativeJob || call.provenance === 'inline' && identity(value.native_job, owner, c.id)?.instanceId === c.nativeJob.instanceId && value.native_job.sourceId === c.nativeJob.sourceId))
    if (matches.length !== 1) continue
    const c = matches[0]!
    if (c.nativeJob && (args.job_instance_id !== undefined && args.job_instance_id !== c.nativeJob.instanceId || args.source_id !== undefined && args.source_id !== c.nativeJob.sourceId)) continue
    if (args.offset_bytes !== undefined && args.offset_bytes !== 0 || value.offset_bytes !== undefined && value.offset_bytes !== 0) continue
    c.snapshot = structuredClone(value); c.observation = call
  }
  return { candidates, select(id: string, instanceId?: string) {
    const matches = candidates.filter(c => c.id === id && (instanceId === undefined || c.nativeJob?.instanceId === instanceId))
    if (!matches.length) return { kind: 'unavailable' as const }
    if (matches.length > 1) return { kind: 'ambiguous-selector' as const }
    if (matches[0]!.conflict) return { kind: 'conflict' as const }
    return { kind: 'selected' as const, candidate: matches[0]! }
  } }
}
