/** Payload-free diagnostic contract. Messages are derived from canonical reasons. */
export interface ModelFailureFacts {
  code: string
  httpStatus?: number
  providerCode?: string
  providerType?: string
  parameter?: string
  requestId?: string
  reason?: "context-limit" | "output-limit" | "request-size" | "schema" | "message-order" | "unsupported-parameter" | "unknown"
  inputTokens?: number
  contextLimit?: number
  outputLimit?: number
  message: string
}

export const terminalErrorCodes = new Set(["ABORTED", "AUTH", "INVALID_API_KEY", "QUOTA", "CONTEXT_WINDOW_EXCEEDED", "INVALID_ARGUMENT", "MALFORMED_RESPONSE", "TLS"])
export const canonicalErrorCodes = new Set([...terminalErrorCodes, "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE", "UNKNOWN"])

export function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined
}

export function errorChain(error: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  let value = errorRecord(error)
  for (let i = 0; i < 5 && value && !result.includes(value); i++) {
    result.push(value)
    value = errorRecord(value.cause)
  }
  return result
}
