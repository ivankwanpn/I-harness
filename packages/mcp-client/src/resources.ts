import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { ConnectedMcpClient } from "./client.ts"
import { fitPublicName } from "./naming.ts"
import type { McpServerConfig } from "./types.ts"

// codex resource pattern: resources/list + resources/read per server, exposed
// as I-harness helper tools. Names are server-qualified so multiple servers can
// mount without name collisions in the registry (opencode-fork naming keeps the
// `__serverName` suffix we already use for MCP tools).
//
// The qualifier goes through `fitPublicName`, NOT the raw server name: a valid
// SERVER name is not always a valid TOOL name — a plugin key
// (`plugin:<id>:<server>`) carries colons that every backend rejects, and all
// three of these register on every mount, so one plugin mount used to break
// the whole request. Simple server names stay byte-identical (the function's
// first branch).
export function createResourceTools(
  client: ConnectedMcpClient,
  serverName: string,
  config: McpServerConfig,
): Tool[] {
  const listName = fitPublicName(`list_mcp_resources__${serverName}`)
  const templatesName = fitPublicName(`list_mcp_resource_templates__${serverName}`)
  const readName = fitPublicName(`read_mcp_resource__${serverName}`)
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
    {
      name: templatesName,
      description: `List MCP resource templates from server "${serverName}" (use a template's uriTemplate with ${readName})`,
      inputSchema: { type: "object", properties: { server: { type: "string" } } },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(_args: { server?: string }, exec: ToolExec) {
        if (!client.listResourceTemplates) throw new Error(`mcp-server(${serverName}): resources/templates/list unsupported by this build's client`)
        return client.listResourceTemplates(exec.abortSignal)
      },
    },
  ]
}
