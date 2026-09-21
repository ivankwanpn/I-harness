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

// M6-D1: 目錄 drain 的界破（重複 cursor／cursor 過長／條目超界／整體超時）。
// 形狀照 ScheduleInputError：`code` 是穩定的機器判別值，`reason` 是四值的
// 具體出口——一個壞掉或惡意的 server 與普通的傳輸失敗因此可以分開處理。
export class McpCatalogError extends Error {
  readonly code = "mcp_catalog"
  constructor(
    readonly reason: "repeated-cursor" | "items-cap" | "cursor-cap" | "timeout",
    message: string,
  ) {
    super(`mcp-client catalog: [${reason}] ${message}`)
    this.name = "McpCatalogError"
  }
}
