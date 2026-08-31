import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { McpServerConfig } from "./types.ts"

// M26-B1: OAuth provider attachment（streamable-http 變體）。
export interface McpAuthAttachment { provider: OAuthClientProvider }

export async function createTransport(
  config: McpServerConfig,
  auth?: McpAuthAttachment,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.env !== undefined ? { env: config.env } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    })
  }
  // The SDK (>=~1.16) constructs this transport as (url: URL, opts?) — headers go via opts.requestInit.
  // streamable-http：authProvider 存在時 SDK 負擔 discovery/refresh；401 → redirect → UnauthorizedError。
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers !== undefined ? { requestInit: { headers: config.headers } } : {}),
    ...(auth !== undefined ? { authProvider: auth.provider } : {}),
  })
}
