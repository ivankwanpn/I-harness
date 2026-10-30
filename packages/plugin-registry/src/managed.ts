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
export interface RegistryStateObserver {
  readonly status: { revision: number; attempted: number; applied: number; coverage: "pending" | "covered" | "unavailable"; failed: boolean }
  dispose(): void
  close(): Promise<void>
}
export function createManagedPluginRegistry(options: RegistryOptions, observation: { acquireStateWatch?: (path: string) => RegistryStateWatchLease } = {}) {
  const root = resolve(options.root)
  const registry = new PluginRegistry({ ...options, root })
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  const observers = new Set<RegistryStateObserver>()
  const callbacks = new AsyncLocalStorage<{ active: boolean }>()
  const assertOutside = () => { if (callbacks.getStore()?.active) throw new Error("Cannot close plugin registry from its observer callback") }
  const invoke = async (callback: () => void | Promise<void>) => {
    const context = { active: true }
    try { await callbacks.run(context, callback) }
    finally { context.active = false }
  }
  return {
    assertCanClose: assertOutside,
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
    observe(onChange: () => Promise<void>, onError: (error: unknown) => void | Promise<void>): RegistryStateObserver {
      if (closed) throw new Error("Plugin registry is closed")
      if (!observation.acquireStateWatch) throw new Error("Plugin registry observation unavailable")
      let stopped = false, dirty = false, started = false
      let revision = 0, attempted = 0, applied = 0
      let failed = false
      let coverage: "pending" | "covered" | "unavailable" = "pending"
      let flight: Promise<void> | undefined, lease: RegistryStateWatchLease | undefined, unsubscribe: (() => void) | undefined
      let closing: Promise<void> | undefined, leaseClosed = false
      let acquired!: () => void
      const acquisition = new Promise<void>(resolve => { acquired = resolve })
      const diagnostic: unknown[] = []
      const reporting = new Set<Promise<void>>()
      const report = (error: unknown) => {
        const job = invoke(() => onError(error)).catch(secondary => {
          diagnostic.push(new AggregateError([error, secondary], "Plugin observer error handler failed"))
        })
        reporting.add(job)
        void job.then(() => reporting.delete(job))
        return job
      }
      const schedule = (notification = true) => {
        if (stopped) return
        if (notification) revision++
        dirty = true
        if (flight) return
        flight = Promise.resolve().then(async () => {
          while (!stopped && dirty) {
            dirty = false; attempted = revision
            try { await invoke(onChange); applied = attempted; failed = false }
            catch (error) { failed = true; await report(error) }
          }
        }).finally(() => { flight = undefined; if (!stopped && dirty) schedule(false) })
      }
      const observer: RegistryStateObserver = {
        get status() { return { revision, attempted, applied, coverage, failed } },
        dispose() {
          stopped = true; dirty = false
          // A throwing detach remains reachable for explicit retry.
          unsubscribe?.(); unsubscribe = undefined
        },
        close() {
          try { assertOutside() } catch (error) { return Promise.reject(error) }
          if (closing) return closing
          const errors: unknown[] = []
          try { observer.dispose() } catch (error) { errors.push(error) }
          const attempt = (async () => {
            // Factory reentrancy can close before the actual lease is returned.
            await acquisition
            const results = await Promise.allSettled([
              flight, ...reporting,
              Promise.resolve().then(async () => { if (lease && !leaseClosed) { await lease.close(); leaseClosed = true } }),
            ])
            errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []))
            if (diagnostic.length) errors.push(...diagnostic.splice(0))
            if (errors.length) throw new AggregateError(errors, "Plugin observer cleanup failed")
            observers.delete(observer)
          })()
          closing = attempt
          void attempt.finally(() => { if (closing === attempt) closing = undefined }).catch(() => {})
          return attempt
        },
      }
      observers.add(observer)
      try {
        lease = observation.acquireStateWatch(join(root, "state.json"))
        // Handle readiness rejection even if subscribe throws.
        void lease.ready.then(() => {
          if (!stopped && !started && coverage !== "unavailable") { coverage = "covered"; started = true; schedule() }
        }, error => { if (!stopped) { coverage = "unavailable"; void report(error) } })
        unsubscribe = lease.subscribe(event => {
          if (stopped) return
          if (event.kind === "unavailable") { coverage = "unavailable"; void report(event.error); return }
          coverage = "covered"; started = true; schedule()
        })
        if (stopped) observer.dispose()
      } catch (error) {
        try { observer.dispose() } catch (secondary) { throw new AggregateError([error, secondary], "Plugin observer acquisition failed") }
        throw error
      } finally { acquired() }
      return observer
    },
    async close() {
      assertOutside(); closed = true
      const errors: unknown[] = []
      for (const observer of observers) {
        try { observer.dispose() } catch (error) { errors.push(error) }
      }
      const results = await Promise.allSettled([...Array.from(observers, observer => Promise.resolve().then(() => observer.close())), tail])
      errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, "Plugin registry cleanup failed")
    },
  }
}
