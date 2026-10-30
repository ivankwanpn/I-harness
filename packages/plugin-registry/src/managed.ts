import { join, resolve } from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { acquireSessionLock } from "@i-harness/fs-lock"
import { PluginRegistry } from "./index.ts"
import type { RegistryOptions } from "./types.ts"
import { loadState } from "./state.ts"

type StateEvent = { kind: "changed" | "reset" } | { kind: "unavailable"; error: unknown }
export interface RegistryStateWatchLease {
  readonly ready: Promise<unknown>
  subscribe(listener: (event: StateEvent) => void): () => void
  close(): Promise<void>
}
export interface RegistryStateObserver { dispose(): void; close(): Promise<void> }
export function createManagedPluginRegistry(options: RegistryOptions, observation: { acquireStateWatch?: (path: string) => RegistryStateWatchLease } = {}) {
  const root = resolve(options.root)
  const registry = new PluginRegistry({ ...options, root })
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  const observers = new Set<RegistryStateObserver>()
  const callbacks = new AsyncLocalStorage<boolean>()
  const assertOutside = () => { if (callbacks.getStore()) throw new Error("Cannot close plugin registry from its observer callback") }
  return {
    run<T>(operation: (registry: PluginRegistry) => T | Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("Plugin registry is closed"))
      const job = tail.then(async () => {
        const lock = await acquireSessionLock({ lockPath: join(root, ".registry.lock"), deadlineMs: 10000 })
        let failed = false; let primary: unknown
        try { await loadState(root, { strict: true }); return await operation(registry) }
        catch (error) { failed = true; primary = error; throw error }
        finally { try { await lock.release() } catch (error) { if (failed) throw new AggregateError([primary, error], "Plugin registry operation and lock release failed"); throw error } }
      })
      tail = job.catch(() => undefined)
      return job
    },
    observe(onChange: () => Promise<void>, onError: (error: unknown) => void): RegistryStateObserver {
      if (closed) throw new Error("Plugin registry is closed")
      if (!observation.acquireStateWatch) throw new Error("Plugin registry observation unavailable")
      let stopped = false, dirty = false, started = false
      let flight: Promise<void> | undefined, lease: RegistryStateWatchLease | undefined, unsubscribe: (() => void) | undefined
      const diagnostic: unknown[] = []
      const report = (error: unknown) => { try { callbacks.run(true, () => onError(error)) } catch (secondary) { diagnostic.push(new AggregateError([error, secondary], "Plugin observer error handler failed")) } }
      const schedule = () => {
        if (stopped) return
        dirty = true
        if (flight) return
        flight = Promise.resolve().then(async () => {
          while (!stopped && dirty) {
            dirty = false
            try { await callbacks.run(true, onChange) } catch (error) { report(error) }
          }
        }).finally(() => { flight = undefined; if (!stopped && dirty) schedule() })
      }
      const observer: RegistryStateObserver = {
        dispose() { stopped = true; dirty = false; unsubscribe?.(); unsubscribe = undefined },
        async close() {
          assertOutside(); observer.dispose()
          const results = await Promise.allSettled([flight, lease?.close()])
          const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
          if (diagnostic.length) errors.push(...diagnostic.splice(0))
          if (errors.length) throw new AggregateError(errors, "Plugin observer cleanup failed")
          observers.delete(observer)
        },
      }
      observers.add(observer)
      try {
        lease = observation.acquireStateWatch(join(root, "state.json"))
        unsubscribe = lease.subscribe(event => {
          if (stopped) return
          if (event.kind === "unavailable") { report(event.error); return }
          started = true; schedule()
        })
        if (stopped) { unsubscribe(); unsubscribe = undefined }
        void lease.ready.then(() => { if (!started) { started = true; schedule() } }, error => { if (!stopped) report(error) })
      } catch (error) { observer.dispose(); throw error }
      return observer
    },
    async close() {
      assertOutside(); closed = true
      for (const observer of observers) observer.dispose()
      const results = await Promise.allSettled([...Array.from(observers, observer => observer.close()), tail])
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, "Plugin registry cleanup failed")
    },
  }
}
