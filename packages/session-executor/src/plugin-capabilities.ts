import type { McpMountHandle, McpServerConfig } from "@i-harness/mcp-client"
import type { RoleRegistry, SubagentRole } from "@i-harness/subagent"

export interface PluginCapabilities {
  skills?: { extraDirs?: string[] }
  pluginMcp?: McpServerConfig[]
  pluginAgents?: SubagentRole[]
  pluginAgentsEphemeral?: boolean
}

export function createPluginCapabilities(deps: {
  skillDirs: string[]; handles: McpMountHandle[]; roles: RoleRegistry
  mcpResults: Map<string, boolean>; roleResults: Map<string, boolean>
  mount(config: McpServerConfig): Promise<McpMountHandle>
  warn(message: string): void
}) {
  const servers = new Map<string, { signature: string; handle: McpMountHandle }>()
  const roles = new Map<string, SubagentRole>()
  let tail = Promise.resolve()
  let closed = false
  const removeServer = async (name: string) => {
    const entry = servers.get(name)!
    await entry.handle.unmount()
    servers.delete(name)
    const index = deps.handles.indexOf(entry.handle)
    if (index >= 0) deps.handles.splice(index, 1)
  }
  const apply = async (next: PluginCapabilities, strict = true) => {
    const failures: unknown[] = []
    deps.skillDirs.splice(0, deps.skillDirs.length, ...(next.skills?.extraDirs ?? []))
    const nextServers = new Map((next.pluginMcp ?? []).map((config) => [config.serverName, config]))
    for (const [name, old] of servers) {
      if (!nextServers.has(name) || JSON.stringify(nextServers.get(name)) !== old.signature) await removeServer(name)
    }
    deps.mcpResults.clear()
    for (const [name, config] of nextServers) {
      if (servers.has(name)) { deps.mcpResults.set(name, true); continue }
      try {
        const handle = await deps.mount(config)
        servers.set(name, { signature: JSON.stringify(config), handle }); deps.handles.push(handle)
        deps.mcpResults.set(name, true)
      } catch (error) { failures.push(error); deps.mcpResults.set(name, false); deps.warn(`Plugin MCP ${name}: ${String(error)}`) }
    }
    const nextRoles = new Map((next.pluginAgents ?? []).map((role) => [role.name, { ...role, ...(next.pluginAgentsEphemeral ? { ephemeral: true } : {}) }]))
    for (const [name, old] of roles) {
      if (!nextRoles.has(name) || JSON.stringify(nextRoles.get(name)) !== JSON.stringify(old)) {
        if (deps.roles.get(name) === old) deps.roles.remove(name)
        roles.delete(name)
      }
    }
    deps.roleResults.clear()
    for (const [name, role] of nextRoles) {
      if (roles.has(name) && deps.roles.get(name) === roles.get(name)) { deps.roleResults.set(name, true); continue }
      if (deps.roles.get(name)) { deps.roleResults.set(name, false); continue }
      deps.roles.register(role); roles.set(name, role); deps.roleResults.set(name, true)
    }
    if (strict && failures.length) throw new AggregateError(failures, "Plugin capability update failed")
  }
  return {
    update(next: PluginCapabilities, strict = true) {
      if (closed) return Promise.reject(new Error("Plugin capabilities disposed"))
      const job = tail.then(() => apply(next, strict))
      tail = job.catch(() => undefined)
      return job
    },
    async dispose() { closed = true; await tail; await apply({}) },
  }
}
