import { dirname } from "node:path"
import { toMcpServerConfigs, toSubagentRoles, type RuntimeInputs } from "@i-harness/plugin-registry"
import { createPromptCommand, registerPromptCommand, parseCommandLine, listCommands, runCommand } from "@i-harness/interaction"
import { createHookRegistry, createHookTrustStore, resolveHookTrustPath, type HookRegistry } from "@i-harness/hooks"
import type { SessionServiceOptions } from "@i-harness/session-executor"

export function pluginExtensions(inputs: RuntimeInputs, configDir: string, sessionId: string, report: (messages: string[]) => void): Awaited<ReturnType<NonNullable<SessionServiceOptions["extensionsFor"]>>> {
  const mcp = toMcpServerConfigs(inputs.mcpServerConfigs)
  const agents = toSubagentRoles(inputs.agentDescriptors, { allowedTools: ["read", "glob", "grep", "list_dir"] })
  const messages = [...mcp.skipped.map((row) => `MCP ${row.serverName}: ${row.reason}`), ...agents.unresolved.map((row) => `Agent ${row.role}: ${row.tool} (${row.reason})`)]
  const publish = () => { if (messages.length > 100) messages.splice(0, messages.length - 100); report([...messages]) }
  return {
    options: { skills: { extraDirs: inputs.skillDirs }, pluginMcp: mcp.configs, pluginAgents: agents.roles },
    async mount(assembly) {
      for (const descriptor of inputs.commandDescriptors) {
        registerPromptCommand(assembly.ctx, createPromptCommand(descriptor))
        if (descriptor.unsupported?.length) messages.push(`Command ${descriptor.name}: unsupported ${descriptor.unsupported.join(", ")}`)
      }
      const registries: HookRegistry[] = []
      const approvals = createHookTrustStore(resolveHookTrustPath(configDir))
      for (const configPath of inputs.hookConfigs) {
        try {
          const registry = await createHookRegistry(assembly.ctx, { configPath, configDir: dirname(configPath), approvals, report: (error) => { messages.push(String(error)); publish() } })
          registries.push(registry)
          for (const handler of registry.handlers()) if (!handler.valid) messages.push(`Hook ${configPath}: not granted or invalid`)
          await registry.beginSession(sessionId)
        } catch (error) { messages.push(`Hooks ${configPath}: ${String(error)}`) }
      }
      for (const [name, mounted] of assembly.pluginMcpResults) if (!mounted) messages.push(`MCP ${name}: failed to mount`)
      for (const [name, mounted] of assembly.pluginAgentResults) if (!mounted) messages.push(`Agent ${name}: failed to mount`)
      publish()
      return async () => { for (const registry of registries) await registry.endSession(sessionId).catch((error: unknown) => { messages.push(String(error)); publish() }) }
    },
  }
}

export const expandPluginPrompt: NonNullable<SessionServiceOptions["transformPrompt"]> = async (assembly, prompt) => {
  if (!prompt.startsWith("/")) return prompt
  const parsed = parseCommandLine(prompt)
  if (!parsed || !listCommands(assembly.ctx).some((row) => row.name === parsed.name)) return prompt
  const result = await runCommand(assembly.ctx, parsed.name, parsed.input)
  if (result.kind !== "prompt") throw new Error("Only prompt commands can be sent as a model task")
  return result.text
}
