import type { FsWatchService, WatchCursor, WatchLease, WatchNotification } from '@i-harness/fs-watch'
import type { InstructionObservationEvent, InstructionObservationPort, InstructionObservationState, InstructionPendingWrite, InstructionScope, InstructionWatchInterest } from '../contracts.ts'
import { frozen, inside } from '../discovery.ts'
import { interestData, matchPaths, resolveInterests, type InterestPlan } from './interests.ts'

type Status = 'starting' | 'ready' | 'unavailable' | 'closed'
type Consumer = { active: boolean; receive: (event?: WatchNotification) => void }
type Route = {
  generation: number; selectionKey: string; roots: readonly string[]; lease?: WatchLease; unsubscribe?: () => void
  cursor?: WatchCursor; signature?: string; status: Status; consumers: Set<Consumer>; closing?: Promise<void>; closeFailed: boolean
}
type Shard = { generation: number; active: boolean; route: Route; consumer: Consumer; cursor?: WatchCursor; signature?: string; status: Status; first: Promise<void>; settle: () => void }
export interface PortControl {
  port: InstructionObservationPort
  pendingChanged(paths: readonly string[]): void
  close(): Promise<void>
}
export interface ObservationRoutes {
  port(scope: InstructionScope, pending: () => readonly InstructionPendingWrite[], onClosed?: () => void): PortControl
  close(): Promise<void>
}
const errors = (results: PromiseSettledResult<unknown>[]) => results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
const signature = (event: WatchNotification) => JSON.stringify(event)
function cursorOrder(previous: WatchCursor | undefined, next: WatchCursor): number {
  if (!Number.isSafeInteger(next.epoch) || next.epoch < 1 || !Number.isSafeInteger(next.revision) || next.revision < 0) return -1
  return !previous ? 1 : next.epoch !== previous.epoch ? Math.sign(next.epoch - previous.epoch) : Math.sign(next.revision - previous.revision)
}

/** Private to one observation owner. W1 still owns every physical source,
 * retry and backend close. Logical consumers never acquire or subscribe W1. */
export function createObservationRoutes(watch: FsWatchService): ObservationRoutes {
  const routes = new Map<string, Route>()
  let closed = false, generation = 0
  function broadcast(route: Route, event?: WatchNotification) {
    for (const consumer of [...route.consumers]) if (consumer.active && route.consumers.has(consumer)) consumer.receive(event)
  }
  function start(route: Route) {
    if (closed || route.status === 'closed' || !route.consumers.size || route.lease) return
    route.status = 'starting'
    const captured = route.generation
    const current = () => !closed && routes.get(route.selectionKey) === route && route.generation === captured && route.status !== 'closed'
    try {
      const lease = watch.acquire({ roots: [...route.roots], persistent: false }); route.lease = lease
      // Install rejection handling immediately. ready can certify only an
      // untouched starting route, never overwrite a newer failure notification.
      void lease.ready.then(cursor => {
        if (!current() || route.status !== 'starting' || route.cursor) return
        route.cursor = frozen({ ...cursor }); route.status = 'ready'; broadcast(route)
      }, () => {
        if (!current() || route.status !== 'starting') return
        route.status = 'unavailable'; broadcast(route)
      })
      route.unsubscribe = lease.subscribe(event => {
        if (!current()) return
        const order = cursorOrder(route.cursor, event.cursor), encoded = signature(event)
        if (order === 0 && route.signature === encoded) return
        if (order < 0 || order === 0 || route.cursor && event.cursor.epoch > route.cursor.epoch && event.kind !== 'reset') {
          route.status = 'unavailable'; broadcast(route); return
        }
        route.cursor = frozen({ ...event.cursor }); route.signature = encoded
        if (event.kind === 'reset') route.status = 'ready'
        else if (event.kind === 'unavailable') route.status = 'unavailable'
        else if (route.status !== 'ready') { route.status = 'unavailable'; broadcast(route); return }
        broadcast(route, event)
      })
      // A synchronous subscriber may have closed the last port reentrantly.
      if (!current()) { route.unsubscribe?.(); route.unsubscribe = undefined; void retire(route).catch(() => {}) }
    } catch { if (current()) { route.status = 'unavailable'; broadcast(route) } }
  }
  function retire(route: Route): Promise<void> {
    if (route.closing) return route.closing
    route.status = 'closed'; route.generation++; route.unsubscribe?.(); route.unsubscribe = undefined
    route.closing = Promise.resolve().then(() => route.lease?.close()).then(() => {
      route.closeFailed = false
      if (routes.get(route.selectionKey) === route) routes.delete(route.selectionKey)
    }, error => { route.closeFailed = true; throw error })
    void route.closing.catch(() => { route.closing = undefined })
    return route.closing
  }
  async function attach(roots: readonly string[], consumer: Consumer, bind: (route: Route) => void): Promise<Route> {
    const selectionKey = JSON.stringify({ roots, ignore: [], persistent: false })
    let route = routes.get(selectionKey)
    if (route?.status === 'closed') {
      // Tombstones survive failed cleanup. A caller gets bounded unavailable;
      // only a later explicit attempt retries close before reacquisition.
      await retire(route)
      if (closed || !consumer.active) throw new Error('Observation closed')
      route = routes.get(selectionKey)
    }
    if (!route) {
      route = { generation: ++generation, selectionKey, roots, status: 'starting', consumers: new Set(), closeFailed: false }
      routes.set(selectionKey, route)
    }
    bind(route)
    route.consumers.add(consumer)
    start(route)
    // Consumer has already been registered by its port; install its route before
    // start can synchronously call back, without a Promise continuation gap.
    return route
  }
  function detach(shard: Shard): Promise<void> {
    shard.active = false; shard.consumer.active = false; shard.settle()
    const route = shard.route; route.consumers.delete(shard.consumer)
    return !route.consumers.size ? retire(route) : Promise.resolve()
  }

  function port(scope: InstructionScope, pendingSource: () => readonly InstructionPendingWrite[], onClosed?: () => void): PortControl {
    const listeners = new Set<(event: InstructionObservationEvent) => void>(), shards = new Map<string, Shard>()
    const cleanup = new Set<Promise<void>>(), failedRoutes = new Set<Route>()
    let plan: InterestPlan | undefined, staging: InterestPlan | undefined, interestGeneration = 0, mappingVersion = 0
    let registered: readonly InstructionWatchInterest[] = []
    let stopped = false, mappingDirty = true, revision = 0, exhausted = false, running: Promise<InstructionObservationState> | undefined, closing: Promise<void> | undefined
    let state: InstructionObservationState = frozen({ revision, available: false, pending: [] })
    let dirty = new Set<string>(), reset = false, updating = false
    let scopedMapping: Set<string> | undefined
    const activePlans = () => [plan, staging].filter((value): value is InterestPlan => !!value)
    const pendingPaths = (changed: readonly string[]) => [...new Set([
      ...activePlans().flatMap(value => matchPaths(value, changed, true).paths),
      // Lexical slots remain registered when alias resolution fails. They can
      // report pending, but cannot certify independent canonical coverage.
      ...registered.flatMap(interest => interest.candidates.filter(candidate => changed.some(path => inside(path, candidate)))),
    ])].sort()
    function pending(): InstructionPendingWrite[] {
      return pendingSource().flatMap(token => {
        const matched = pendingPaths(token.paths)
        return matched.length ? [{ id: token.id, paths: matched }] : []
      }).sort((a, b) => a.id.localeCompare(b.id))
    }
    const available = () => !stopped && !closed && !exhausted && !mappingDirty && [...shards.values()].every(shard => shard.active && shard.status === 'ready')
    function publish(kind: InstructionObservationEvent['kind'], paths: readonly string[] = []) {
      if (exhausted) return
      if (revision >= Number.MAX_SAFE_INTEGER - 1) { exhausted = true; mappingDirty = true; kind = 'availability'; paths = [] }
      revision++
      let nextPending: InstructionPendingWrite[]
      try { nextPending = pending() } catch { mappingVersion++; mappingDirty = true; scopedMapping = undefined; nextPending = [...state.pending] }
      state = frozen({ revision, available: available(), pending: nextPending, ...(scopedMapping?.size && !stopped && !closed && !exhausted && [...shards.values()].every(shard => shard.status === 'ready') ? { mappingPaths: [...scopedMapping] } : {}) })
      const event = frozen({ ...state, kind, paths: [...paths] })
      for (const listener of [...listeners]) {
        // A reentrant pending/close publication already delivered the newer
        // complete state. Never follow it with this superseded revision.
        if (state.revision !== event.revision) break
        if (listeners.has(listener)) { try { listener(event) } catch { /* subscribers are isolated */ } }
      }
    }
    function affect(kind: InstructionObservationEvent['kind'], paths: readonly string[] = []) {
      if (stopped) return
      if (kind === 'reset' || kind === 'availability') scopedMapping = undefined
      if (updating) {
        if (kind === 'reset' || kind === 'availability') reset = true
        for (const path of paths) { if (dirty.size >= 1024) { reset = true; dirty.clear(); break } dirty.add(path) }
        if (!plan && kind !== 'pending') return
      }
      // Dirty publication must be synchronous, including pending begin/settle.
      publish(kind, paths)
    }
    function receive(shard: Shard, event?: WatchNotification) {
      if (stopped || !shard.active || !shard.consumer.active || shards.get(shard.route.selectionKey) !== shard) return
      if (shard.generation !== interestGeneration) return
      if (event) {
        const order = cursorOrder(shard.cursor, event.cursor), encoded = signature(event)
        if (order === 0 && encoded === shard.signature) return
        if (order <= 0 || shard.cursor && event.cursor.epoch > shard.cursor.epoch && event.kind !== 'reset') {
          shard.status = 'unavailable'; shard.settle(); affect('availability'); return
        }
        shard.cursor = event.cursor; shard.signature = encoded
      } else { shard.cursor = shard.route.cursor; shard.signature = shard.route.signature }
      const previousStatus = shard.status
      shard.status = shard.route.status
      if (shard.status !== 'starting') shard.settle()
      if (shard.status !== 'ready') {
        // Retrying an acquire that still throws has no new W1 generation.
        // Settle its waiter without turning the same failure into a fresh event.
        if (event || previousStatus !== shard.status) affect('availability')
        return
      }
      if (!event || event.kind === 'reset') {
        mappingVersion++; mappingDirty = true
        affect('reset'); return
      }
      if (event.kind === 'changed') {
        try {
          const matched = activePlans().map(value => matchPaths(value, event.changes.map(change => change.path)))
          const changed = [...new Set(matched.flatMap(value => value.paths))]
          if (matched.some(value => value.mapping)) { mappingVersion++; mappingDirty = true; affect('reset', changed) }
          else if (changed.length) {
            // W1 may classify atomic replacement as change. That can replace a
            // regular candidate with a symlink, so content alone cannot certify
            // its routing alias. Revalidate only on this observed invalidation.
            if (!mappingDirty && plan) scopedMapping = new Set()
            if (scopedMapping) for (const path of changed) scopedMapping.add(path)
            if (scopedMapping && scopedMapping.size > 1024) scopedMapping = undefined
            mappingVersion++; mappingDirty = true; affect('changed', changed)
          }
        } catch { mappingVersion++; mappingDirty = true; affect('reset') }
      }
    }
    function retainCleanup(shard: Shard): Promise<void> {
      const result = detach(shard); cleanup.add(result)
      void result.then(() => { cleanup.delete(result); failedRoutes.delete(shard.route) }, () => { cleanup.delete(result); failedRoutes.add(shard.route) })
      return result
    }
    async function install(next: InterestPlan) {
      staging = next
      for (const roots of next.selections) {
        if (stopped) return
        const selectionKey = JSON.stringify({ roots, ignore: [], persistent: false })
        const existing = shards.get(selectionKey)
        if (existing) {
          if (!existing.route.lease) {
            // A thrown acquire owns no W1 retry resource. A fresh host update
            // may try again after capacity frees; there is no retry timer here.
            existing.first = new Promise<void>(resolve => { existing.settle = resolve })
            start(existing.route)
          }
          continue
        }
        let settle!: () => void
        const first = new Promise<void>(resolve => { settle = resolve })
        let shard!: Shard
        const consumer: Consumer = { active: true, receive: event => receive(shard, event) }
        const route = await attach(roots, consumer, route => {
          shard = { generation: interestGeneration, active: true, route, consumer, status: route.status, first, settle }
          shards.set(selectionKey, shard)
        })
        if (stopped) {
          consumer.active = false; route.consumers.delete(consumer)
          if (!route.consumers.size) { const result = retire(route); cleanup.add(result); void result.catch(() => failedRoutes.add(route)) }
          return
        }
        if (route.status !== 'starting') receive(shard) // private join reset only
      }
      await Promise.all([...shards.values()].map(shard => shard.first))
    }
    async function update(input: readonly InstructionWatchInterest[]): Promise<InstructionObservationState> {
      if (stopped || closed) return state
      const priorInterests = JSON.stringify(registered), priorMapping = plan?.signature
      updating = true; dirty = new Set(); reset = false
      const finish = () => {
        // A repeated unavailable update is an internal attempt, not a new
        // recovery opportunity. Actual callbacks set reset/dirty and publish
        // immediately; changed interests/mappings/outcomes still get a barrier.
        if (priorInterests !== JSON.stringify(registered) || priorMapping !== plan?.signature || reset || dirty.size || state.available !== available()) {
          if (scopedMapping?.size) publish('changed', [...scopedMapping])
          else publish('reset', reset ? [] : [...dirty])
        }
        if (!mappingDirty) scopedMapping = undefined
        return state
      }
      try {
        const interests = interestData(scope, input)
        registered = interests
        const retiredFailures = errors(await Promise.allSettled([...failedRoutes].map(async route => {
          await retire(route); failedRoutes.delete(route)
        })))
        if (retiredFailures.length) throw new AggregateError(retiredFailures, 'Retired observation cleanup still unavailable')
        if (stopped) return state
        let next = await resolveInterests(scope, interests)
        if (stopped) return state
        if (plan?.signature === next.signature && !mappingDirty && [...shards.values()].every(shard => shard.status === 'ready')) return state
        interestGeneration++; for (const shard of shards.values()) shard.generation = interestGeneration
        mappingDirty = true
        const original = new Set(shards.keys())
        let stable = false, covered = next, verifiedMapping: number | undefined
        for (let round = 0; round < 3; round++) {
          if (round) {
            // Retain original coverage, but retire superseded staging routes
            // before another mapping round: never exceed old four + new four.
            const retained = new Set(next.selections.map(roots => JSON.stringify({ roots, ignore: [], persistent: false })))
            const obsolete = [...shards.values()].filter(shard => !original.has(shard.route.selectionKey) && !retained.has(shard.route.selectionKey))
            for (const shard of obsolete) shards.delete(shard.route.selectionKey)
            const failures = errors(await Promise.allSettled(obsolete.map(retainCleanup)))
            if (failures.length) throw new AggregateError(failures, 'Staged coverage cleanup failed')
          }
          await install(next)
          covered = next
          if (stopped) return state
          const wanted = new Set(next.selections.map(roots => JSON.stringify({ roots, ignore: [], persistent: false })))
          if ([...shards.values()].some(shard => wanted.has(shard.route.selectionKey) && shard.status !== 'ready')) break
          const capturedMapping = mappingVersion
          const verified = await resolveInterests(scope, interests)
          if (stopped) return state
          if (verified.signature === next.signature && capturedMapping === mappingVersion) { stable = true; verifiedMapping = capturedMapping; break }
          next = verified
        }
        // Coverage is not committed until retired cleanup is joined. Any reset
        // or mapping failure during that await must invalidate this verification.
        plan = covered; staging = undefined; mappingDirty = true
        const wanted = new Set(covered.selections.map(roots => JSON.stringify({ roots, ignore: [], persistent: false })))
        const removed = [...shards.values()].filter(shard => !wanted.has(shard.route.selectionKey))
        for (const shard of removed) shards.delete(shard.route.selectionKey)
        const failures = errors(await Promise.allSettled(removed.map(retainCleanup)))
        if (stopped) return state
        if (!failures.length && stable && verifiedMapping === mappingVersion) mappingDirty = false
        // Everything received before this synchronous capture is represented by
        // the final reset and complete pending set. IA must reread under coverage.
        return finish()
      } catch {
        if (!stopped) {
          scopedMapping = undefined
          mappingDirty = true
          if (staging) {
            // An unsuccessful mapping check still ends this handoff. Retain the
            // attempted set unavailable, rather than accumulating old+new sets
            // across subsequent failed updates beyond the four-shard bound.
            plan = staging; staging = undefined
            const wanted = new Set(plan.selections.map(roots => JSON.stringify({ roots, ignore: [], persistent: false })))
            const removed = [...shards.values()].filter(shard => !wanted.has(shard.route.selectionKey))
            for (const shard of removed) shards.delete(shard.route.selectionKey)
            await Promise.allSettled(removed.map(retainCleanup))
          }
          if (!stopped) finish()
        }
        return state
      }
      finally { updating = false; staging = undefined; dirty.clear() }
    }
    const control: PortControl = {
      port: Object.freeze({ subscribe(listener: (event: InstructionObservationEvent) => void) {
        if (typeof listener !== 'function') throw new Error('Invalid observation subscriber')
        if (!stopped) listeners.add(listener)
        return Object.freeze({ update(input: readonly InstructionWatchInterest[]) {
          if (stopped) return Promise.resolve(state)
          // Serialize replacement transactions; each call owns its copied input.
          let copied: readonly InstructionWatchInterest[]
          try { copied = interestData(scope, input) } catch { mappingVersion++; mappingDirty = true; publish('reset'); return Promise.resolve(state) }
          const before = running
          const result = before ? before.then(() => update(copied)) : update(copied)
          running = result
          void result.finally(() => { if (running === result) running = undefined })
          return result
        }, close: () => control.close() })
      } }),
      pendingChanged(paths) {
        if (stopped) return
        try {
          const matched = pendingPaths(paths)
          if (matched.length) affect('pending', matched)
        } catch { mappingVersion++; mappingDirty = true; affect('availability') }
      },
      close() {
        if (closing) return closing
        const active = running, retired = [...shards.values()]
        const joined: Promise<void>[] = []
        // Reserve the join before terminal publication can call close again.
        closing = Promise.resolve().then(async () => {
          const results = await Promise.allSettled([...joined, ...cleanup, active])
          const failures = errors(results)
          if (failures.length) throw new AggregateError(failures, 'Instruction observation cleanup failed')
          onClosed?.()
        })
        stopped = true; interestGeneration++; mappingDirty = true; shards.clear()
        publish('availability'); listeners.clear()
        joined.push(...retired.map(retainCleanup))
        for (const route of failedRoutes) joined.push(retire(route))
        void closing.catch(() => { closing = undefined })
        return closing
      },
    }
    return control
  }
  return { port, async close() {
    closed = true
    const failures = errors(await Promise.allSettled([...routes.values()].map(retire)))
    if (failures.length) throw new AggregateError(failures, 'Instruction route cleanup failed')
  } }
}
