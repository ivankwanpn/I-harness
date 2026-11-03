import { isOriginalExecutionHookScope, onExecutionEvent, type PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { mountMcpClient, type McpMountHandle, type McpServerConfig, type McpMountDeps } from "@i-harness/mcp-client"
import { registerSkills, createSkillsSection, scanMentionedSkillNames, skillGetName, skillSearchName } from "@i-harness/skills"
import type { RoleRegistry } from "@i-harness/subagent"
import { createPluginCapabilities } from "./plugin-capabilities.ts"
import { mountLspClient, type LspMountHandle, type LspServerConfig } from "@i-harness/lsp"
const catalogs = new WeakSet<object>()
export function isOwnedPluginCatalog(value: object): boolean { return catalogs.has(value) }

export interface OwnedPluginCatalogOptions {
  ctx: PluginContext
  tools: ToolRegistry
  roles: RoleRegistry
  workspace: string
  globalSkillDir?: string
  prepareMcpConfig?(config: McpServerConfig): McpServerConfig
  mcpDeps?: McpMountDeps
  report(message: string): void
}

/** Construct after the original tool registry exists; retain close immediately
 * before any update. Skills, roles, MCP and the refresh boundary share it. */
export function createOwnedPluginCatalog(options: OwnedPluginCatalogOptions) {
  if (!isOriginalExecutionHookScope(options.ctx)) throw new TypeError("Original execution hook scope required")
  for (const name of [skillSearchName, skillGetName]) if (options.tools.get(name)) throw new Error(`duplicate tool registration: ${name}`)
  const skillDirs: string[] = [], handles: McpMountHandle[] = []
  const lspHandles = new Set<LspMountHandle>(), pendingLsp = new Set<Promise<void>>()
  const pendingRefresh = new Set<Promise<void>>()
  const mcpResults = new Map<string, boolean>(), roleResults = new Map<string, boolean>()
  const skills = registerSkills(options.ctx, options.tools, { workspace: options.workspace, extraDirs: skillDirs, ...(options.globalSkillDir === undefined ? {} : { globalDir: options.globalSkillDir }) })
  const capabilities = createPluginCapabilities({ skillDirs, handles, roles: options.roles, mcpResults, roleResults,
    mount: config => mountMcpClient(options.ctx, options.tools, options.prepareMcpConfig?.(config) ?? config, options.mcpDeps), warn: options.report })
  let closed = false, closeFlight: Promise<void> | undefined, skillsClosed = false
  onExecutionEvent(options.ctx, "agent/pre-step", () => {
    if (closed) return
    const refresh = (async () => {
    for (const handle of [...handles]) {
      if (!handle.catalogDirty()) continue
      try { await handle.refreshCatalog() } catch (error) { options.report(`MCP ${handle.serverName} catalogue refresh failed: ${String(error)}`) }
    }
    })()
    pendingRefresh.add(refresh)
    void refresh.then(() => pendingRefresh.delete(refresh), () => pendingRefresh.delete(refresh))
    return refresh
  })
  const catalog = {
    ctx: options.ctx, tools: options.tools, capabilities, mcpResults, roleResults, skillsRegistry: skills.registry,
    skillsSection: createSkillsSection({ registry: skills.registry }),
    mentionedSkills: (text: string) => scanMentionedSkillNames(text, skills.registry),
    mountLsp(config: LspServerConfig, deps?: Parameters<typeof mountLspClient>[3]): Promise<void> {
      if (closed) return Promise.reject(new Error("Owned plugin catalog is closed"))
      const pending = mountLspClient(options.ctx, options.tools, { ...config, cwd: config.cwd ?? options.workspace }, deps).then(handle => { lspHandles.add(handle) })
      pendingLsp.add(pending)
      void pending.then(() => pendingLsp.delete(pending), () => pendingLsp.delete(pending))
      return pending
    },
    close(): Promise<void> {
      if (closeFlight) return closeFlight
      closed = true
      const flight = (async () => {
        const failures: unknown[] = []
        await Promise.allSettled([...pendingRefresh])
        await Promise.allSettled([...pendingLsp])
        try { await capabilities.dispose() } catch (error) { failures.push(error) }
        for (const handle of lspHandles) try { await handle.unmount(); lspHandles.delete(handle) } catch (error) { failures.push(error) }
        if (!skillsClosed) try { await skills.unmount(); skillsClosed = true } catch (error) { failures.push(error) }
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, "Owned plugin catalog cleanup failed")
      })()
      closeFlight = flight
      void flight.catch(() => { if (closeFlight === flight) closeFlight = undefined })
      return flight
    },
  }
  catalogs.add(catalog)
  return Object.freeze(catalog)
}
