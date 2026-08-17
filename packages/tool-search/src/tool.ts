import type { Tool, ToolRegistry } from "@i-harness/core-tools"

export const toolSearchName = "tool_search"

export interface ToolSearchToolDeps {
  registry: ToolRegistry
  defaultLimit: number
}

export function createToolSearchTool(deps: ToolSearchToolDeps): Tool {
  return {
    name: toolSearchName,
    description:
      "Search deferred tools with exact selection or natural language. Use select:<exact-name> for a known callable name. Matching structured tool definitions become available on the next provider call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for deferred tools." },
        limit: { type: "number", description: `Maximum number of tools to return (default: ${deps.defaultLimit}).` },
      },
      required: ["query"],
    },
    exposure: "direct",
    isReadOnly: true,
    execute: async (args: { query: string; limit?: number }) => {
      // registry.search applies the engine's defaultLimit when args.limit is
      // omitted (registerToolSearch wires defaultLimit into the engine opts).
      const matches = deps.registry.search(args.query, { limit: args.limit })
      return { query: args.query, matches, totalDeferred: deps.registry.deferredToolCount() }
    },
  }
}
