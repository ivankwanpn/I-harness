import { savedResultDescriptor } from './saved-result-json.ts'
import { createHash } from 'node:crypto'
import { sameManagedArtifactRef, validDeliveryEvent, validManagedArtifactRef, type ExecDeliverySourceEvent, type ExecTerminalEvent, type SessionView, type ManagedArtifactRef } from "@i-harness/core-session"
type Fact = Record<string, any>
type Cut = { cutFrom: number; markerSeq: number }
export function effectiveCuts(events: readonly unknown[]): Cut[] {
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
export function hidden(seq: unknown, cuts: Cut[]): boolean {
  if (typeof seq !== 'number') return false
  let lo = 0, hi = cuts.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (cuts[mid]!.cutFrom <= seq) lo = mid + 1; else hi = mid }
  return lo > 0 && seq < cuts[lo - 1]!.markerSeq
}
export interface SavedCall {
  callIndex: number; resultIndex: number; callSeq?: number; resultSeq?: number; dispatchSeq?: number
  surface: 'tool' | 'code'; cellId?: string; parentCallId?: string; callId: string; name: string
  catalog?: ManagedArtifactRef; args: unknown; value: unknown; provenance: 'inline' | 'legacy' | 'artifact'; descriptor?: NonNullable<ReturnType<typeof savedResultDescriptor>>
  needsNativeTerminal?: true
}
/** Decode only uniquely paired original facts. This is evidence, not read authority. */
export function decodeSavedCalls(events: readonly unknown[], owner: string): SavedCall[] {
  return decodeProcessCalls(events, owner, effectiveCuts(events), false)
}
function shellTool(name: unknown): boolean { return name === 'shell' || name === 'bash' || name === 'pwsh' }
function decodeProcessCalls(events: readonly unknown[], owner: string, cuts: Cut[], nativeTerminals: boolean): SavedCall[] {
  const facts = events.map(e => e && typeof e === 'object' && !Array.isArray(e) ? e as Fact : {})
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
    let catalog: ManagedArtifactRef | undefined, needsNativeTerminal = false
    let value: unknown, provenance: SavedCall['provenance'], descriptor: SavedCall['descriptor']
    if ('envelope' in result) {
      if ('output' in result || 'isError' in result) continue
      const envelope = result.envelope
      if (!envelope || envelope.execution?.dispatch !== 'dispatched') continue
      if (envelope.execution.outcome !== 'succeeded') {
        const launch = object(envelope.retention?.value), dispatch = facts[group.dispatches[0] ?? -1]
        if (!nativeTerminals || envelope.execution.outcome !== 'unknown' || !shellTool(call.name) || envelope.retention?.kind !== 'inline'
          || !dispatch || !Number.isSafeInteger(call.seq) || dispatch.eventSeq !== call.seq || !launch || 'error' in launch
          || typeof launch.job_id !== 'string' || !identity(launch.native_job, owner, launch.job_id)
          || object(call.args)?.background !== true && launch.promoted !== true) continue
        needsNativeTerminal = true
      }
      const dep = envelope.dependencies
      if (dep?.kind === 'artifact-set' && dep.count === 1 && validManagedArtifactRef(dep.ref) && dep.ref.codec === 'json-utf8-v1' && dep.ref.encodedBytes <= 65536 && ['complete', 'source-limited'].includes(dep.ref.completeness)) catalog = Object.freeze({ ...dep.ref })
      if (envelope.retention?.kind === 'inline' && Object.hasOwn(envelope.retention, 'value')) { value = envelope.retention.value; provenance = 'inline' }
      else { descriptor = savedResultDescriptor(envelope); if (!descriptor) continue; provenance = 'artifact' }
    } else {
      if (!('output' in result) || result.isError) continue
      value = result.output; provenance = 'legacy'
    }
    out.push({ callIndex: ci, resultIndex: ri, callSeq: call.seq, resultSeq: result.seq, dispatchSeq: group.dispatches.length ? facts[group.dispatches[0]!]!.seq : undefined, surface, cellId: surface === 'code' ? call.cellId : undefined, parentCallId: call.parentCallId, callId: call.callId, name: call.name, args: structuredClone(call.args), value: structuredClone(value), provenance, descriptor, catalog, ...(needsNativeTerminal ? { needsNativeTerminal: true } : {}) })
  }
  return out.sort((a, b) => a.resultIndex - b.resultIndex)
}

export interface NativeIdentity { version: 1; jobId: string; instanceId: string; ownerSessionId: string; sourceId: string }
export interface SavedNativeTerminal { sourceSeq: number; terminalSeq: number; status: 'completed' | 'killed' | 'error'; ref?: ManagedArtifactRef }
export interface SavedCandidate { id: string; nativeJob?: NativeIdentity; declaration: SavedCall; snapshot?: Record<string, unknown>; observation?: SavedCall; sourceObservation?: SavedCall; descriptor?: NonNullable<ReturnType<typeof savedResultDescriptor>>; terminal?: SavedNativeTerminal; conflict: boolean }
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
type NativeTerminals = ReturnType<typeof indexNativeTerminals>
function collectUnique<K, V>(entries: Map<K, V | null>, key: K, value: V): void {
  entries.set(key, entries.has(key) ? null : value)
}
function indexNativeTerminals(events: readonly unknown[], cuts: Cut[]) {
  const sources = new Map<string, ExecDeliverySourceEvent | null>()
  const terminals = new Map<number, ExecTerminalEvent | null>(), instances = new Map<string, ExecTerminalEvent | null>()
  for (const raw of events) {
    const fact = object(raw)
    if (!fact || !Number.isSafeInteger(fact.seq) || hidden(fact.seq, cuts)
      || !(fact.type === 'exec/end' || fact.type === 'agent/delivery-source' && fact.kind === 'exec') || !validDeliveryEvent(fact)) continue
    if (fact.type === 'agent/delivery-source' && fact.kind === 'exec') collectUnique(sources, fact.sourceId, fact)
    else if (fact.type === 'exec/end') {
      collectUnique(terminals, fact.sourceSeq, fact)
      collectUnique(instances, fact.instanceId, fact)
    }
  }
  return { sources, terminals, instances }
}
function nativeTerminal(index: NativeTerminals, launch: SavedCall, identity: NativeIdentity): SavedNativeTerminal | undefined {
  const source = index.sources.get(identity.instanceId)
  const { dispatchSeq, resultSeq } = launch
  if (!source || source.seq === undefined || source.recipientSessionId !== identity.ownerSessionId || source.callSeq !== launch.callSeq
    || dispatchSeq === undefined || resultSeq === undefined || !Number.isSafeInteger(dispatchSeq) || !Number.isSafeInteger(resultSeq)
    || source.callSeq >= dispatchSeq || dispatchSeq >= source.seq || source.seq >= resultSeq) return undefined
  const terminal = index.terminals.get(source.seq)
  if (!terminal || terminal.seq === undefined || terminal.seq <= source.seq || terminal.instanceId !== identity.instanceId
    || index.instances.get(identity.instanceId) !== terminal || !('dependency' in terminal) || terminal.frameSourceId !== identity.sourceId) return undefined
  const status = terminal.timedOut || terminal.execution.outcome === 'canceled' ? 'killed'
    : terminal.execution.outcome === 'succeeded' && terminal.exitCode === 0 ? 'completed' : 'error'
  const retention = terminal.dependency.retention
  const ref = retention.kind === 'artifact' && ['complete', 'source-limited'].includes(retention.ref.completeness) ? retention.ref : undefined
  return { sourceSeq: source.seq, terminalSeq: terminal.seq, status, ...(ref ? { ref: Object.freeze({ ...ref }) } : {}) }
}

export function buildSavedProcessIndex(events: readonly unknown[], owner: string, formatVersion = 13) {
  const cuts = effectiveCuts(events)
  const originalTerminals = formatVersion === 14 ? indexNativeTerminals(events, cuts) : undefined
  const calls = decodeProcessCalls(events, owner, cuts, !!originalTerminals)
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
    if (shellTool(call.name) && typeof value.job_id === 'string' && value.job_id && value.job_id.length <= 256 && !value.job_id.includes('\0')) {
      const nativeJob = call.provenance === 'inline' ? identity(value.native_job, owner, value.job_id) : undefined
      if (call.provenance === 'inline' && !nativeJob) continue
      const terminal = nativeJob && originalTerminals ? nativeTerminal(originalTerminals, call, nativeJob) : undefined
      if (call.needsNativeTerminal && !terminal) continue
      const same = nativeJob && byInstance.get(nativeJob.instanceId)
      if (same) {
        if (nativeRelation(same.nativeJob!, nativeJob!) === 'conflict' || (same.terminal || terminal) && same.declaration.resultSeq !== call.resultSeq) same.conflict = true
      } else {
        const candidate: SavedCandidate = { id: value.job_id, nativeJob, declaration: call, ...(terminal ? { terminal } : {}), conflict: false }
        if (terminal?.ref) known.set(candidate, { ref: terminal.ref })
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
  if (typeof owner !== 'string' || !owner || !session || !Array.isArray(session.events) || !Number.isSafeInteger(initial.highWater) || initial.highWater !== session.events.length || ![13,14].includes(session.formatVersion)) throw new Error('Unsupported process read initial')
  if (header !== undefined && !object(header) || header && Object.hasOwn(header, 'semanticSeed') || header?.seedLength !== undefined && (!Number.isSafeInteger(header.seedLength) || header.seedLength !== 0)
    || session.events.some(e => e.type === 'conversation/seed-group')) throw new Error('Inherited process history unavailable')
  return buildSavedProcessIndex(session.events, owner, session.formatVersion)
}


export interface SavedProcessInitial { readonly session: SessionView; readonly highWater: number }
export interface FixedSavedSelection {
  append(from: number, events: readonly unknown[]): void
  current(): SavedCandidate
}
export interface SavedProcessSelector { readonly id: string; readonly instanceId?: string }
export interface FixedSavedSelections {
  append(from: number, events: readonly unknown[]): void
  assertCurrent(): void
  current(selectionIndex: number): SavedCandidate
}

/** One request-local prefix/suffix replay for a group of fixed selections.
 * Selected evidence stays independent. Visibility, project scope and
 * original result-store authority remain the caller's responsibility. */
export function createFixedSavedSelections(initial: SavedProcessInitial, owner: string, selectors: readonly SavedProcessSelector[], prepared?: ReturnType<typeof buildSavedProcessIndex>): FixedSavedSelections {
  type Watch = {
    selector: SavedProcessSelector; fixed: SavedCandidate; calls: SavedCall[]; evidence: Fact; failed: boolean
  }
  const index = prepared ?? buildObservedSavedProcessIndex(initial, owner)
  const watches: Watch[] = selectors.map(({ id, instanceId }) => {
    const selected = index.select(id, instanceId)
    if (selected.kind !== 'selected') throw new Error('Process selection unavailable: ' + selected.kind)
    const fixed = structuredClone(selected.candidate)
    const calls = [fixed.declaration, fixed.observation, fixed.sourceObservation].filter((call): call is SavedCall => call !== undefined)
    return { selector: { id, instanceId }, fixed, calls, evidence: fixed.terminal?.ref ? { ref: fixed.terminal.ref } : {}, failed: false }
  })
  const byCall = new Map<string, Set<Watch>>(), byCell = new Map<string, Set<Watch>>()
  const byInstance = new Map<string, Set<Watch>>(), implicitByJob = new Map<string, Set<Watch>>()
  const terminalInstances = new Map<string, Set<Watch>>(), terminalSources = new Map<number, Set<Watch>>(), terminalEnds = new Map<number, Set<Watch>>()
  const originalKey = (call: SavedCall) => JSON.stringify([call.surface, call.cellId ?? null, call.callId])
  function watchKey<K>(map: Map<K, Set<Watch>>, key: K, watch: Watch) {
    const bucket = map.get(key)
    if (bucket) bucket.add(watch)
    else map.set(key, new Set([watch]))
  }
  function invalidate(bucket: ReadonlySet<Watch> | undefined) {
    if (bucket) for (const watch of bucket) watch.failed = true
  }
  for (const watch of watches) {
    const { selector, fixed, calls } = watch
    for (const call of calls) {
      watchKey(byCall, originalKey(call), watch)
      if (call.cellId !== undefined) watchKey(byCell, call.cellId, watch)
    }
    if (selector.instanceId === undefined) watchKey(implicitByJob, selector.id, watch)
    if (!fixed.nativeJob) continue
    watchKey(byInstance, fixed.nativeJob.instanceId, watch)
    if (fixed.terminal) {
      watchKey(terminalInstances, fixed.nativeJob.instanceId, watch)
      watchKey(terminalSources, fixed.terminal.sourceSeq, watch)
      watchKey(terminalEnds, fixed.terminal.terminalSeq, watch)
    }
  }
  let cuts = effectiveCuts(initial.session.events)
  type Slot = { call: Fact; index: number; dispatch?: Fact; invalid: boolean }
  type Cell = { declarations: Fact[]; parentCallId: unknown; conflicting: boolean }
  const pending = new Map<string, Slot>(), completed = new Map<string, boolean>(), cells = new Map<string, Cell>()
  const unresolvedShells = new Set<string>()
  let cursor = 0, failed = false
  const keyFor = (e: Fact) => JSON.stringify([e.type.startsWith('code/') ? 'code' : 'tool', e.type.startsWith('code/') ? e.cellId : null, e.callId])
  function cellValid(call: Fact, index: number): boolean {
    if (!call.type.startsWith('code/')) return true
    const cell = cells.get(call.cellId)
    return !!cell && !cell.conflicting && cell.parentCallId === call.parentCallId && cell.declarations[0]!.index < index
  }
  function checkFixedCells(watch: Watch) {
    for (const call of watch.calls) if (call.surface === 'code') {
      const cell = cells.get(call.cellId!)
      if (cell && (cell.conflicting || cell.parentCallId !== call.parentCallId)) watch.failed = true
    }
  }
  function accept(call: SavedCall, initialPass: boolean) {
    const value = object(call.value), args = object(call.args)
    if (!args || !value || 'error' in value) return
    if (call.name === 'job_output' && typeof args.job_id === 'string') {
      const n = identity(value.native_job, owner, args.job_id)
      if (!n || args.job_instance_id !== undefined && args.job_instance_id !== n.instanceId || args.source_id !== undefined && args.source_id !== n.sourceId) return
      const targets = byInstance.get(n.instanceId)
      if (targets) for (const watch of targets) {
        if (watch.selector.id === args.job_id && (nativeRelation(watch.fixed.nativeJob!, n) === 'conflict' || remember(watch.evidence, value))) watch.failed = true
      }
      return
    }
    if (!initialPass && shellTool(call.name) && typeof value.job_id === 'string') {
      const n = call.provenance === 'inline' ? identity(value.native_job, owner, value.job_id) : undefined
      if (call.provenance === 'inline' && !n) return
      const corresponding = n && byInstance.get(n.instanceId)
      if (n && corresponding) for (const watch of corresponding) {
        const relation = nativeRelation(watch.fixed.nativeJob!, n)
        if (relation === 'conflict' || watch.fixed.terminal && relation === 'same' && call.resultSeq !== watch.fixed.declaration.resultSeq) watch.failed = true
      }
      const implicit = implicitByJob.get(value.job_id)
      if (implicit) for (const watch of implicit) {
        if (!n || !watch.fixed.nativeJob || nativeRelation(watch.fixed.nativeJob, n) !== 'same') watch.failed = true
      }
    }
  }
  function consume(raw: unknown, index: number, initialPass: boolean) {
    const e = object(raw)
    if (!e) return
    if (!initialPass && e.type === 'rewind/point' && Number.isSafeInteger(e.seq) && Number.isSafeInteger(e.anchorSeq) && e.anchorSeq < e.seq) {
      const cut = { cutFrom: e.anchorSeq, markerSeq: e.seq }
      const range = [cut]
      for (const watch of watches) {
        const { calls, fixed } = watch
        if (calls.some(c => [c.callSeq, c.dispatchSeq, c.resultSeq].some(seq => hidden(seq, range)))
          || fixed.terminal && [fixed.terminal.sourceSeq, fixed.terminal.terminalSeq].some(seq => hidden(seq, range))) watch.failed = true
      }
      for (const [id, targets] of byCell) if (id && cells.get(id)?.declarations.some(d => hidden(d.seq, range))) invalidate(targets)
      // Only outstanding records can contribute future authority; retired history is never replayed.
      for (const [key, slot] of pending) if (hidden(slot.call.seq, [cut]) || slot.dispatch && hidden(slot.dispatch.seq, [cut])) { pending.delete(key); unresolvedShells.delete(key) }
      cuts = [...cuts, cut].sort((a, b) => a.cutFrom - b.cutFrom).reduce<Cut[]>((result, next) => { const last = result.at(-1); if (last && next.cutFrom < last.markerSeq) last.markerSeq = Math.max(last.markerSeq, next.markerSeq); else result.push({ ...next }); return result }, [])
      return
    }
    if (hidden(e.seq, cuts)) return
    if (!initialPass && e.type === 'agent/delivery-source' && e.kind === 'exec') {
      invalidate(terminalInstances.get(e.sourceId)); invalidate(terminalSources.get(e.seq)); return
    }
    if (!initialPass && e.type === 'exec/end') {
      invalidate(terminalSources.get(e.sourceSeq)); invalidate(terminalInstances.get(e.instanceId)); invalidate(terminalEnds.get(e.seq)); return
    }
    if (e.type === 'code/cell' && typeof e.cellId === 'string') {
      const original: Fact = { ...structuredClone(e), index }
      const cell: Cell = cells.get(e.cellId) ?? { declarations: [], parentCallId: original.parentCallId, conflicting: false }
      if (original.sessionId !== undefined && original.sessionId !== owner || original.parentCallId !== cell.parentCallId) cell.conflicting = true
      cell.declarations.push(original)
      cells.set(e.cellId, cell)
      const targets = !initialPass && byCell.get(e.cellId)
      if (targets) for (const watch of targets) checkFixedCells(watch)
      return
    }
    if (typeof e.type !== 'string' || typeof e.callId !== 'string' || !/^(tool|code)\/(call|dispatch|result)$/.test(e.type) || e.type.startsWith('code/') && typeof e.cellId !== 'string') return
    const key = keyFor(e), kind = e.type.split('/')[1]
    if (kind === 'call') {
      const old = pending.get(key)
      if (old || completed.get(key)) invalidate(byCall.get(key))
      pending.set(key, { call: structuredClone(e), index, invalid: !!old }); if (shellTool(e.name)) unresolvedShells.add(key); return
    }
    const slot = pending.get(key)
    if (!slot) { if (!initialPass) invalidate(byCall.get(key)); return }
    if (kind === 'dispatch') { if (slot.dispatch || e.eventSeq !== undefined && e.eventSeq !== slot.call.seq) slot.invalid = true; slot.dispatch = structuredClone(e); return }
    pending.delete(key); unresolvedShells.delete(key)
    const invalidPrior = completed.get(key)
    completed.set(key, slot.invalid)
    if (slot.invalid || invalidPrior || !cellValid(slot.call, slot.index)) { invalidate(byCall.get(key)); return }
    const cellRecords = slot.call.type.startsWith('code/') ? (cells.get(slot.call.cellId)?.declarations ?? []).map(({ index: _index, ...c }) => c) : []
    const decoded = decodeProcessCalls([...cellRecords, slot.call, ...(slot.dispatch ? [slot.dispatch] : []), e], owner, [], initial.session.formatVersion === 14)
    if (decoded[0]) accept(decoded[0], initialPass)
  }
  // Seed the same pending/cell state from the original owner snapshot once.
  for (const [index, raw] of initial.session.events.entries()) consume(raw, index, true)
  for (const watch of watches) checkFixedCells(watch)
  cursor = initial.highWater
  return {
    append(from, events) {
      if (failed || from !== cursor || !Array.isArray(events) || watches.length > 0 && watches.every(watch => watch.failed)) {
        failed = true; throw new Error('Process selection conflict')
      }
      for (const raw of events) consume(raw, cursor++, false)
    },
    assertCurrent() {
      if (failed || watches.some(watch => watch.failed)) throw new Error('Process selection conflict')
      if (watches.length && unresolvedShells.size) throw new Error('Process selection unknown')
    },
    current(selectionIndex) {
      const watch = watches[selectionIndex]
      if (failed || !watch || watch.failed) throw new Error('Process selection conflict')
      if (unresolvedShells.size) throw new Error('Process selection unknown')
      return structuredClone(watch.fixed)
    },
  }
}

export function createFixedSavedSelection(initial: SavedProcessInitial, owner: string, id: string, instanceId?: string, prepared?: ReturnType<typeof buildSavedProcessIndex>): FixedSavedSelection {
  const scope = createFixedSavedSelections(initial, owner, [{ id, instanceId }], prepared)
  return { append: scope.append, current: () => scope.current(0) }
}
