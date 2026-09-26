import { dirname } from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { toMcpServerConfigs, toSubagentRoles, type RuntimeInputs } from "@i-harness/plugin-registry"
import { createPromptCommand, registerPromptCommand, parseCommandLine, listCommands, runCommand } from "@i-harness/interaction"
import { createHookRegistry, createHookTrustStore, resolveHookTrustPath, type HookRegistry } from "@i-harness/hooks"
import type { SessionServiceOptions, SessionAssembly } from "@i-harness/session-executor"

interface Mounted {
  commands: Map<string, { signature: string; dispose(): void }>
  hooks: Map<string, { signature: string; registry: HookRegistry }>
}
const live = new WeakMap<SessionAssembly, Mounted>()

export function pluginExtensions(inputs: RuntimeInputs, configDir: string, sessionId: string, report: (messages: string[]) => void): Awaited<ReturnType<NonNullable<SessionServiceOptions["extensionsFor"]>>> {
  const mcp = toMcpServerConfigs(inputs.mcpServerConfigs)
  const agents = toSubagentRoles(inputs.agentDescriptors, { allowedTools: ["read", "glob", "grep", "list_dir"] })
  const messages = [...mcp.skipped.map((row) => `MCP ${row.serverName}: ${row.reason}`), ...agents.unresolved.map((row) => `Agent ${row.role}: ${row.tool} (${row.reason})`)]
  const publish = () => { if (messages.length > 100) messages.splice(0, messages.length - 100); report([...messages]) }
  const update = async (assembly: SessionAssembly, strict = true) => {
      const failures: unknown[] = []
      let state = live.get(assembly)
      if (!state) { state = { commands: new Map(), hooks: new Map() }; live.set(assembly, state) }
      const commands = new Map(inputs.commandDescriptors.map((descriptor) => [descriptor.name, descriptor]))
      for (const [name, old] of state.commands) {
        if (!commands.has(name) || JSON.stringify(commands.get(name)) !== old.signature) { old.dispose(); state.commands.delete(name) }
      }
      for (const [name, descriptor] of commands) {
        if (state.commands.has(name)) continue
        if (listCommands(assembly.ctx).some((entry) => entry.name === name)) { messages.push(`Command ${name}: name already registered`); continue }
        state.commands.set(name, { signature: JSON.stringify(descriptor), dispose: registerPromptCommand(assembly.ctx, createPromptCommand(descriptor)) })
        if (descriptor.unsupported?.length) messages.push(`Command ${name}: unsupported ${descriptor.unsupported.join(", ")}`)
      }
      const signatures = new Map<string, string>()
      for (const path of inputs.hookConfigs) {
        try { signatures.set(path, createHash("sha256").update(await readFile(path)).digest("hex")) }
        catch (error) { failures.push(error); messages.push(`Hooks ${path}: ${String(error)}`) }
      }
      for (const [path, old] of state.hooks) {
        if (signatures.get(path) === old.signature) continue
        try { await old.registry.endSession(sessionId) } catch (error) { messages.push(String(error)) }
        await old.registry.dispose(); state.hooks.delete(path)
      }
      const approvals = createHookTrustStore(resolveHookTrustPath(configDir))
      for (const [configPath, signature] of signatures) {
        if (state.hooks.has(configPath)) continue
        try {
          const registry = await createHookRegistry(assembly.ctx, { configPath, configDir: dirname(configPath), approvals, report: (error) => { messages.push(String(error)); publish() } })
          state.hooks.set(configPath, { signature, registry })
          for (const handler of registry.handlers()) if (!handler.valid) messages.push(`Hook ${configPath}: not granted or invalid`)
          await registry.beginSession(sessionId)
        } catch (error) {
          const failed = state.hooks.get(configPath)
          if (failed) { await failed.registry.dispose(); state.hooks.delete(configPath) }
          failures.push(error); messages.push(`Hooks ${configPath}: ${String(error)}`)
        }
      }
      for (const [name, mounted] of assembly.pluginMcpResults) if (!mounted) messages.push(`MCP ${name}: failed to mount`)
      for (const [name, mounted] of assembly.pluginAgentResults) if (!mounted) messages.push(`Agent ${name}: failed to mount`)
      publish()
      if (strict && failures.length) throw new AggregateError(failures, "Plugin hooks failed to update")
  }
  return {
    options: { skills: { extraDirs: inputs.skillDirs }, pluginMcp: mcp.configs, pluginAgents: agents.roles, pluginAgentsEphemeral: true },
    update,
    async mount(assembly) {
      await update(assembly, false)
      return async () => {
        const state = live.get(assembly); if (!state) return
        live.delete(assembly)
        for (const command of state.commands.values()) command.dispose()
        for (const { registry } of state.hooks.values()) {
          try { await registry.endSession(sessionId) } catch (error) { messages.push(String(error)); publish() }
          await registry.dispose()
        }
      }
    },
  }
}

export const expandPluginPrompt: NonNullable<SessionServiceOptions["transformPrompt"]> = async (assembly, prompt) => {
  if (!prompt.startsWith("/")) return prompt
  const parsed = parseCommandLine(prompt)
  if (!parsed) return prompt
  const result = await runCommand(assembly.ctx, parsed.name, parsed.input)
  if (result.kind !== "prompt") throw new Error("Only prompt commands can be sent as a model task")
  return result.text
}
