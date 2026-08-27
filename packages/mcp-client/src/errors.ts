// Thrown by the MCP client proxy when a tool/resource call arrives while the
// server has no usable generation (reconnecting / lost / closed). Fast failure
// keeps callers from hanging on a dead transport or being silently dropped.
export class McpServerUnavailableError extends Error {
  constructor(server: string) {
    super(`mcp-server(${server}): connection unavailable (reconnect in progress or exhausted)`)
    this.name = "McpServerUnavailableError"
  }
}
