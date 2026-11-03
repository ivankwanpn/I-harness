import type { PluginContext } from "@i-harness/core-plugin"
import { toMcpServerConfigs, toSubagentRoles, type RuntimeInputs } from "@i-harness/plugin-registry"
import type { McpServerConfig } from "@i-harness/mcp-client"
import { isOwnedPluginCatalog, type createOwnedPluginCatalog } from "../../session-executor/src/owned-plugin-catalog.ts"
import { createPromptCommand, listCommands, registerPromptCommand } from "@i-harness/interaction"
import { createExecutionHookRegistry, createHookTrustStore, resolveHookTrustPath, type HookRegistry } from "@i-harness/hooks"
import { readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { createAuthoredHookApprovals, isAuthoredHookPath } from "./hook-authoring.ts"
import { installedPluginHookRoot } from "./plugin-hook-root.ts"
import { fingerprintHookArtifacts } from "./plugin-hook-authority.ts"
import { expandPluginPromptOnContext } from "./plugin-mount.ts"

const originalMounts=new WeakSet<object>()
export function isOriginalOwnedPluginMount(value:object):boolean{return originalMounts.has(value)}

export interface OwnedPluginMountOptions {
  ctx: PluginContext
  sessionId: string
  startSource: "startup" | "resume"
  configDir: string
  workspace: string
  report(messages: string[]): void
  /** Original executor capability owner, created with this context's registry. */
  catalog?: ReturnType<typeof createOwnedPluginCatalog>
  directMcp?: McpServerConfig[]
}

/** The caller must retain close before invoking update. This owner never
 * substitutes a Session for the original context or a physical transcript. */
export function createOwnedPluginMount(options: OwnedPluginMountOptions) {
  if (options.catalog && (!isOwnedPluginCatalog(options.catalog) || options.catalog.ctx !== options.ctx)) throw new Error("Original owned plugin catalog context required")
  const commands = new Map<string, { signature: string; dispose(): void }>()
  const hooks = new Map<string, { signature: string; trustSignature: string; registry: HookRegistry; ended?: boolean; failedStartup?: { primary: unknown } }>()
  const failedStarts = new Map<string, { signature: string; primary: unknown }>()
  const messages: string[] = []
  const publish = () => { if (messages.length > 100) messages.splice(0, messages.length - 100); options.report([...messages]) }
  let closed = false
  let initial = true
  let active: Promise<void> | undefined
  let closeFlight: Promise<void> | undefined
  const mount = {
    update(inputs: RuntimeInputs, directMcp: readonly McpServerConfig[] = options.directMcp ?? []): Promise<void> {
      if (closed) throw new Error("owned plugin mount is closed")
      if (active) throw new Error("owned plugin update already in progress")
      const work = (async () => {
      const failures: unknown[] = []
      let diagnosticsChanged = false
      // Retry a failed startup's exact retained registry before other work.
      for (const [path, mounted] of hooks) if (mounted.failedStartup) {
        try { await mounted.registry.dispose(); hooks.delete(path) }
        catch (cleanup) { failures.push(mounted.failedStartup.primary, cleanup); messages.push(`Hook cleanup ${path}: ${String(cleanup)}`); diagnosticsChanged = true }
      }
      if (!options.catalog && (inputs.skillDirs.length || inputs.agentDescriptors.length || Object.keys(inputs.mcpServerConfigs).length || directMcp.length)) failures.push(new Error("owned plugin catalog owners are unavailable"))
      const signatures = new Map<string, string>()
      for (const path of inputs.hookConfigs) {
        if (installedPluginHookRoot(options.configDir, path)) { failures.push(new Error("plugin physical transcript hooks require complete compatibility")); continue }
        try { signatures.set(path, createHash("sha256").update(await readFile(path)).digest("hex")) }
        catch (error) { failures.push(error); messages.push(`Hooks ${path}: ${String(error)}`); diagnosticsChanged = true }
      }
      // The unchanged failed generation remains tombstoned even after cleanup.
      for (const [path, failure] of failedStarts) {
        if (hooks.get(path)?.failedStartup) continue
        if (signatures.get(path) === failure.signature) { failures.push(failure.primary); continue }
        if (inputs.hookConfigs.includes(path) && !signatures.has(path)) continue
        failedStarts.delete(path)
      }
      const grants = createHookTrustStore(resolveHookTrustPath(options.configDir)).list().map(entry => entry.sha256).sort()
      const trustSignature = (path: string) => JSON.stringify([grants, isAuthoredHookPath(options.configDir, path) ? signatures.get(path) : null])
      for (const [path, old] of hooks) {
        if (old.failedStartup) continue
        const trust = trustSignature(path)
        if (!old.ended && signatures.get(path) === old.signature) {
          try { await old.registry.refreshTrust(createAuthoredHookApprovals(options.configDir, path)); old.trustSignature = trust }
          catch (error) { failures.push(error); messages.push(`Hook trust ${path}: ${String(error)}`); diagnosticsChanged = true }
          continue
        }
        if (!old.ended) {
          old.ended = true
          if (old.trustSignature === trust) try { await old.registry.endSession(options.sessionId) } catch (error) { messages.push(String(error)); diagnosticsChanged = true }
        }
        try { await old.registry.dispose(); hooks.delete(path) } catch (error) { failures.push(error); messages.push(`Hook cleanup ${path}: ${String(error)}`); diagnosticsChanged = true }
      }
      if (failures.length && diagnosticsChanged) try { publish() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, "Plugin hooks failed to update")
      const mcp = toMcpServerConfigs(inputs.mcpServerConfigs)
      const agents = toSubagentRoles(inputs.agentDescriptors, { allowedTools: ["read", "glob", "grep", "list_dir"] })
      messages.push(...mcp.skipped.map(row => `MCP ${row.serverName}: ${row.reason}`), ...agents.unresolved.map(row => `Agent ${row.role}: ${row.tool} (${row.reason})`))
      await options.catalog?.capabilities.update({ skills: { extraDirs: inputs.skillDirs }, pluginMcp: [...mcp.configs, ...directMcp], pluginAgents: agents.roles, pluginAgentsEphemeral: true }, !initial)
      initial = false
      for (const [path, signature] of signatures) {
        if (hooks.has(path)) continue
        let reporterFailure: { value: unknown } | undefined
        const registry = await createExecutionHookRegistry(options.ctx, { configPath: path, configDir: dirname(path), approvals: createAuthoredHookApprovals(options.configDir, path), cwd: options.workspace, sessionId: options.sessionId, report: error => {
          messages.push(String(error))
          try { publish() } catch (value) { reporterFailure = { value }; throw value }
        } })
        const mounted = { signature, trustSignature: trustSignature(path), registry, failedStartup: undefined as { primary: unknown } | undefined }
        hooks.set(path, mounted)
        try {
          for (const handler of registry.handlers()) if (!handler.valid) messages.push(`Hook ${path}: not granted or invalid`)
          await registry.beginSession(options.sessionId, options.startSource)
        }
        catch (error) {
          mounted.failedStartup = { primary: error }
          failedStarts.set(path, { signature, primary: error })
          const startupFailures: unknown[] = [error]
          try { await registry.dispose(); hooks.delete(path) }
          catch (cleanup) { startupFailures.push(cleanup) }
          // A reporter that caused startup failure has already been invoked;
          // do not repeat its side effect just to report its own exception.
          if (!reporterFailure || !Object.is(reporterFailure.value, error)) {
            messages.push(`Hooks ${path}: ${String(error)}`)
            try { publish() } catch (reportError) { startupFailures.push(reportError) }
          }
          if (startupFailures.length === 1) throw error
          throw new AggregateError(startupFailures, "Hook startup and cleanup failed")
        }
      }
      const next = new Map(inputs.commandDescriptors.map(row => [row.name, row]))
      for (const [name, old] of commands) {
        if (!next.has(name) || JSON.stringify(next.get(name)) !== old.signature) {
          try { old.dispose(); commands.delete(name) } catch (error) { failures.push(error); messages.push(`Command cleanup ${name}: ${String(error)}`) }
        }
      }
      if (failures.length) {
        try { publish() } catch (error) { failures.push(error) }
        if (failures.length === 1) throw failures[0]
        throw new AggregateError(failures, "Plugin command cleanup failed")
      }
      for (const [name, descriptor] of next) {
        if (commands.has(name)) continue
        if (listCommands(options.ctx).some(entry => entry.name === name)) { messages.push(`Command ${name}: name already registered`); continue }
        commands.set(name, { signature: JSON.stringify(descriptor), dispose: registerPromptCommand(options.ctx, createPromptCommand(descriptor)) })
        if (descriptor.unsupported?.length) messages.push(`Command ${name}: unsupported ${descriptor.unsupported.join(", ")}`)
      }
      for (const [name, mounted] of options.catalog?.mcpResults ?? []) if (!mounted) messages.push(`MCP ${name}: failed to mount`)
      for (const [name, mounted] of options.catalog?.roleResults ?? []) if (!mounted) messages.push(`Agent ${name}: failed to mount`)
      publish()
      })()
      active = work
      return work.finally(() => { if (active === work) active = undefined })
    },
    hookContext():string {
      if(closed)throw Error('owned plugin mount is closed')
      return [...hooks.values()].filter(entry=>!entry.ended&&!entry.failedStartup).map(entry=>entry.registry.context()).filter(Boolean).join('\n\n')
    },
    hookAuthority(paths: readonly string[]): unknown[] | undefined {
      try {
        if (closed) return undefined
        return paths.map(path => {
          const mounted = hooks.get(path)
          if (!mounted || mounted.failedStartup || mounted.ended || createHash("sha256").update(readFileSync(path)).digest("hex") !== mounted.signature) throw new Error("Hook configuration is not mounted at its current revision")
          return { path, signature: mounted.signature, ...fingerprintHookArtifacts(path, mounted.registry) }
        })
      } catch { return undefined }
    },
    expand(prompt: string): Promise<string> {
      if (closed) return Promise.reject(new Error("owned plugin mount is closed"))
      return expandPluginPromptOnContext(options.ctx, prompt)
    },
    close(): Promise<void> {
      if (closeFlight) return closeFlight
      closed = true
      const flight = (async () => {
      try { await active } catch { /* cleanup still owns partial mounts */ }
      const failures: unknown[] = []
      for (const [name, command] of commands) {
        try { command.dispose(); commands.delete(name) } catch (error) { failures.push(error) }
      }
      for (const [path, mounted] of hooks) {
        if (!mounted.ended && !mounted.failedStartup) {
          mounted.ended = true
          try { await mounted.registry.endSession(options.sessionId) }
          catch (error) {
            try { options.report([String(error)]) } catch (reportError) { failures.push(error, reportError) }
          }
        }
        try { await mounted.registry.dispose(); hooks.delete(path) } catch (error) { failures.push(error) }
      }
      try { await options.catalog?.close() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, "Owned plugin cleanup failed")
      })()
      closeFlight = flight
      void flight.catch(() => { if (closeFlight === flight) closeFlight = undefined })
      return flight
    },
  }
  originalMounts.add(mount)
  return mount
}
