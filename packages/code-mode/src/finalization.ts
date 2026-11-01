/** Constructor-private original capabilities. Not a model/public tool field or
 * a terminal DTO; successful settlement only describes the captured owners. */
export interface OriginalCellFinalization { readonly scope: 'runtime-retirement' | 'cell-finalization'; settle(): Promise<void> }
const constructors = new WeakMap<object, ReturnType<typeof createCellFinalizations>>()
export function captureOriginalCellFinalization(owner: object, id: string): OriginalCellFinalization {
  const handle = constructors.get(owner)?.capture(id)
  if (!handle) throw new Error('Original Code cell finalization unavailable')
  return handle
}
export function observeOriginalCellFinalizations(owner: object, listener: (id: string, handle: OriginalCellFinalization) => void): () => void {
  const registry = constructors.get(owner)
  if (!registry) throw new Error('Original Code constructor required')
  return registry.observe(listener)
}
export function createCellFinalizations(scope: OriginalCellFinalization['scope']) {
  const pending = new Map<string, OriginalCellFinalization>()
  const listeners = new Set<(id: string, handle: OriginalCellFinalization) => void>()
  const registry = {
    bind(owner: object) { if (constructors.has(owner)) throw new Error('Original Code constructor already associated'); constructors.set(owner, registry) },
    capture(id: string) { return pending.get(id) },
    observe(listener: (id: string, handle: OriginalCellFinalization) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    reserve(id: string, work: () => Promise<void>): OriginalCellFinalization {
      if (pending.has(id)) throw new Error('Original Code cell already owned')
      let flight: Promise<void> | undefined, acknowledged = false
      const handle = Object.freeze({ scope, settle() {
        if (acknowledged) return Promise.resolve()
        if (flight) return flight
        const attempt = Promise.resolve().then(work).then(() => {
          acknowledged = true
          if (pending.get(id) === handle) pending.delete(id)
        })
        flight = attempt
        void attempt.catch(() => { if (flight === attempt) flight = undefined })
        return attempt
      } })
      pending.set(id, handle)
      // Passive early capture only; listeners cannot supply producer authority.
      for (const listener of listeners) { try { listener(id, handle) } catch { /* Isolate passive capture consumers. */ } }
      return handle
    },
    async drain() {
      const outcomes = await Promise.allSettled([...pending.values()].map(handle => handle.settle()))
      const failed = outcomes.filter((value): value is PromiseRejectedResult => value.status === 'rejected')
      if (failed.length) throw Object.assign(new AggregateError(failed.map(value => value.reason), 'Original Code finalization incomplete'), { code: 'FACT_RECOVERY_REQUIRED' })
    },
  }
  return registry
}
