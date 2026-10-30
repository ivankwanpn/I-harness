import type { SessionCoordinator } from './types.ts'

const owners = new WeakMap<SessionCoordinator, ReturnType<typeof createColdExecutionWrites>>()

/** Internal coordinator-owned post-append invalidations, never read notifications. */
export function createColdExecutionWrites() {
  const listeners = new Set<(sessionId: string) => void>()
  return {
    observe(listener: (sessionId: string) => void) {
      if (listeners.size >= 32) throw new Error('Cold execution observer capacity exceeded')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    committed(sessionId: string) {
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue
        try { listener(sessionId) } catch { /* observers cannot change write outcome */ }
      }
    },
  }
}
export function associateColdExecutionWrites(coordinator: SessionCoordinator, owner: ReturnType<typeof createColdExecutionWrites>) { owners.set(coordinator, owner) }
export function observeColdExecutionWrites(coordinator: SessionCoordinator, listener: (sessionId: string) => void) {
  const owner = owners.get(coordinator)
  if (!owner) throw new TypeError('Original coordinator required')
  return owner.observe(listener)
}
