import { join, resolve } from "node:path"
import { stat } from "node:fs/promises"
import { acquireSessionLock } from "@i-harness/fs-lock"
import { PluginRegistry } from "./index.ts"
import type { RegistryOptions } from "./types.ts"
import { loadState } from "./state.ts"

/** Shared-file entry point for cooperating hosts. Registry remains the sole
 * owner of install/materialization semantics. Keep the lock through a mutation
 * so another gateway cannot consume a partially materialized installation. */
export function createManagedPluginRegistry(options: RegistryOptions) {
  const root = resolve(options.root)
  const registry = new PluginRegistry({ ...options, root })
  let tail: Promise<unknown> = Promise.resolve()
  let closed = false
  const observers = new Set<() => Promise<void>>()
  return {
    run<T>(operation: (registry: PluginRegistry) => T | Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("Plugin registry is closed"))
      const job = tail.then(async () => {
        const lock = await acquireSessionLock({ lockPath: join(root, ".registry.lock"), deadlineMs: 10000 })
        try { await loadState(root, { strict: true }); return await operation(registry) }
        finally { await lock.release() }
      })
      tail = job.catch(() => undefined)
      return job
    },
    observe(onChange: () => Promise<void>, onError: (error: unknown) => void) {
      if (closed) throw new Error("Plugin registry is closed")
      let stopped = false; let previous: string | undefined; let pending: Promise<void> | undefined
      const tick = () => {
        if (stopped || pending) return
        pending = (async () => {
          const info = await stat(join(root, "state.json")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
          const signature = info ? `${info.mtimeMs}:${info.size}` : "missing"
          if (stopped || signature === previous) return
          previous = signature
          await onChange()
        })().catch(onError).finally(() => { pending = undefined })
      }
      const timer = setInterval(tick, 250); timer.unref?.(); tick()
      const dispose = async () => { stopped = true; clearInterval(timer); await pending; observers.delete(dispose) }
      observers.add(dispose)
      return dispose
    },
    async close() { closed = true; for (const dispose of [...observers]) await dispose(); await tail },
  }
}
