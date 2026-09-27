import { createMcpConfigStore, type McpSecretPatch, type PublicMcpConfig } from "@i-harness/mcp-client/config"
export type McpSettingsCommand = { action: "save"; config: PublicMcpConfig; secrets?: McpSecretPatch; revision: number } | { action: "enable" | "disable" | "remove"; name: string }
export function createDesktopMcp(path: string) {
  const store = createMcpConfigStore(path)
  let apply: (() => Promise<void>) | undefined
  let applyError: string | undefined
  const state = async () => ({ servers: await store.list(), ...(applyError ? { applyError } : {}) })
  const refresh = async () => {
    try { await apply?.(); applyError = undefined }
    catch { applyError = "MCP settings were saved, but live application failed. Retry after checking the server configuration."; throw new Error(applyError) }
    return state()
  }
  return {
    state, refresh,
    active: store.active,
    bindRefresh(callback: () => Promise<void>) { apply = callback },
    async mutate(value: unknown) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP settings command")
      const command = value as Record<string, unknown>
      if (command.action === "save") {
        if (!Number.isSafeInteger(command.revision) || (command.revision as number) < 0) throw new Error("MCP revision required")
        await store.save(command.config, command.secrets as McpSecretPatch | undefined, command.revision as number)
      } else {
        if (typeof command.name !== "string" || !command.name || command.name.length > 64) throw new Error("Invalid MCP server name")
        if (command.action === "remove") await store.remove(command.name)
        else if (command.action === "enable" || command.action === "disable") await store.setEnabled(command.name, command.action === "enable")
        else throw new Error("Unknown MCP operation")
      }
      try { return await refresh() } catch { return state() }
    },
  }
}
