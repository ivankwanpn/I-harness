import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServerConfig } from "./types.ts"

export async function createTransport(config: McpServerConfig): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.env !== undefined ? { env: config.env } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    })
  }
  // The SDK (>=~1.16) constructs this transport as (url: URL, opts?) — headers go via opts.requestInit.
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers !== undefined ? { requestInit: { headers: config.headers } } : {}),
  })
}
