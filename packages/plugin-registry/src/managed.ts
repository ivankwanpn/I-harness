import { join, resolve } from "node:path"
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
    async close() { closed = true; await tail },
  }
}
