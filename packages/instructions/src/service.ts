import { InstructionConfigurationError, InstructionReadCleanupError, type InstructionService, type InstructionServiceOptions, type InstructionSnapshot, type InstructionTarget, type InstructionObservationEvent, type InstructionObservationState, type InstructionObservationLease, type ApplicableInstructionProof, type OwnedInstructionWrite } from './contracts.ts'
import { discover, frozen, key, overlaps, paths, planDiscovery, record, resolveBoundaryAliases, scopeData, targetData, type BoundaryAlias, type DiscoveryPlan, type Discovery, type Slot } from './discovery.ts'
import { applicableFingerprint, buildSnapshot, candidateFingerprint, emptySnapshot, reliability, type CachedRead } from './snapshot.ts'
import { basename, dirname } from 'node:path'
import { inside } from './discovery.ts'
import { createPendingEpochs } from './pending-epochs.ts'

// Capture capabilities without evaluating accessors or freezing their owner.
function method<T extends (...args: any[]) => any>(owner: unknown, name: string): T {
  if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) throw new InstructionConfigurationError(`Missing ${name} capability`)
  let object: object | null = owner as object
  while (object) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') break
      return descriptor.value.bind(owner) as T
    }
    object = Object.getPrototypeOf(object)
  }
  throw new InstructionConfigurationError(`Invalid ${name} capability`)
}
function observationData(value: unknown): InstructionObservationState {
  const r = record(value)
  if (!Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || typeof r.available !== 'boolean' || !Array.isArray(r.pending)) throw new InstructionConfigurationError('Invalid observation state')
  const seen = new Set<string>()
  const pending = r.pending.map(value => { const p = record(value); if (typeof p.id !== 'string' || !p.id || seen.has(p.id)) throw new InstructionConfigurationError('Invalid pending ID'); seen.add(p.id); return { id: p.id, paths: paths(p.paths) } }).sort((a, b) => a.id.localeCompare(b.id))
  const mappingPaths = r.mappingPaths === undefined ? undefined : paths(r.mappingPaths)
  if (mappingPaths && !mappingPaths.length) throw new InstructionConfigurationError('Invalid mapping scope')
  return frozen({ revision: r.revision as number, available: r.available, pending, ...(mappingPaths ? { mappingPaths } : {}) })
}
const closedError = () => Object.assign(new Error('Instruction service closed'), { code: 'INSTRUCTIONS_CLOSED' })

export function createInstructionService(options: InstructionServiceOptions): InstructionService {
  const input = record(options), scope = scopeData(input.scope)
  const subscribePort = method<InstructionServiceOptions['observation']['subscribe']>(input.observation, 'subscribe')
  const beginPending = input.beginPending === undefined ? undefined : method<NonNullable<InstructionServiceOptions['beginPending']>>(input, 'beginPending')
  const disabled = !scope.enabled || scope.maxBytes === 0
  let current = emptySnapshot(disabled), closed = false, closing: Promise<void> | undefined, running: Promise<InstructionSnapshot> | undefined
  let updateLease: InstructionObservationLease['update'] | undefined, closeLease: InstructionObservationLease['close'] | undefined
  let state: InstructionObservationState = frozen({ revision: 0, available: true, pending: [] }), hasState = false, healthy = true
  let generation = 0, needsBuild = true, interestsChanged = true, lastEvent: string | undefined
  const targets = new Map<string, InstructionTarget>(), listeners = new Set<() => void>(), cache = new Map<string, CachedRead>(), dirty = new Set<string>()
  const cleanupFailures: unknown[] = []
  let plan: DiscoveryPlan = planDiscovery(scope, [])
  let boundaryAliases: readonly BoundaryAlias[] = []
  let lastDiscovery: Discovery | undefined, healthEpoch = 0
  const externalEpoch = new Map<string, number>(), markerEpoch = new Map<string, number>(), pendingEpoch = createPendingEpochs()
  type Witness = { discovery: Discovery; external: Map<string, number>; markers: Map<string, number>; pending: Map<string, number>; health: number }
  type ProofData = { slots: string[]; membership: Map<string, string>; baseline: Map<string, string>; external: Map<string, number>; markers: Map<string, number>; pending: Map<string, number>; health: number; active: boolean }
  type OwnData = { proof: ApplicableInstructionProof; id: string; settle: () => void; candidatePaths: string[]; active: boolean }
  const witnesses = new WeakMap<InstructionSnapshot, Witness>(), proofs = new WeakMap<ApplicableInstructionProof, ProofData>(), writes = new WeakMap<OwnedInstructionWrite, OwnData>()
  const copyPending = () => pendingEpoch.snapshot()
  const candidateData = (c: InstructionSnapshot['candidates'][number]) => { const { fingerprint: _f, reliability: _r, pendingIds: _p, ...rest } = c; return JSON.stringify(rest) }
  const targetKey = (t: InstructionTarget) => `${t.kind}:${key(t.path)}`
  const exactProjection = (t: Discovery['targets'][number]) => t.membership && JSON.stringify([t.membership, t.slotIds])
  const projection = (t: Discovery['targets'][number]) => t.membership && JSON.stringify({ root: key(t.membership.root), selectedRoot: key(t.membership.selectedRoot), directory: key(t.target.kind === 'file' ? dirname(t.membership.target) : t.membership.target), boundary: key(t.membership.boundary), markers: t.membership.markers.map(m => [key(m.path), key(m.canonicalPath), m.state]), globals: t.membership.globals.map(key) })

  function publish(next: InstructionSnapshot, reconcile = false, discovery?: Discovery) {
    if (!reconcile && JSON.stringify({ ...next, revision: 0 }) === JSON.stringify({ ...current, revision: 0 })) return
    current = frozen({ ...next, revision: current.revision + 1 })
    if (discovery) witnesses.set(current, { discovery, external: new Map(externalEpoch), markers: new Map(markerEpoch), pending: copyPending(), health: healthEpoch })
    const published = current
    for (const listener of [...listeners]) {
      if (current !== published) break // reentrant publication supersedes this notice
      if (listeners.has(listener)) { try { listener() } catch { /* Observer failure cannot break the source owner. */ } }
    }
  }
  function boundaryAffects(changed: string, slot: Pick<Slot, 'scopeDirectory' | 'scopeRoot'>): boolean {
    return basename(changed) === '.git' && inside(slot.scopeRoot, changed) && inside(dirname(changed), slot.scopeDirectory)
  }
  function withBoundaryAliases(changed: readonly string[]): string[] {
    return [...changed, ...boundaryAliases.filter(alias => changed.some(path => overlaps(path, alias.canonical))).map(alias => alias.lexical)]
  }
  function slotState(slot: Pick<Slot, 'path' | 'canonicalPath' | 'scopeDirectory' | 'scopeRoot'>) {
    const ids = state.pending.filter(p => withBoundaryAliases(p.paths).some(changed => overlaps(changed, slot.path) || !!slot.canonicalPath && overlaps(changed, slot.canonicalPath) || boundaryAffects(changed, slot))).map(p => p.id)
    return { pendingIds: ids, reliability: !healthy || !state.available ? 'unavailable' as const : ids.length ? 'pending' as const : 'ready' as const }
  }
  function affectedIds(changed?: readonly string[]): Set<string> {
    if (!changed) return new Set(current.candidates.map(c => c.slotId))
    const ids = new Set(current.candidates.filter(c => changed.some(p => overlaps(p, c.path) || !!c.canonicalPath && overlaps(p, c.canonicalPath))).map(c => c.slotId))
    // Boundary markers affect all the slots for that target, even above its current Git boundary.
    for (let i = 0; i < plan.targets.length; i++) {
      const t = plan.targets[i]
      if (t.directories.some(d => changed.some(p => overlaps(p, `${d}/.git`)))) {
        for (const c of current.candidates) if (current.applicable[i]?.candidateSlotIds.includes(c.slotId) && changed.some(p => boundaryAffects(p, c))) ids.add(c.slotId)
      }
    }
    return ids
  }
  function noteExternal(changed?: readonly string[]) {
    const expanded = changed && withBoundaryAliases(changed)
    for (const id of affectedIds(expanded)) externalEpoch.set(id, (externalEpoch.get(id) ?? 0) + 1)
    for (const target of lastDiscovery?.targets ?? []) for (const marker of target.membership?.markers ?? []) {
      if (!expanded || expanded.some(p => overlaps(p, marker.path) || overlaps(p, marker.canonicalPath))) {
        const id = key(marker.path); markerEpoch.set(id, (markerEpoch.get(id) ?? 0) + 1)
      }
    }
  }
  function notePending(id: string, changed: readonly string[]) {
    pendingEpoch.record(id, affectedIds(withBoundaryAliases(changed)), state.pending.some(p => p.id === id))
  }
  function mark(changed?: readonly string[], reconcile = false) {
    if (closed || disabled) return
    if (changed) changed = withBoundaryAliases(changed)
    const ids = affectedIds(changed)
    const relevant = !changed || ids.size > 0 || plan.interests.some(i => i.candidates.some(c => changed.some(p => overlaps(p, c))))
    if (!relevant) return
    generation++; needsBuild = true; for (const id of ids) dirty.add(id)
    const candidates = current.candidates.map(c => {
      if (!ids.has(c.slotId)) return c
      const s = slotState(c), next = { ...c, ...s, reliability: s.reliability === 'ready' ? 'unavailable' as const : s.reliability }
      const { fingerprint: _, ...data } = next; return { ...next, fingerprint: candidateFingerprint(data) }
    })
    const byId = new Map(candidates.map(c => [c.slotId, c]))
    const applicable = current.applicable.map(a => {
      if (!a.candidateSlotIds.some(id => ids.has(id)) && changed) return a
      const cs = a.candidateSlotIds.flatMap(id => byId.get(id) ?? []), r = reliability(cs.map(c => c.reliability))
      return { ...a, fingerprint: applicableFingerprint(a.scopeKey, cs), reliability: r === 'ready' ? 'unavailable' as const : r, complete: false }
    })
    // A new external generation is a reconciliation opportunity even when its
    // visible snapshot is still unavailable. Internal failed builds keep the
    // default deduplication so notify→prepare cannot create its own retry loop.
    publish({ ...current, candidates, applicable, reliability: applicable.length ? reliability(applicable.map(a => a.reliability)) : 'unavailable', complete: false }, reconcile)
  }
  function accept(value: unknown, event?: InstructionObservationEvent): boolean {
    const next = observationData(value), signature = JSON.stringify(next)
    if (hasState && (next.revision < state.revision || next.revision === state.revision && signature !== JSON.stringify(state))) throw new Error('Stale or contradictory observation')
    const eventSignature = event ? JSON.stringify({ ...next, kind: event.kind, paths: event.paths }) : undefined
    if (event && next.revision === state.revision && lastEvent && eventSignature !== lastEvent) throw new Error('Contradictory observation event')
    const changed = !hasState || signature !== JSON.stringify(state)
    state = next; hasState = true
    if (eventSignature) lastEvent = eventSignature
    if (next.available && (!event || event.kind === 'reset')) healthy = true
    return changed
  }
  function onEvent(value: InstructionObservationEvent) {
    if (closed) return
    try {
      const r = record(value)
      if (!['changed', 'reset', 'availability', 'pending'].includes(r.kind as string)) throw new Error('Invalid event kind')
      const event = frozen({ ...observationData(r), kind: r.kind as InstructionObservationEvent['kind'], paths: paths(r.paths) })
      const before = state; const changed = accept(event, event)
      if (!changed) return
      const changedPending = [...new Map([...before.pending, ...state.pending].map(p => [p.id, p])).values()].filter(p => JSON.stringify(before.pending.find(x => x.id === p.id)) !== JSON.stringify(state.pending.find(x => x.id === p.id)))
      for (const p of changedPending) notePending(p.id, [...(before.pending.find(x => x.id === p.id)?.paths ?? []), ...(state.pending.find(x => x.id === p.id)?.paths ?? [])])
      const pendingChanges = changedPending.flatMap(p => [...(before.pending.find(x => x.id === p.id)?.paths ?? []), ...(state.pending.find(x => x.id === p.id)?.paths ?? [])])
      if (event.kind === 'changed') {
        if (event.paths.length) noteExternal(event.paths)
        else { healthEpoch++; noteExternal() }
      }
      const scoped = !!event.mappingPaths && event.kind !== 'reset' && event.kind !== 'availability'
      if (event.kind === 'reset' || event.kind === 'availability' || before.available !== state.available && !scoped) { healthEpoch++; noteExternal() }
      if (event.kind === 'reset' || event.kind === 'availability' || before.available !== state.available && !scoped) { interestsChanged = true; mark(undefined, true) }
      else {
        if (!state.available) interestsChanged = true
        mark([...event.paths, ...pendingChanges], true)
      }
    } catch { healthEpoch++; noteExternal(); healthy = false; interestsChanged = true; mark() }
  }
  function connect() {
    if (updateLease) return
    const lease = subscribePort(onEvent)
    // Capture close first so a malformed update capability still has a cleanup path.
    closeLease = method<InstructionObservationLease['close']>(lease, 'close')
    updateLease = method<InstructionObservationLease['update']>(lease, 'update')
  }
  async function build(): Promise<InstructionSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (closed) throw closedError()
      const captured = generation
      try {
        if (interestsChanged) {
          const watchPlan = plan; const next = await updateLease!(frozen(watchPlan.interests))
          if (closed) throw closedError()
          accept(next)
          if (generation !== captured) continue
          interestsChanged = false
        }
        // Resolve only the bounded, authorized lexical directories. Install their
        // canonical marker mappings before reading metadata under those aliases.
        const resolution = await resolveBoundaryAliases(plan)
        if (closed) throw closedError()
        if (generation !== captured) continue
        const unavailableTargets = new Set(resolution.unavailableTargets.map(t => `${t.kind}:${key(t.path)}`))
        const mappingIncomplete = unavailableTargets.size > 0
        // Retain verified invalidation mappings while a target cannot reconcile;
        // neither these old mappings nor a later content read makes it ready.
        boundaryAliases = mappingIncomplete
          ? frozen([...new Map([...boundaryAliases, ...resolution.aliases].map(alias => [key(alias.lexical), alias])).values()])
          : resolution.aliases
        if (mappingIncomplete) interestsChanged = true
        const discovery = await discover(scope, plan)
        if (closed) throw closedError()
        if (generation !== captured) continue
        for (const target of discovery.targets) {
          if (!unavailableTargets.has(`${target.target.kind}:${key(target.target.path)}`)) continue
          target.complete = false; target.message = 'Canonical boundary mapping unavailable'
        }
        const retained = new Set(discovery.slots.filter(s => s.presence !== 'absent' && !s.outside).map(s => s.slotId))
        for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id)
        const built = await buildSnapshot(discovery, scope.maxBytes, cache, dirty, slotState, () => !closed && generation === captured)
        if (closed) throw closedError()
        if (built.changed || generation !== captured) { for (const s of discovery.slots) dirty.add(s.slotId); continue }
        needsBuild = mappingIncomplete; dirty.clear()
        for (const target of discovery.targets) if (unavailableTargets.has(`${target.target.kind}:${key(target.target.path)}`)) for (const id of target.slotIds) dirty.add(id)
        lastDiscovery = discovery
        publish(built.snapshot, false, discovery)
        if (closed) throw closedError()
        if (generation !== captured) continue
        return current
      } catch (error) {
        if (error instanceof InstructionReadCleanupError) cleanupFailures.push(error.cause)
        if (closed) throw closedError()
        healthEpoch++; noteExternal(); healthy = false; interestsChanged = true; mark(); return current
      }
    }
    healthEpoch++; noteExternal(); mark(); return current
  }
  const service: InstructionService = {
    prepare(values) {
      if (closed) return Promise.reject(closedError())
      try {
        if (!Array.isArray(values)) throw new InstructionConfigurationError('Expected target list')
        const additions = (values.length ? values : [{ path: scope.cwd, kind: 'directory' }]).map(targetData)
        if (disabled) return Promise.resolve(current)
        for (const t of additions) {
          const id = `${t.kind}:${key(t.path)}`
          if (!targets.has(id)) { targets.set(id, t); generation++; needsBuild = true; interestsChanged = true }
        }
        plan = planDiscovery(scope, [...targets.values()])
        connect() // Subscribe synchronously, before build's first disk await.
        if (!needsBuild) return Promise.resolve(current)
        if (!running) running = build().finally(() => { running = undefined })
        return running
      } catch (error) { return Promise.reject(error) }
    },
    snapshot: () => current,
    canReobserve(snapshot) {
      const witness = witnesses.get(snapshot)
      if (!witness || closed || disabled || !healthy || !state.available || state.mappingPaths?.length || cleanupFailures.length) return false
      if (witness.health !== healthEpoch || !snapshot.complete || snapshot.reliability !== 'ready' || !needsBuild) return false
      if (!lastDiscovery || lastDiscovery.targets.some(target => !target.complete || !target.membership)) return false
      const changed = (now: ReadonlyMap<string, number>, before: ReadonlyMap<string, number>) => [...now].some(([id, epoch]) => epoch !== (before.get(id) ?? 0))
      return changed(externalEpoch, witness.external) || changed(markerEpoch, witness.markers) || changed(pendingEpoch.epochs, witness.pending)
    },
    proveApplicable(issued, values) {
      if (closed || !Array.isArray(values) || !values.length) throw new Error('Instruction proof unavailable')
      if (disabled) {
        if (issued !== current) throw new Error('Foreign instruction evidence')
        values.forEach(targetData)
        const proof: ApplicableInstructionProof = Object.freeze({ kind: 'applicable-instruction-proof' })
        proofs.set(proof, { slots: [], membership: new Map(), baseline: new Map(), external: new Map(), markers: new Map(), pending: new Map(), health: healthEpoch, active: true })
        return proof
      }
      const prior = witnesses.get(issued), now = witnesses.get(current)
      if (!prior || !now) throw new Error('Instruction evidence unavailable')
      const priorCandidates = new Map(issued.candidates.map(c => [c.slotId, c])), present = new Map(current.candidates.map(c => [c.slotId, c]))
      const slotSet = new Set<string>(), markers = new Set<string>(), membership = new Map<string, string>()
      for (const value of values) {
        const target = targetData(value), actual = now.discovery.targets.find(t => targetKey(t.target) === targetKey(target))
        const applicable = current.applicable.find(a => targetKey(a.target) === targetKey(target))
        if (!actual || !actual.complete || !applicable?.complete || !projection(actual)) throw new Error('Target resolver evidence unavailable')
        const originalTarget = prior.discovery.targets.find(t => targetKey(t.target) === targetKey(target))
        if (originalTarget && (!originalTarget.complete || exactProjection(originalTarget) !== exactProjection(actual))) throw new Error('Issued target membership changed')
        const compatible = prior.discovery.targets.find(t => t.complete && issued.applicable.some(a => targetKey(a.target) === targetKey(t.target) && a.complete) && projection(t) === projection(actual) && actual.slotIds.every(id => t.slotIds.includes(id)))
        if (!compatible) throw new Error('Target instruction evidence not issued')
        membership.set(targetKey(target), exactProjection(actual)!)
        for (const id of actual.slotIds) {
          const a = priorCandidates.get(id), b = present.get(id)
          if (!a || !b || candidateData(a) !== candidateData(b)) throw new Error('Instruction dependency changed')
          slotSet.add(id)
        }
        for (const marker of actual.membership!.markers) markers.add(key(marker.path))
      }
      const proof: ApplicableInstructionProof = Object.freeze({ kind: 'applicable-instruction-proof' })
      proofs.set(proof, { slots: [...slotSet], membership, baseline: new Map([...slotSet].map(id => [id, candidateData(priorCandidates.get(id)!)])), external: prior.external, markers: new Map([...markers].map(id => [id, prior.markers.get(id) ?? 0])), pending: prior.pending, health: prior.health, active: true })
      service.assertApplicable(proof)
      return proof
    },
    assertApplicable(proof, own) {
      const data = proof && proofs.get(proof), owned = own && writes.get(own)
      if (!data || !data.active || closed || data.health !== healthEpoch || !healthy || !state.available && !state.mappingPaths || own && (!owned || !owned.active || owned.proof !== proof)) throw new Error('Instruction proof revoked')
      if (!state.available && state.mappingPaths && [...affectedIds(withBoundaryAliases(state.mappingPaths))].some(id => data.slots.includes(id))) throw new Error('Instruction mapping unavailable')
      for (const [id, epoch] of data.markers) if ((markerEpoch.get(id) ?? 0) !== epoch) throw new Error('Instruction membership changed')
      for (const [id, projection] of data.membership) {
        const target = lastDiscovery?.targets.find(t => targetKey(t.target) === id)
        if (!target?.complete || exactProjection(target) !== projection) throw new Error('Instruction target membership changed')
      }
      const candidates = new Map(current.candidates.map(c => [c.slotId, c]))
      for (const id of data.slots) {
        const c = candidates.get(id)
        if (!c || candidateData(c) !== data.baseline.get(id) || (externalEpoch.get(id) ?? 0) !== (data.external.get(id) ?? 0)) throw new Error('Instruction dependency changed')
        if (!pendingEpoch.matches(id, data.pending, owned?.id)) throw new Error('Instruction pending write changed')
        if (c.pendingIds.some(id => id !== owned?.id) || c.reliability !== 'ready' && (!owned || !c.pendingIds.includes(owned.id))) throw new Error('Instruction dependency unavailable')
      }
    },
    beginOwnedWrite(proof, values) {
      service.assertApplicable(proof)
      const data = proofs.get(proof)!, candidates = current.candidates.filter(c => data.slots.includes(c.slotId)), candidatePaths = paths(values)
      if (!beginPending || !candidatePaths.length || candidatePaths.some(path => !candidates.some(c => key(c.path) === key(path) || c.canonicalPath && key(c.canonicalPath) === key(path)))) throw new Error('Instruction write unavailable')
      let lease: ReturnType<NonNullable<InstructionServiceOptions['beginPending']>>
      try { lease = beginPending(candidatePaths) } catch (error) { healthEpoch++; healthy = false; mark(); cleanupFailures.push(error); throw error }
      let settle: () => void
      try { settle = method<() => void>(lease, 'settle') }
      catch (error) { cleanupFailures.push(error); healthEpoch++; healthy = false; mark(); throw error }
      let leaseRecord: Record<string, unknown>
      try { leaseRecord = record(lease) }
      catch (error) {
        try { settle() } catch (cleanup) { cleanupFailures.push(cleanup) }
        cleanupFailures.push(error); healthEpoch++; healthy = false; mark(); throw error
      }
      if (typeof leaseRecord.id !== 'string' || !leaseRecord.id) {
        try { settle() } catch (error) { cleanupFailures.push(error) }
        healthEpoch++; healthy = false; mark()
        throw new Error('Invalid pending lease')
      }
      const own: OwnedInstructionWrite = Object.freeze({ kind: 'owned-instruction-write' })
      writes.set(own, { proof, id: leaseRecord.id, settle, candidatePaths, active: true })
      try { service.assertApplicable(proof, own) } catch (error) { try { service.settleOwnedWrite(own) } catch { /* Original cleanup debt remains. */ }; throw error }
      return own
    },
    settleOwnedWrite(own) {
      const data = own && writes.get(own)
      if (!data) throw new Error('Foreign instruction write')
      if (!data.active) return
      try { data.settle(); data.active = false; mark(data.candidatePaths, true) }
      catch (error) { healthEpoch++; healthy = false; mark(); cleanupFailures.push(error); throw error }
    },
    relation(candidatePath, inputTarget) {
      try {
        if (disabled) { paths([candidatePath]); targetData(inputTarget); return closed ? 'unknown' : 'independent' }
        const path = paths([candidatePath])[0]!, target = targetData(inputTarget), actual = lastDiscovery?.targets.find(t => targetKey(t.target) === targetKey(target))
        if (!actual?.complete || !actual.membership) return 'unknown'
        const matches = current.candidates.filter(c => key(c.path) === key(path) || c.canonicalPath && key(c.canonicalPath) === key(path))
        if (!matches.length) return 'unknown'
        return matches.some(c => actual.slotIds.includes(c.slotId)) ? 'governs' : 'independent'
      } catch { return 'unknown' }
    },
    invalidate(values) { if (closed || disabled) return; const changed = values === undefined ? undefined : paths(values); noteExternal(changed); mark(changed, true) },
    subscribe(listener) { if (closed) return () => {}; if (typeof listener !== 'function') throw new InstructionConfigurationError('Invalid listener'); listeners.add(listener); return () => { listeners.delete(listener) } },
    close() {
      if (closing) return closing
      const active = running
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([Promise.resolve().then(() => closeLease?.()), active])
        const errors = [...cleanupFailures, ...(results[0].status === 'rejected' ? [results[0].reason] : [])]
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, 'Instruction cleanup failed')
      })
      // Retry the same captured original lease after a transient close failure.
      // The closed fence and irrecoverable file-cleanup failures remain held.
      void closing.catch(() => { closing = undefined })
      closed = true; healthEpoch++; generation++; cache.clear(); publish({ ...emptySnapshot(false), applicable: current.applicable.map(a => ({ ...a, reliability: 'unavailable' as const, complete: false })) }); listeners.clear()
      return closing
    },
  }
  return Object.freeze(service)
}
