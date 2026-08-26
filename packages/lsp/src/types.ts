// LSP server config + validation (mirrors M17's mcp-client types.ts).
export interface LspServerConfig {
  serverName: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  languages: string[]
  maxMessageBytes?: number
  maxStderrBytes?: number
  killGraceMs?: number
  shutdownTimeoutMs?: number
  /** Bound for the initialize handshake during mount (a hung initialize rejects with LSP_INITIALIZE_TIMEOUT). Default 10_000. */
  startupTimeoutMs?: number
}

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const BOUND_FIELDS = ["maxMessageBytes", "maxStderrBytes", "killGraceMs", "shutdownTimeoutMs", "startupTimeoutMs"] as const

function validatePositiveBound(config: LspServerConfig, field: (typeof BOUND_FIELDS)[number]): void {
  const value = config[field]
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`lsp: ${field} must be a positive integer (got ${value})`)
  }
}

export function validateLspConfig(config: LspServerConfig): void {
  const { serverName, command, languages } = config
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error(`lsp: serverName must match ^[A-Za-z0-9_-]{1,32}$ (got "${serverName}")`)
  }
  if (!command || command.length === 0) {
    throw new Error("lsp: config requires a non-empty command")
  }
  if (!Array.isArray(languages) || languages.length === 0 || languages.some((l) => typeof l !== "string")) {
    throw new Error("lsp: languages must be a non-empty array of strings")
  }
  for (const field of BOUND_FIELDS) validatePositiveBound(config, field)
}
