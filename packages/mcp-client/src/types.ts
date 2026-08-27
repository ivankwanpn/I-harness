// Reconnect supervisor options (dsh absorb). Absent or `enabled: false` → the
// mount behaves exactly like the pre-supervisor one-shot connect.
export interface McpReconnectConfig {
  enabled?: boolean
  initialDelayMs?: number
  maxDelayMs?: number
  maxRetries?: number
}

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
      reconnect?: McpReconnectConfig
    }
  | {
      transport: "streamable-http"
      serverName: string
      url: string
      headers?: Record<string, string>
      toolCallTimeoutMs?: number
      failOnStartupError?: boolean
      reconnect?: McpReconnectConfig
    }

export function validateMcpConfig(config: McpServerConfig): void {
  const { serverName } = config
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new Error(`mcp-client: serverName must match ^[A-Za-z0-9_-]{1,32}$ (got "${serverName}")`)
  }
  if (config.toolCallTimeoutMs !== undefined && (!Number.isInteger(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)) {
    throw new Error(`mcp-client: toolCallTimeoutMs must be a positive integer (got ${config.toolCallTimeoutMs})`)
  }
  const rc = config.reconnect
  if (rc !== undefined) {
    if (typeof rc !== "object" || rc === null || Array.isArray(rc)) {
      throw new Error("mcp-client: reconnect must be an object")
    }
    if (rc.enabled !== undefined && typeof rc.enabled !== "boolean") {
      throw new Error(`mcp-client: reconnect.enabled must be a boolean (got ${String(rc.enabled)})`)
    }
    if (rc.initialDelayMs !== undefined && (!Number.isInteger(rc.initialDelayMs) || rc.initialDelayMs <= 0)) {
      throw new Error(`mcp-client: reconnect.initialDelayMs must be a positive integer (got ${String(rc.initialDelayMs)})`)
    }
    if (rc.maxDelayMs !== undefined && (!Number.isInteger(rc.maxDelayMs) || rc.maxDelayMs <= 0)) {
      throw new Error(`mcp-client: reconnect.maxDelayMs must be a positive integer (got ${String(rc.maxDelayMs)})`)
    }
    if (rc.maxRetries !== undefined && (!Number.isInteger(rc.maxRetries) || rc.maxRetries < 1)) {
      throw new Error(`mcp-client: reconnect.maxRetries must be an integer >= 1 (got ${String(rc.maxRetries)})`)
    }
  }
  if (config.transport === "stdio" && (!config.command || config.command.length === 0)) {
    throw new Error("mcp-client: stdio config requires a non-empty command")
  }
  if (config.transport === "streamable-http" && (!config.url || config.url.length === 0)) {
    throw new Error("mcp-client: streamable-http config requires a url")
  }
}
