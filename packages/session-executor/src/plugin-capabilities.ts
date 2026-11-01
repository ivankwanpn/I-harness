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
  type InstalledRole = { role: SubagentRole; cleanup?: import('@i-harness/subagent').RoleCleanup; removing?: Promise<void>; failure?: { cause: unknown } }
  const roles = new Map<string, InstalledRole>()
  let tail = Promise.resolve()
  let closed = false
  let retiringRoles: Promise<void> | undefined
  const reportFailures = (errors: unknown[]) => {
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Plugin cleanup requires recovery')
  }
  const removeRole = (name: string, entry: InstalledRole): Promise<void> => {
    if (entry.removing) return entry.removing
    // Retain this exact cleanup attempt before any registry/listener callback.
    const pending = Promise.resolve().then(async () => {
      if (roles.get(name) !== entry) return
      if (entry.cleanup) await entry.cleanup()
      else if (deps.roles.get(name) !== undefined) throw new Error('Original role registration cleanup unavailable')
      roles.delete(name); entry.failure = undefined
    })
    entry.removing = pending
    void pending.then(() => { entry.removing = undefined }, cause => { entry.failure = { cause }; entry.removing = undefined })
    return pending
  }
  const removeRoles = async () => {
    const errors: unknown[] = []
    for (const [name, entry] of [...roles]) try { await removeRole(name, entry) } catch (cause) { errors.push(cause) }
    reportFailures(errors)
  }
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
      if (!nextRoles.has(name) || JSON.stringify(nextRoles.get(name)) !== JSON.stringify(old.role)) await removeRole(name, old)
    }
    deps.roleResults.clear()
    for (const [name, role] of nextRoles) {
      if (roles.has(name) && deps.roles.get(name) === roles.get(name)!.role) { deps.roleResults.set(name, true); continue }
      if (deps.roles.get(name)) { deps.roleResults.set(name, false); continue }
      const entry: InstalledRole = { role }
      roles.set(name, entry)
      try { deps.roles.register(role, cleanup => { entry.cleanup = cleanup }) } catch (cause) { entry.failure = { cause }; throw cause }
      deps.roleResults.set(name, true)
    }
    if (strict && failures.length) throw new AggregateError(failures, "Plugin capability update failed")
  }
  const retireRoles = (): Promise<void> => {
    closed = true
    if (retiringRoles) return retiringRoles
    const pending = Promise.resolve().then(async () => { await tail; await removeRoles() })
    retiringRoles = pending
    void pending.then(() => { retiringRoles = undefined }, () => { retiringRoles = undefined })
    return pending
  }
  return {
    update(next: PluginCapabilities, strict = true) {
      if (closed) return Promise.reject(new Error("Plugin capabilities disposed"))
      const job = tail.then(() => apply(next, strict))
      tail = job.catch(() => undefined)
      return job
    },
    retireRoles,
    stopUpdates() { closed = true },
    async dispose() {
      closed = true
      const errors: unknown[] = []
      try { await retireRoles() } catch (cause) { errors.push(cause) }
      // A failed role retirement cannot skip independent original MCP owners.
      for (const name of [...servers.keys()]) try { await removeServer(name) } catch (cause) { errors.push(cause) }
      deps.skillDirs.splice(0); deps.mcpResults.clear(); deps.roleResults.clear()
      reportFailures(errors)
    },
  }
}
