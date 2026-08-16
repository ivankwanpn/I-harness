import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import { createToolRegistry } from "@i-harness/core-tools"

export interface AgentPreset {
  name: string
  systemPrompt: string
  tools: string[]
  model?: string
}

export interface ToolProvider {
  resolve(name: string): Tool | null
}

export function parsePreset(text: string): AgentPreset {
  const parsed = JSON.parse(text) as Partial<AgentPreset>
  if (!parsed.name || !parsed.systemPrompt || !Array.isArray(parsed.tools)) {
    throw new Error("invalid preset: name, systemPrompt, tools required")
  }
  return parsed as AgentPreset
}

// Mounts a preset into a fresh child scope: resolves the preset's tool list
// through the provider and registers the tools into the child's tool registry,
// then returns the child scope. Resolution happens BEFORE any scope mutation so
// an unknown tool throws fail-loud with no partial mount (audit F10-1).
export function mountPreset(
  ctx: PluginContext,
  preset: AgentPreset,
  provider: ToolProvider,
): PluginContext {
  const tools = preset.tools.map((name) => {
    const tool = provider.resolve(name)
    if (!tool) {
      throw new Error(`preset '${preset.name}' requires unknown tool: ${name}`)
    }
    return tool
  })

  const child = ctx.scope.mount()

  // Per-agent configuration is scoped to the child, not the parent.
  child.services.register("preset", {
    name: preset.name,
    systemPrompt: preset.systemPrompt,
  })

  // Register the resolved tools into the child scope's tool registry, lazily
  // creating one when the caller has not exposed one as a service
  // (services.get throws when missing, so get-or-create like interaction).
  let reg: ToolRegistry
  try {
    reg = child.services.get<ToolRegistry>("tools/registry")
  } catch {
    reg = createToolRegistry(child)
    child.services.register("tools/registry", reg)
  }
  for (const tool of tools) reg.register(tool)

  return child
}
