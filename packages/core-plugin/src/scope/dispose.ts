import { diagnosticsFor } from "@i-harness/diagnostics"
import type { Plugin, PluginContext } from "../types.ts"

// W6 T6: ONE module-scope handle for this file's one report; the phase is
// `shutdown` because the message is emitted by an UNMOUNT disposer that timed
// out (the plugin is already removed from the registry and the teardown
// completes anyway). The level is `error`, inherited from the console.error it
// replaces, and with nothing installed the handle delegates to console.error
// verbatim (one argument) — unset mode is the pre-migration bytes.
const d = diagnosticsFor("shutdown")

const UNMOUNT_TIMEOUT_MS = 5_000

export function createPluginLifecycle(
  getContext: () => PluginContext,
  reclaimHandlers: (name: string) => void,
) {
  const plugins = new Map<string, Plugin>()
  const nestedPlugins = new Map<string, string[]>()
  let mountingPlugin: string | null = null

  function mount(plugin: Plugin): void {
    plugins.set(plugin.name, plugin)
    if (mountingPlugin !== null) {
      const nested = nestedPlugins.get(mountingPlugin) ?? []
      nested.push(plugin.name)
      nestedPlugins.set(mountingPlugin, nested)
    }
    const prev = mountingPlugin
    mountingPlugin = plugin.name
    try {
      plugin.mount(getContext())
    } finally {
      mountingPlugin = prev
    }
  }

  function unmount(name: string): Promise<void> {
    const pending: Promise<void>[] = []
    reclaim(name, pending)
    return Promise.all(pending).then(() => undefined)
  }

  // Unmount reclamation. Registry deletion, disposer invocation, nested reclaim
  // and listener/waterfall cleanup all run synchronously so a caller that fires
  // `ctx.unmount` and immediately proceeds sees the plugin reclaimed. Only
  // promise-returning disposers are awaited afterwards (with a timeout), via the
  // `pending` list collected during the synchronous pass.
  function reclaim(name: string, pending: Promise<void>[]): void {
    const plugin = plugins.get(name)
    if (!plugin) return
    plugins.delete(name) // remove before recursing so same-name/cycle chains terminate
    const disposer = plugin.unmount?.(getContext())
    if (disposer) pending.push(runDisposer(name, disposer))
    for (const child of nestedPlugins.get(name) ?? []) reclaim(child, pending)
    reclaimHandlers(name)
    nestedPlugins.delete(name)
  }

  // Audit F02-4: an unmount disposer may return a Promise. Race it against a 5s
  // timeout so a teardown can never hang forever; on timeout log an error and
  // complete anyway (the plugin is already removed from the registry). The
  // timeout timer is unref'd so a pending disposer never keeps the process alive
  // on its own.
  function runDisposer(name: string, disposer: void | Promise<void>): Promise<void> {
    let timedOut = false
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        resolve()
      }, UNMOUNT_TIMEOUT_MS)
      timer.unref?.()
    })
    return Promise.race([Promise.resolve(disposer), timeout]).then(() => {
      if (timedOut) {
        d.error(`[core-plugin] unmount disposer for '${name}' timed out after 5s`)
      }
    })
  }

  return { mount, unmount, mountingPlugin: () => mountingPlugin }
}
