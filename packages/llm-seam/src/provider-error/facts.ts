import { normalizedCode, retryErrorCode } from "./classify.ts"
import { canonicalErrorCodes, errorChain, errorRecord, type ModelFailureFacts } from "./types.ts"
import { localValidationRejection, sanitizePreparedValidation } from '../prepared/validation.ts'

const providerNames = /^(?:context_length_exceeded|context_window_exceeded|CONTEXT_TOO_LONG|invalid_request_error|invalid_argument|not_found_error|request_too_large|rate_limit_exceeded|rate_limit_error|server_error|api_error|overloaded_error|server_is_overloaded|server_overloaded|insufficient_quota|billing_hard_limit_reached|quota_exceeded|invalid_api_key|authentication_error|permission_error|permission_denied|ValidationException|ServiceQuotaExceededException|AccessDeniedException|UnrecognizedClientException|ThrottlingException|TooManyRequestsException|ServiceUnavailableException|InternalServerException|ModelStreamErrorException|INVALID_ARGUMENT|RESOURCE_EXHAUSTED|UNAUTHENTICATED|PERMISSION_DENIED|INTERNAL|UNAVAILABLE)$/i
const parameters = new Set(["messages", "input", "prompt", "tools", "max_tokens", "max_output_tokens", "max_completion_tokens", "generationConfig.maxOutputTokens", "model", "temperature", "thinking", "thinking.budget_tokens"])
const reasons = new Set<ModelFailureFacts["reason"]>(["context-limit", "output-limit", "request-size", "schema", "message-order", "unsupported-parameter", 'binding', 'native-replay', "unknown"])
const explanations: Record<string, string> = {
  "context-limit": "Model input exceeds the context window.", "output-limit": "Requested model output exceeds the output limit.",
  "request-size": "Model request exceeds the request size limit.", schema: "Model request schema is invalid.",
  "message-order": "Model request message order is invalid.", "unsupported-parameter": "Model request contains an unsupported parameter.",
  binding: 'Model request does not match its selected binding.', 'native-replay': 'Model request native replay is incompatible.',
  AUTH: "Model authentication failed.", INVALID_API_KEY: "Model authentication failed.", QUOTA: "Model quota is exhausted.",
  ABORTED: "Model request was aborted.", TLS: "Model TLS connection failed.", RATE_LIMIT: "Model request was rate limited.",
  TIMEOUT: "Model request timed out.", TRANSPORT: "Model transport failed.", SERVER: "Model service failed.",
  MALFORMED_RESPONSE: "Model response is malformed.", EMPTY_RESPONSE: "Model response is empty.",
}
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const requestId = (value: unknown): value is string => typeof value === "string" && /^(?:req[-_][a-zA-Z0-9_-]{1,120}|[a-f0-9]{8}-[a-f0-9-]{27,36}|aws-[a-zA-Z0-9-]{1,100}|[a-f0-9]{16,128})$/i.test(value)

/** Revalidate at every process/storage boundary; never trust an incoming message. */
export function safeModelFailureFacts(value: unknown): ModelFailureFacts | undefined {
  const source = errorRecord(value)
  if (!source || typeof source.code !== "string" || !canonicalErrorCodes.has(source.code)) return
  const reason: ModelFailureFacts["reason"] = source.code === "CONTEXT_WINDOW_EXCEEDED" ? "context-limit"
    : source.code === "INVALID_ARGUMENT" && source.reason !== "context-limit" && reasons.has(source.reason as ModelFailureFacts["reason"]) ? source.reason as ModelFailureFacts["reason"] : "unknown"
  const result: ModelFailureFacts = { code: source.code, reason, message: explanations[reason!] ?? explanations[source.code] ?? "Model request failed." }
  const validation = sanitizePreparedValidation(source.validation)
  if (validation && (source.code !== 'INVALID_ARGUMENT' || validation.status !== 'invalid' || localValidationRejection(source))) result.validation = validation
  if (numeric(source.httpStatus) && source.httpStatus >= 100 && source.httpStatus <= 599) result.httpStatus = source.httpStatus
  for (const key of ["providerCode", "providerType"] as const) if (typeof source[key] === "string" && providerNames.test(source[key])) result[key] = source[key]
  if (typeof source.parameter === "string" && parameters.has(source.parameter)) result.parameter = source.parameter
  if (requestId(source.requestId)) result.requestId = source.requestId
  for (const key of ["inputTokens", "contextLimit", "outputLimit"] as const) if (numeric(source[key])) result[key] = source[key]
  return result
}

export function modelFailureFacts(error: unknown): ModelFailureFacts | undefined {
  const chain = errorChain(error)
  const code = retryErrorCode(error)
  if (!code || !canonicalErrorCodes.has(code)) return
  const result: ModelFailureFacts = { code, message: "", reason: code === "CONTEXT_WINDOW_EXCEEDED" ? "context-limit" : "unknown" }
  if (code === 'INVALID_ARGUMENT') {
    for (const source of chain) {
      const local = localValidationRejection(source.modelFailure) ?? localValidationRejection(errorRecord(source.data)?.modelFailure)
      if (local) return safeModelFailureFacts({ code, reason: local.reason, validation: local.report })
    }
  }
  for (const source of chain) {
    const attached = safeModelFailureFacts(source.modelFailure) ?? safeModelFailureFacts(errorRecord(source.data)?.modelFailure)
    if (attached) return safeModelFailureFacts({ ...attached, code })
    const metadata = errorRecord(source.$metadata)
    const status = source.httpStatus ?? metadata?.httpStatusCode
    const parsed = providerFailureFacts(source, code, numeric(status) ? status : undefined)
    if (result.reason === "unknown" && parsed.reason !== "unknown") result.reason = parsed.reason
    for (const key of ["inputTokens", "contextLimit", "outputLimit"] as const) result[key] ??= parsed[key]
    if (numeric(status) && result.httpStatus === undefined) result.httpStatus = status
    if (result.requestId === undefined && requestId(source.requestId ?? metadata?.requestId)) result.requestId = (source.requestId ?? metadata?.requestId) as string
    if (typeof source.code === "string" && providerNames.test(source.code) && normalizedCode(source.code) === code) result.providerCode ??= source.code
    if (typeof source.name === "string" && providerNames.test(source.name)) result.providerType ??= source.name
  }
  return safeModelFailureFacts(result)
}

/** The provider's recognized message is used only to select a reason or parse
 * numeric limits. It is never copied to the facts message. */
export function providerFailureFacts(source: Record<string, unknown>, code: string, httpStatus?: number, id?: string): ModelFailureFacts {
  const message = typeof source.message === "string" ? source.message.slice(0, 8192) : ""
  const reason: ModelFailureFacts["reason"] = code === "CONTEXT_WINDOW_EXCEEDED" ? "context-limit"
    : /^(?:request|payload|body).*(?:too large|size limit)/i.test(message) || source.code === "request_too_large" || httpStatus === 413 ? "request-size"
    : /^(?:max[_ ](?:output[_ ])?tokens|requested output|output tokens).*(?:exceed|limit|maximum)/i.test(message) ? "output-limit"
    : /^invalid (?:json )?schema|^.*?schema validation failed/i.test(message) ? "schema"
    : /^(?:messages? must|invalid message order)/i.test(message) ? "message-order"
    : /^(?:unsupported|unknown|unrecognized) parameter/i.test(message) ? "unsupported-parameter" : "unknown"
  const result: Record<string, unknown> = { code, httpStatus, reason, providerCode: source.code, providerType: source.type ?? source.name, parameter: source.param, requestId: id }
  if (reason === "context-limit" || reason === "output-limit") {
    result.inputTokens = source.input_tokens ?? source.inputTokens
    result.contextLimit = source.context_limit ?? source.contextLimit
    result.outputLimit = source.output_limit ?? source.outputLimit
    const pair = /(?:prompt is too long:\s*|input tokens?[: ]+)(\d+)\s*(?:tokens?\s*)?>\s*(\d+)\s*(?:maximum|max|tokens?)/i.exec(message)
    if (pair) { result.inputTokens ??= Number(pair[1]); result.contextLimit ??= Number(pair[2]) }
    const max = /maximum context length is (\d+) tokens.*?(?:requested|resulted in) (\d+) tokens/i.exec(message)
    if (max) { result.contextLimit ??= Number(max[1]); result.inputTokens ??= Number(max[2]) }
    const gemini = /input token count \((\d+)\) exceeds the maximum number of tokens allowed \((\d+)\)/i.exec(message)
    if (gemini) { result.inputTokens ??= Number(gemini[1]); result.contextLimit ??= Number(gemini[2]) }
    const total = /exceed context limit:\s*(\d+)\s*\+\s*\d+\s*>\s*(\d+)/i.exec(message)
    if (total) { result.inputTokens ??= Number(total[1]); result.contextLimit ??= Number(total[2]) }
    const inputMax = /max input tokens:\s*(\d+)/i.exec(message)
    if (inputMax) result.contextLimit ??= Number(inputMax[1])
  }
  return safeModelFailureFacts(result)!
}
