import { savedResultDescriptor } from './saved-result-json.ts'
import { createHash } from 'node:crypto'
import { sameManagedArtifactRef, validManagedArtifactRef, type SessionView } from "@i-harness/core-session"
type Fact = Record<string, any>
type Cut = { cutFrom: number; markerSeq: number }
function effectiveCuts(events: readonly unknown[]): Cut[] {
  const cuts: Cut[] = []
  for (const raw of events) {
    const e = object(raw)
    if (e?.type === 'rewind/point' && Number.isSafeInteger(e.seq) && Number.isSafeInteger(e.anchorSeq) && e.anchorSeq < e.seq) cuts.push({ cutFrom: e.anchorSeq, markerSeq: e.seq })
  }
  cuts.sort((a, b) => a.cutFrom - b.cutFrom)
  const merged: Cut[] = []
  for (const cut of cuts) { const last = merged.at(-1); if (last && cut.cutFrom < last.markerSeq) last.markerSeq = Math.max(last.markerSeq, cut.markerSeq); else merged.push({ ...cut }) }
  return merged
}
function hidden(seq: unknown, cuts: Cut[]): boolean {
  if (typeof seq !== 'number') return false
  let lo = 0, hi = cuts.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (cuts[mid]!.cutFrom <= seq) lo = mid + 1; else hi = mid }
  return lo > 0 && seq < cuts[lo - 1]!.markerSeq
}
export interface SavedCall {
  callIndex: number; resultIndex: number; callSeq?: number; resultSeq?: number; dispatchSeq?: number
  surface: 'tool' | 'code'; cellId?: string; parentCallId?: string; callId: string; name: string
  args: unknown; value: unknown; provenance: 'inline' | 'legacy' | 'artifact'; descriptor?: NonNullable<ReturnType<typeof savedResultDescriptor>>
}
/** Decode only uniquely paired original facts. This is evidence, not read authority. */
export function decodeSavedCalls(events: readonly unknown[], owner: string): SavedCall[] {
  const facts = events.map(e => e && typeof e === 'object' && !Array.isArray(e) ? e as Fact : {})
  const cuts = effectiveCuts(events)
  const visible = (e: Fact) => !hidden(e.seq, cuts)
  const cells = new Map<string, Fact[]>()
  for (const [index, e] of facts.entries()) if (visible(e) && e.type === 'code/cell' && typeof e.cellId === 'string') cells.set(e.cellId, [...cells.get(e.cellId) ?? [], { ...e, index }])
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
  const windows: { calls: number[]; results: number[]; dispatches: number[] }[] = []
  for (const group of groups.values()) {
    if (group.calls.length <= 1) { windows.push(group); continue }
    // Original call positions delimit sequential invocations. Any supplied
    // dispatch must reference that invocation's original call sequence.
    const split = group.calls.map(ci => ({ calls: [ci], results: [] as number[], dispatches: [] as number[] }))
    let slot = 0
    for (const ri of group.results) { while (slot + 1 < group.calls.length && ri > group.calls[slot + 1]!) slot++; split[slot]!.results.push(ri) }
    slot = 0
    for (const di of group.dispatches) { while (slot + 1 < group.calls.length && di > group.calls[slot + 1]!) slot++; split[slot]!.dispatches.push(di) }
    if (split.every((g, i) => (g.results.length === 1 || i === split.length - 1 && g.results.length === 0) && g.dispatches.length <= 1
      && (!g.dispatches.length || facts[g.dispatches[0]!]!.eventSeq === undefined || facts[g.dispatches[0]!]!.eventSeq === facts[g.calls[0]!]!.seq))) windows.push(...split)
  }
  const out: SavedCall[] = []
  for (const group of windows) {
    if (group.calls.length !== 1 || group.results.length !== 1 || group.dispatches.length > 1) continue
    const ci = group.calls[0]!, ri = group.results[0]!, call = facts[ci]!, result = facts[ri]!
    if (ci >= ri || call.name !== result.name || typeof call.name !== 'string') continue
    const surface = call.type === 'tool/call' ? 'tool' : 'code'
    if (surface === 'code') {
      const declarations = cells.get(call.cellId) ?? []
      if (!declarations.some(c => c.index < ci) || declarations.some(c => c.sessionId !== undefined && c.sessionId !== owner || (c.parentCallId !== undefined || call.parentCallId !== undefined) && c.parentCallId !== call.parentCallId)) continue
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
    out.push({ callIndex: ci, resultIndex: ri, callSeq: call.seq, resultSeq: result.seq, dispatchSeq: group.dispatches.length ? facts[group.dispatches[0]!]!.seq : undefined, surface, cellId: surface === 'code' ? call.cellId : undefined, parentCallId: call.parentCallId, callId: call.callId, name: call.name, args: structuredClone(call.args), value: structuredClone(value), provenance, descriptor })
  }
  return out.sort((a, b) => a.resultIndex - b.resultIndex)
}

export interface NativeIdentity { version: 1; jobId: string; instanceId: string; ownerSessionId: string; sourceId: string }
export interface SavedCandidate { id: string; nativeJob?: NativeIdentity; declaration: SavedCall; snapshot?: Record<string, unknown>; observation?: SavedCall; sourceObservation?: SavedCall; descriptor?: NonNullable<ReturnType<typeof savedResultDescriptor>>; conflict: boolean }
const object = (v: unknown): Record<string, any> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined
const immutableFields = ['total_bytes', 'stderr_total_bytes', 'total_raw_bytes', 'digest', 'stderr_digest', 'digest_format', 'completeness']
function remember(evidence: Fact, value: Fact): boolean {
  let conflict = false
  const ref = value.full_result?.args?.ref
  if (ref !== undefined) {
    if (!validManagedArtifactRef(ref) || evidence.ref !== undefined && !sameManagedArtifactRef(evidence.ref, ref)) conflict = true
    else evidence.ref = structuredClone(ref)
  }
  for (const key of immutableFields) if (value[key] !== undefined) { if (evidence[key] !== undefined && evidence[key] !== value[key]) conflict = true; else evidence[key] = value[key] }
  return conflict
}
function exactWindow(value: Fact, args: Fact): boolean {
  const size = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  const ref = value.full_result?.args?.ref, offset = args.offset_bytes ?? 0
  if (['cursor', 'body', 'result_revision', 'ref_revision', 'ref_id'].some(k => args[k] !== undefined) || args.field !== undefined && args.field !== 'text'
    || ['offset_bytes', 'digest', 'source_id', 'field'].some(k => args[k] !== undefined) && args.job_instance_id === undefined) return false
  if ('error' in value || value.display_only !== undefined || typeof value.text !== 'string' || typeof value.truncated !== 'boolean'
    || !size(offset) || value.offset_bytes !== offset || !size(value.next_offset_bytes) || !size(value.total_bytes) || !size(value.stderr_total_bytes) || !size(value.total_raw_bytes)
    || !Number.isSafeInteger(value.total_bytes + value.stderr_total_bytes) || value.total_raw_bytes !== value.total_bytes + value.stderr_total_bytes
    || value.next_offset_bytes - offset !== Buffer.byteLength(value.text) || value.next_offset_bytes > value.total_bytes
    || value.source?.kind !== 'retained-summary' || value.scope !== 'captured' || value.digest_format !== 'sha256-raw-v1' || !hash(value.digest) || !hash(value.stderr_digest)
    || !validManagedArtifactRef(ref) || ref.codec !== 'exec-frames-v1' || !['complete', 'source-limited'].includes(ref.completeness) || value.completeness !== ref.completeness
    || value.full_result.tool !== 'context_output_read' || value.full_result.access !== 'catalog-required' || value.full_result.catalog_from !== 'envelope.dependencies.ref' || value.full_result.args.maxBytes !== 32768
    || Object.keys(value.full_result).some(k => !['tool', 'args', 'access', 'catalog_from'].includes(k)) || Object.keys(value.full_result.args).some(k => !['ref', 'maxBytes'].includes(k))
    || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(value.text)) !== value.text
    || args.digest !== undefined && args.digest !== value.digest || value.truncated !== (value.next_offset_bytes < value.total_bytes || value.completeness !== 'complete')) return false
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  if (Object.hasOwn(value, 'text_result')) {
    const t = object(value.text_result), a = object(t?.args), n = value.native_job
    if (!t || !a || t.tool !== 'job_output' || Object.keys(t).length !== 2 || Object.keys(a).length !== 5
      || a.job_id !== n.jobId || a.job_instance_id !== n.instanceId || a.source_id !== n.sourceId || a.digest !== value.digest || a.offset_bytes !== value.next_offset_bytes) return false
  }
  return (offset !== 0 || value.next_offset_bytes !== value.total_bytes || sha(value.text) === value.digest) && (value.stderr_total_bytes !== 0 || sha('') === value.stderr_digest)
}
function identity(value: unknown, owner: string, id: string): NativeIdentity | undefined {
  const n = object(value)
  if (!n || n.version !== 1 || n.jobId !== id || n.ownerSessionId !== owner || typeof n.instanceId !== 'string' || !n.instanceId || typeof n.sourceId !== 'string' || !n.sourceId) return
  return { version: 1, jobId: id, instanceId: n.instanceId, ownerSessionId: owner, sourceId: n.sourceId }
}
/** A short ID never makes a different instance relevant, or hides a mutation
 * of the original instance's immutable job/source identity. */
function nativeRelation(original: NativeIdentity, observed: NativeIdentity): 'same' | 'conflict' | 'other' {
  if (original.ownerSessionId !== observed.ownerSessionId || original.instanceId !== observed.instanceId) return 'other'
  return original.jobId === observed.jobId && original.sourceId === observed.sourceId ? 'same' : 'conflict'
}
export function buildSavedProcessIndex(events: readonly unknown[], owner: string) {
  const calls = decodeSavedCalls(events, owner)
  const candidates: SavedCandidate[] = []
  const known = new Map<SavedCandidate, Fact>()
  const byId = new Map<string, SavedCandidate[]>(), byInstance = new Map<string, SavedCandidate>()
  const legacyById = new Map<string, SavedCandidate[]>()
  for (const call of calls) {
    const value = object(call.value), args = object(call.args)
    if (!args) continue
    if (call.provenance === 'artifact') {
      if (call.name !== 'job_output' || typeof args.job_id !== 'string' || typeof args.job_instance_id !== 'string') continue
      const found = byInstance.get(args.job_instance_id)
      const matches = found && found.id === args.job_id && (args.source_id === undefined || args.source_id === found.nativeJob?.sourceId) ? [found] : []
      if (matches.length === 1 && (args.offset_bytes === undefined || args.offset_bytes === 0)) { matches[0]!.descriptor = call.descriptor; matches[0]!.observation = call }
      continue
    }
    if (!value || 'error' in value) continue
    if (['shell', 'bash', 'pwsh'].includes(call.name) && typeof value.job_id === 'string' && value.job_id && value.job_id.length <= 256 && !value.job_id.includes('\0')) {
      const nativeJob = call.provenance === 'inline' ? identity(value.native_job, owner, value.job_id) : undefined
      if (call.provenance === 'inline' && !nativeJob) continue
      const same = nativeJob && byInstance.get(nativeJob.instanceId)
      if (same) {
        if (nativeRelation(same.nativeJob!, nativeJob!) === 'conflict') same.conflict = true
      } else {
        const candidate = { id: value.job_id, nativeJob, declaration: call, conflict: false }
        candidates.push(candidate)
        const bucket = byId.get(candidate.id) ?? []; bucket.push(candidate); byId.set(candidate.id, bucket)
        if (nativeJob) byInstance.set(nativeJob.instanceId, candidate)
        else { const legacy = legacyById.get(candidate.id) ?? []; legacy.push(candidate); legacyById.set(candidate.id, legacy) }
      }
    }
    if (call.name !== 'job_output' || typeof args.job_id !== 'string') continue
    const n = call.provenance === 'inline' ? identity(value.native_job, owner, args.job_id) : undefined
    const nativeCandidate = n && byInstance.get(n.instanceId)
    // A fully bound modern observation belongs only to its native instance.
    // Legacy compatibility never competes for or absorbs that observation.
    const matches = call.provenance === 'legacy' ? legacyById.get(args.job_id) ?? []
      : n && nativeCandidate?.nativeJob && nativeRelation(nativeCandidate.nativeJob, n) === 'same' ? [nativeCandidate] : []
    if (matches.length !== 1) continue
    const c = matches[0]!
    if (c.nativeJob && (args.job_instance_id !== undefined && args.job_instance_id !== c.nativeJob.instanceId || args.source_id !== undefined && args.source_id !== c.nativeJob.sourceId)) continue
    if (c.nativeJob) { const evidence = known.get(c) ?? {}; if (remember(evidence, value)) c.conflict = true; known.set(c, evidence) }
    if (c.nativeJob && !exactWindow(value, args)) continue
    if (c.nativeJob) c.sourceObservation = call
    if (args.offset_bytes !== undefined && args.offset_bytes !== 0 || value.offset_bytes !== undefined && value.offset_bytes !== 0) continue
    c.snapshot = structuredClone(value); c.observation = call
  }
  return { candidates, select(id: string, instanceId?: string) {
    const native = instanceId === undefined ? undefined : byInstance.get(instanceId)
    const matches = instanceId === undefined ? byId.get(id) ?? [] : native?.id === id ? [native] : []
    if (!matches.length) return { kind: 'unavailable' as const }
    if (matches.length > 1) return { kind: 'ambiguous-selector' as const }
    if (matches[0]!.conflict) return { kind: 'conflict' as const }
    return { kind: 'selected' as const, candidate: matches[0]! }
  } }
}

export function buildObservedSavedProcessIndex(initial: { readonly session: SessionView; readonly highWater: number }, owner: string) {
  const session = initial?.session, header = session?.header
  if (typeof owner !== 'string' || !owner || !session || !Array.isArray(session.events) || !Number.isSafeInteger(initial.highWater) || initial.highWater !== session.events.length || session.formatVersion !== 13) throw new Error('Unsupported process read initial')
  if (header !== undefined && !object(header) || header && Object.hasOwn(header, 'semanticSeed') || header?.seedLength !== undefined && (!Number.isSafeInteger(header.seedLength) || header.seedLength !== 0)
    || session.events.some(e => e.type === 'conversation/seed-group')) throw new Error('Inherited process history unavailable')
  return buildSavedProcessIndex(session.events, owner)
}


export interface SavedProcessInitial { readonly session: SessionView; readonly highWater: number }
export interface FixedSavedSelection {
  append(from: number, events: readonly unknown[]): void
  current(): SavedCandidate
}
/** Request-local fixed evidence. Only new suffix records are consumed after creation.
 * The caller still owns visibility, project epoch and original read-store authority. */
export function createFixedSavedSelection(initial: SavedProcessInitial, owner: string, id: string, instanceId?: string): FixedSavedSelection {
  const selected = buildObservedSavedProcessIndex(initial, owner).select(id, instanceId)
  if (selected.kind !== 'selected') throw new Error('Process selection unavailable: ' + selected.kind)
  const fixed = structuredClone(selected.candidate), evidence: Fact = {}
  let cuts = effectiveCuts(initial.session.events)
  type Slot = { call: Fact; index: number; dispatch?: Fact; invalid: boolean }
  const pending = new Map<string, Slot>(), completed = new Map<string, Slot>(), cells = new Map<string, Fact[]>()
  const unresolvedShells = new Set<string>()
  let cursor = 0, failed = false
  const keyFor = (e: Fact) => JSON.stringify([e.type.startsWith('code/') ? 'code' : 'tool', e.type.startsWith('code/') ? e.cellId : null, e.callId])
  const originalKey = (call: SavedCall) => JSON.stringify([call.surface, call.cellId ?? null, call.callId])
  const isFixed = (key: string) => [fixed.declaration, fixed.observation, fixed.sourceObservation].some(call => call !== undefined && key === originalKey(call))
  const shell = (e: Fact) => ['shell', 'bash', 'pwsh'].includes(e.name)
  function cellValid(call: Fact, index: number): boolean {
    if (!call.type.startsWith('code/')) return true
    const declarations = cells.get(call.cellId) ?? []
    return declarations.some(c => c.index < index) && declarations.every(c => (c.sessionId === undefined || c.sessionId === owner) && (c.parentCallId === undefined && call.parentCallId === undefined || c.parentCallId === call.parentCallId))
  }
  function checkFixedCells() {
    for (const c of [fixed.declaration, fixed.observation, fixed.sourceObservation]) if (c?.surface === 'code') {
      const declarations = cells.get(c.cellId!) ?? []
      if (declarations.some(d => d.sessionId !== undefined && d.sessionId !== owner || (d.parentCallId !== undefined || (c as Fact).parentCallId !== undefined) && d.parentCallId !== (c as Fact).parentCallId)) failed = true
    }
  }
  function accept(call: SavedCall, initialPass: boolean) {
    const value = object(call.value), args = object(call.args)
    if (!args) return
    if (call.name === 'job_output' && value && !('error' in value) && fixed.nativeJob && args.job_id === id) {
      const n = identity(value.native_job, owner, id)
      if (n?.instanceId === fixed.nativeJob.instanceId && (args.job_instance_id === undefined || args.job_instance_id === n.instanceId) && (args.source_id === undefined || args.source_id === n.sourceId)) {
        if (nativeRelation(fixed.nativeJob, n) === 'conflict' || remember(evidence, value)) failed = true
      }
    }
    if (!initialPass && shell({ name: call.name }) && value && typeof value.job_id === 'string' && !('error' in value)) {
      const n = call.provenance === 'inline' ? identity(value.native_job, owner, value.job_id) : undefined
      if (call.provenance === 'inline' && !n) return
      const relation = n && fixed.nativeJob ? nativeRelation(fixed.nativeJob, n) : 'other'
      if (relation === 'conflict' || value.job_id === id && instanceId === undefined && relation !== 'same') failed = true
    }
  }
  function consume(raw: unknown, index: number, initialPass: boolean) {
    const e = object(raw)
    if (!e) return
    if (!initialPass && e.type === 'rewind/point' && Number.isSafeInteger(e.seq) && Number.isSafeInteger(e.anchorSeq) && e.anchorSeq < e.seq) {
      const cut = { cutFrom: e.anchorSeq, markerSeq: e.seq }
      for (const c of [fixed.declaration, fixed.observation, fixed.sourceObservation]) if (c && [c.callSeq, c.dispatchSeq, c.resultSeq].some(seq => hidden(seq, [cut]))) failed = true
      for (const c of [fixed.declaration, fixed.observation, fixed.sourceObservation]) if (c?.cellId && (cells.get(c.cellId) ?? []).some(d => hidden(d.seq, [cut]))) failed = true
      // Only outstanding records can contribute future authority; retired history is never replayed.
      for (const [key, slot] of pending) if (hidden(slot.call.seq, [cut]) || slot.dispatch && hidden(slot.dispatch.seq, [cut])) { pending.delete(key); unresolvedShells.delete(key) }
      cuts = [...cuts, cut].sort((a, b) => a.cutFrom - b.cutFrom).reduce<Cut[]>((result, next) => { const last = result.at(-1); if (last && next.cutFrom < last.markerSeq) last.markerSeq = Math.max(last.markerSeq, next.markerSeq); else result.push({ ...next }); return result }, [])
      return
    }
    if (hidden(e.seq, cuts)) return
    if (e.type === 'code/cell' && typeof e.cellId === 'string') {
      cells.set(e.cellId, [...cells.get(e.cellId) ?? [], { ...structuredClone(e), index }]); if (!initialPass) checkFixedCells(); return
    }
    if (typeof e.type !== 'string' || typeof e.callId !== 'string' || !/^(tool|code)\/(call|dispatch|result)$/.test(e.type) || e.type.startsWith('code/') && typeof e.cellId !== 'string') return
    const key = keyFor(e), kind = e.type.split('/')[1]
    if (kind === 'call') {
      const old = pending.get(key), done = completed.get(key)
      if (old || done?.invalid) {
        if (isFixed(key)) failed = true
      }
      pending.set(key, { call: structuredClone(e), index, invalid: !!old }); if (shell(e)) unresolvedShells.add(key); return
    }
    const slot = pending.get(key)
    if (!slot) { if (!initialPass && isFixed(key)) failed = true; return }
    if (kind === 'dispatch') { if (slot.dispatch || e.eventSeq !== undefined && e.eventSeq !== slot.call.seq) slot.invalid = true; slot.dispatch = structuredClone(e); return }
    pending.delete(key); unresolvedShells.delete(key)
    const prior = completed.get(key)
    completed.set(key, slot)
    if (slot.invalid || prior?.invalid || !cellValid(slot.call, slot.index)) { if (isFixed(key)) failed = true; return }
    const cellRecords = slot.call.type.startsWith('code/') ? (cells.get(slot.call.cellId) ?? []).map(({ index: _index, ...c }) => c) : []
    const decoded = decodeSavedCalls([...cellRecords, slot.call, ...(slot.dispatch ? [slot.dispatch] : []), e], owner)
    if (decoded[0]) accept(decoded[0], initialPass)
  }
  // Seed the same pending/cell state from the original owner snapshot once.
  for (const [index, raw] of initial.session.events.entries()) consume(raw, index, true)
  checkFixedCells()
  cursor = initial.highWater
  return {
    append(from, events) {
      if (failed || from !== cursor || !Array.isArray(events)) { failed = true; throw new Error('Process selection conflict') }
      for (const raw of events) consume(raw, cursor++, false)
    },
    current() {
      if (failed) throw new Error('Process selection conflict')
      if (unresolvedShells.size) throw new Error('Process selection unknown')
      return structuredClone(fixed)
    },
  }
}
