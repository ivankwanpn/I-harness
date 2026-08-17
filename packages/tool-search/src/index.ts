import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { createToolSearchTool } from "./tool.ts"
import { search, type SearchOptions } from "./search.ts"

export { toolSearchName } from "./tool.ts"
export { search, splitName, tokenize, searchText } from "./search.ts"
export type { Searchable, SearchOptions } from "./search.ts"

export interface ToolSearchConfig {
  defaultLimit?: number
}

export function registerToolSearch(
  _ctx: PluginContext,
  registry: ToolRegistry,
  config?: ToolSearchConfig,
): void {
  const defaultLimit = config?.defaultLimit ?? 8
  registry.installSearch((query: string, opts?: { limit?: number }) => {
    const searchOptions: SearchOptions = { defaultLimit, limit: opts?.limit }
    // The engine returns Searchable[]; the registry hook contract is ToolSchema[]
    // (name/description/inputSchema/exposure). Matches come from the deferred
    // corpus (deferredSearchIndex), so their exposure is "deferred".
    return search(query, registry.deferredSearchIndex(), searchOptions).map((match) => ({
      name: match.name,
      description: match.description,
      inputSchema: match.inputSchema,
      exposure: "deferred" as const,
    }))
  })
  const tool = createToolSearchTool({ registry, defaultLimit })
  registry.register(tool)
}
