// Thrown by the MCP client proxy when a tool/resource call arrives while the
// server has no usable generation (reconnecting / lost / closed). Fast failure
// keeps callers from hanging on a dead transport or being silently dropped.
export class McpServerUnavailableError extends Error {
  constructor(server: string) {
    super(`mcp-server(${server}): connection unavailable (reconnect in progress or exhausted)`)
    this.name = "McpServerUnavailableError"
  }
}

// M26-B1: OAuth 流失敗（回調超時/state 不符/停止）統一出口——fail-closed、可辨識。
export class McpOAuthError extends Error {
  constructor(message: string) {
    super(`mcp-client OAuth: ${message}`)
    this.name = "McpOAuthError"
  }
}
