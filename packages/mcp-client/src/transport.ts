import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { McpServerConfig } from "./types.ts"
import { killWindowsProcessTree } from "./process-tree.ts"

// M26-B1: OAuth provider attachment（streamable-http 變體）。
export interface McpAuthAttachment { provider: OAuthClientProvider }

/** A-11: kill the MCP child's whole tree before the SDK closes the direct child,
 * otherwise Windows descendants keep running after the session disconnects. */
class TreeKillingStdioTransport extends StdioClientTransport {
  override async close(): Promise<void> {
    const pid = (this as unknown as { _process?: { pid?: number } })._process?.pid
    if (pid !== undefined && process.platform === "win32") await killWindowsProcessTree(pid)
    await super.close()
  }
}

export async function createTransport(
  config: McpServerConfig,
  auth?: McpAuthAttachment,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  if (config.transport === "stdio") {
    return new TreeKillingStdioTransport({
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
