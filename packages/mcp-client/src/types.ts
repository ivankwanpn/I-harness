export type McpServerConfig =
  | {
      transport: "stdio"
      serverName: string
      command: string
      args: string[]
      env?: Record<string, string>
      cwd?: string
      toolCallTimeoutMs?: number
      failOnStartupError?: boolean
    }
  | {
      transport: "streamable-http"
      serverName: string
      url: string
      headers?: Record<string, string>
      toolCallTimeoutMs?: number
      failOnStartupError?: boolean
    }

export function validateMcpConfig(config: McpServerConfig): void {
  const { serverName } = config
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new Error(`mcp-client: serverName must match ^[A-Za-z0-9_-]{1,32}$ (got "${serverName}")`)
  }
  if (config.toolCallTimeoutMs !== undefined && (!Number.isInteger(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)) {
    throw new Error(`mcp-client: toolCallTimeoutMs must be a positive integer (got ${config.toolCallTimeoutMs})`)
  }
  if (config.transport === "stdio" && (!config.command || config.command.length === 0)) {
    throw new Error("mcp-client: stdio config requires a non-empty command")
  }
  if (config.transport === "streamable-http" && (!config.url || config.url.length === 0)) {
    throw new Error("mcp-client: streamable-http config requires a url")
  }
}
