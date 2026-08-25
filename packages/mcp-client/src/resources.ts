import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { ConnectedMcpClient } from "./client.ts"
import type { McpServerConfig } from "./types.ts"

// codex resource pattern: resources/list + resources/read per server, exposed
// as I-harness helper tools. Names are server-qualified so multiple servers can
// mount without name collisions in the registry (opencode-fork naming keeps the
// `__serverName` suffix we already use for MCP tools).
export function createResourceTools(
  client: ConnectedMcpClient,
  serverName: string,
  config: McpServerConfig,
): Tool[] {
  const listName = `list_mcp_resources__${serverName}`
  const readName = `read_mcp_resource__${serverName}`
  return [
    {
      name: listName,
      description: `List MCP resources from server "${serverName}" (optional server filter)`,
      inputSchema: { type: "object", properties: { server: { type: "string" } } },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(args: { server?: string }, exec: ToolExec) {
        return client.listResources(args.server ?? serverName, exec.abortSignal)
      },
    },
    {
      name: readName,
      description: `Read an MCP resource from server "${serverName}" by uri`,
      inputSchema: {
        type: "object",
        properties: { server: { type: "string" }, uri: { type: "string" } },
        required: ["server", "uri"],
      },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(args: { server: string; uri: string }, exec: ToolExec) {
        return client.readResource(args.server, args.uri, exec.abortSignal)
      },
    },
  ]
}
