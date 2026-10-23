import { InstructionConfigurationError, InstructionReadCleanupError, type InstructionService, type InstructionServiceOptions, type InstructionSnapshot, type InstructionTarget, type InstructionObservationEvent, type InstructionObservationState, type InstructionObservationLease } from './contracts.ts'
import { discover, frozen, key, overlaps, paths, planDiscovery, record, resolveBoundaryAliases, scopeData, targetData, type BoundaryAlias, type DiscoveryPlan, type Slot } from './discovery.ts'
import { applicableFingerprint, buildSnapshot, candidateFingerprint, emptySnapshot, reliability, type CachedRead } from './snapshot.ts'
import { basename, dirname } from 'node:path'
import { inside } from './discovery.ts'

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
  return frozen({ revision: r.revision as number, available: r.available, pending })
}
const closedError = () => Object.assign(new Error('Instruction service closed'), { code: 'INSTRUCTIONS_CLOSED' })

export function createInstructionService(options: InstructionServiceOptions): InstructionService {
  const input = record(options), scope = scopeData(input.scope)
  const subscribePort = method<InstructionServiceOptions['observation']['subscribe']>(input.observation, 'subscribe')
  const disabled = !scope.enabled || scope.maxBytes === 0
  let current = emptySnapshot(disabled), closed = false, closing: Promise<void> | undefined, running: Promise<InstructionSnapshot> | undefined
  let updateLease: InstructionObservationLease['update'] | undefined, closeLease: InstructionObservationLease['close'] | undefined
  let state: InstructionObservationState = frozen({ revision: 0, available: true, pending: [] }), hasState = false, healthy = true
  let generation = 0, needsBuild = true, interestsChanged = true, lastEvent: string | undefined
  const targets = new Map<string, InstructionTarget>(), listeners = new Set<() => void>(), cache = new Map<string, CachedRead>(), dirty = new Set<string>()
  const cleanupFailures: unknown[] = []
  let plan: DiscoveryPlan = planDiscovery(scope, [])
  let boundaryAliases: readonly BoundaryAlias[] = []

  function publish(next: InstructionSnapshot) {
    if (JSON.stringify({ ...next, revision: 0 }) === JSON.stringify({ ...current, revision: 0 })) return
    current = frozen({ ...next, revision: current.revision + 1 })
    for (const listener of [...listeners]) { try { listener() } catch { /* Observer failure cannot break the source owner. */ } }
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
  function mark(changed?: readonly string[]) {
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
    publish({ ...current, candidates, applicable, reliability: applicable.length ? reliability(applicable.map(a => a.reliability)) : 'unavailable', complete: false })
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
      const pendingChanges = [...before.pending, ...state.pending].filter(p => JSON.stringify(before.pending.find(x => x.id === p.id)) !== JSON.stringify(state.pending.find(x => x.id === p.id))).flatMap(p => p.paths)
      if (event.kind === 'reset' || !state.available || before.available !== state.available) { interestsChanged = true; mark() }
      else mark([...event.paths, ...pendingChanges])
    } catch { healthy = false; interestsChanged = true; mark() }
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
        publish(built.snapshot)
        if (closed) throw closedError()
        if (generation !== captured) continue
        return current
      } catch (error) {
        if (error instanceof InstructionReadCleanupError) cleanupFailures.push(error.cause)
        if (closed) throw closedError()
        healthy = false; interestsChanged = true; mark(); return current
      }
    }
    mark(); return current
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
    invalidate(values) { if (closed || disabled) return; mark(values === undefined ? undefined : paths(values)) },
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
      closed = true; generation++; cache.clear(); publish({ ...emptySnapshot(false), applicable: current.applicable.map(a => ({ ...a, reliability: 'unavailable' as const, complete: false })) }); listeners.clear()
      return closing
    },
  }
  return Object.freeze(service)
}
