import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { ConnectedMcpClient } from "./client.ts"
import type { McpServerConfig } from "./types.ts"

// codex resource pattern: resources/list + resources/read per server, exposed
// as I-harness helper tools (opencode-fork naming).
export function createResourceTools(
  client: ConnectedMcpClient,
  serverName: string,
  config: McpServerConfig,
): Tool[] {
  return [
    {
      name: "list_mcp_resources",
      description: `List MCP resources from server "${serverName}" (optional server filter)`,
      inputSchema: { type: "object", properties: { server: { type: "string" } } },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(args: { server?: string }, _exec: ToolExec) {
        return client.listResources(args.server ?? serverName)
      },
    },
    {
      name: "read_mcp_resource",
      description: `Read an MCP resource from server "${serverName}" by uri`,
      inputSchema: {
        type: "object",
        properties: { server: { type: "string" }, uri: { type: "string" } },
        required: ["server", "uri"],
      },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(args: { server: string; uri: string }, _exec: ToolExec) {
        return client.readResource(args.server, args.uri)
      },
    },
  ]
}
