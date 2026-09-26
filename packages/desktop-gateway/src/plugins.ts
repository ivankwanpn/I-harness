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
  return {
    state: () => managed.run(async (registry) => ({ sources: await registry.listSources(), ...(await registry.catalog()) })),
    inputs: () => managed.run((registry) => registry.runtimeInputs()),
    async mutate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin command")
      const command = value as Record<string, unknown>
      return managed.run(async (registry) => {
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
    },
    close: () => managed.close(),
  }
}
