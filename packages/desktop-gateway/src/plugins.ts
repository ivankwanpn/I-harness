import { createManagedPluginRegistry } from "@i-harness/plugin-registry/managed"

export type PluginCommand =
  | { action: "source/add"; source: string }
  | { action: "source/refresh" | "source/remove"; name: string }
  | { action: "install" | "uninstall" | "enable" | "disable"; id: string }
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")) throw new Error("Invalid plugin parameter")
  return value
}
export function createDesktopPlugins(root: string) {
  const managed = createManagedPluginRegistry({ root })
  const diagnostics = new Map<string, string[]>()
  let refresh: (() => Promise<void>) | undefined
  let refreshError: string | undefined
  let refreshTail: Promise<void> = Promise.resolve()
  const refreshLive = () => {
    const job = refreshTail.catch(() => undefined).then(async () => { await refresh?.(); refreshError = undefined })
    refreshTail = job.catch((error: unknown) => { refreshError = String(error) })
    return job
  }
  return {
    refresh: refreshLive,
    state: () => managed.run(async (registry) => ({ sources: await registry.listSources({ fetchMissing: false }), ...(await registry.catalog({ fetchMissing: false })), diagnostics: Object.fromEntries(diagnostics), ...(refreshError ? { refreshError } : {}) })),
    bindRefresh(callback: () => Promise<void>) { refresh = callback; return managed.observe(refreshLive, (error) => { refreshError = String(error) }) },
    commands: () => managed.run((registry) => registry.runtimeInputs().commandDescriptors.map(({ name, description, argumentHints }) => ({ name, description, argumentHints }))),
    report(sessionId: string, messages: string[]) {
      diagnostics.delete(sessionId); diagnostics.set(sessionId, messages.slice(-100))
      while (diagnostics.size > 100) diagnostics.delete(diagnostics.keys().next().value!)
    },
    inputs: () => managed.run((registry) => registry.runtimeInputs()),
    async mutate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin command")
      const command = value as Record<string, unknown>
      await managed.run(async (registry) => {
        switch (command.action) {
          case "source/add": await registry.addSource(text(command.source)); break
          case "source/refresh": await registry.refreshSource(text(command.name)); break
          case "source/remove": await registry.removeSource(text(command.name)); break
          case "install": await registry.install(text(command.id)); break
          case "uninstall": await registry.uninstall(text(command.id)); break
          case "enable": await registry.enable(text(command.id)); break
          case "disable": await registry.disable(text(command.id)); break
          default: throw new Error("Unknown plugin command")
        }
        return { ok: true }
      })
      try { await refreshLive() }
      catch { throw new Error("Plugin settings were saved, but live update failed; retry the operation") }
      return { ok: true }
    },
    close: async () => { await managed.close(); await refreshTail },
  }
}
