import { canonicalErrorCodes, errorChain, errorRecord } from "./types.ts"

const capacityMessage = /\b(?:selected\s+)?model\s+is\s+at\s+capacity\b/i
const capacityCode = /^server_(?:is_)?overloaded$/i

export function normalizedCode(code: string): string {
  if (/^(?:context[ _-]?(?:length|window)[ _-]?(?:exceeded|overflow)|CONTEXT_TOO_LONG)$/i.test(code)) return "CONTEXT_WINDOW_EXCEEDED"
  if (/^(rate_limit_exceeded|rate_limit_error|ThrottlingException|TooManyRequestsException)$/i.test(code)) return "RATE_LIMIT"
  if (/^(server_error|api_error|overloaded_error|ServiceUnavailableException|InternalServerException|ModelStreamErrorException)$/i.test(code) || capacityCode.test(code)) return "SERVER"
  if (/^(ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET)$/.test(code)) return "TRANSPORT"
  if (/^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|TimeoutError)$/.test(code)) return "TIMEOUT"
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return "TLS"
  if (/^(AbortError|ABORT_ERR|ERR_CANCELED)$/.test(code)) return "ABORTED"
  if (/^(insufficient_quota|billing_hard_limit_reached|quota_exceeded|ServiceQuotaExceededException)$/i.test(code)) return "QUOTA"
  if (/^(invalid_api_key|authentication_error|permission_error|permission_denied|AccessDeniedException|UnrecognizedClientException)$/i.test(code)) return "AUTH"
  if (/^(invalid_request_error|invalid_argument|not_found_error|request_too_large|ValidationException)$/i.test(code)) return "INVALID_ARGUMENT"
  return code
}

/** Only precise provider diagnostics at the beginning of a message confirm overflow.
 * Quoted context phrases in schema/tool data cannot authorize recovery. */
export function contextMessage(message: string): boolean {
  const text = message.replace(/^(?:(?:Error|RpcError|SdkRunError):\s*|model stream error:\s*|(?:invalid_request_error|ValidationException):\s*|\d{3}:\s*)+/i, "")
  if (/^(?:the )?input token count \(\d+\) exceeds the maximum number of tokens allowed \(\d+\)/i.test(text)
    || /^input length and [`]?max_tokens[`]? exceed context limit:\s*\d+\s*\+\s*\d+\s*>\s*\d+/i.test(text)
    || /^too many input tokens\.\s*max input tokens:\s*\d+/i.test(text)) return true
  return /^(?:context[ _-]?(?:length|window)[ _-]?(?:exceeded|overflow)\b|CONTEXT_TOO_LONG\b|prompt is too long\b|(?:the )?input (?:length|token count) exceeds (?:the )?(?:maximum )?context (?:length|window)\b|input is too long for (?:the )?(?:requested )?model\b|(?:your )?(?:input|request) (?:exceeds|exceeded) (?:the )?(?:model'?s? )?(?:maximum )?context (?:length|window)\b|this model'?s maximum context length is\b)/i.test(text)
}

export function retryErrorCode(error: unknown): string | undefined {
  const chain = errorChain(error)
  const candidates = chain.map(value => {
    const metadata = errorRecord(value.$metadata)
    const status = value.httpStatus ?? metadata?.httpStatusCode
    const attached = errorRecord(value.modelFailure) ?? errorRecord(errorRecord(value.data)?.modelFailure)
    const identity = typeof value.code === "string" ? normalizedCode(value.code)
      : typeof value.name === "string" && normalizedCode(value.name) !== value.name ? normalizedCode(value.name) : undefined
    const code = value.name === "AbortError" ? "ABORTED"
      : value.name === "SSEParseError" || value.name === "SyntaxError" ? "MALFORMED_RESPONSE"
      : identity && ["ABORTED", "AUTH", "INVALID_API_KEY", "QUOTA", "TLS"].includes(identity) ? identity
      : typeof attached?.code === "string" && canonicalErrorCodes.has(attached.code) ? attached.code : identity
    return { code, status, message: typeof value.message === "string" ? value.message.slice(0, 8192) : "" }
  })
  // Cancellation, credentials, quota and TLS cannot be overridden by body text.
  for (const item of candidates) {
    if (item.code && ["ABORTED", "AUTH", "INVALID_API_KEY", "QUOTA", "TLS"].includes(item.code)) return item.code
    if (item.status === 401 || item.status === 403) return "AUTH"
    if (item.status === 402) return "QUOTA"
  }
  for (const item of candidates) {
    if (item.code && item.code !== "INVALID_ARGUMENT") return item.code
    if (contextMessage(item.message)) return "CONTEXT_WINDOW_EXCEEDED"
  }
  for (const item of candidates) {
    if (item.code) return item.code
    if (item.status === 429) return "RATE_LIMIT"
    if (typeof item.status === "number" && item.status >= 500 && item.status <= 599) return "SERVER"
  }
  const message = candidates.map(item => item.message).join(" ") || (typeof error === "string" ? error.slice(0, 8192) : "")
  if (contextMessage(message)) return "CONTEXT_WINDOW_EXCEEDED"
  if (/(?:quota|balance|credit|budget|usage[\s_-]limit)[\s_-]?(?:exceeded|exhausted|reached|depleted)|insufficient_quota|billing|payment required|not enough (?:credit|balance)/i.test(message)) return "QUOTA"
  if (/malformed|invalid (?:tool|function).*argument|invalid json/i.test(message)) return "MALFORMED_RESPONSE"
  if (/\b(?:401|403)\b|invalid.api.key|authentication|unauthorized|permission denied/i.test(message)) return "AUTH"
  if (/certificate|self.signed|unable to verify|\bTLS\b|\bSSL\b/i.test(message)) return "TLS"
  if (/429|rate[\s_-]limit|too many requests/i.test(message)) return "RATE_LIMIT"
  if (/timeout|timed?\s?out|ETIMEDOUT/i.test(message)) return "TIMEOUT"
  if (/ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|fetch failed|network error|socket hang up/i.test(message)) return "TRANSPORT"
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable/i.test(message) || capacityMessage.test(message)) return "SERVER"
  return undefined
}

export function isModelCapacityError(error: unknown): boolean {
  return errorChain(error).some(value => value.capacityLimited === true || typeof value.code === "string" && capacityCode.test(value.code)
    || typeof value.message === "string" && capacityMessage.test(value.message))
}
