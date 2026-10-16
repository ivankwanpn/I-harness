import type { LLMRequest } from "../index.ts"
import { isModelCapacityError, retryErrorCode } from "./classify.ts"
import { providerFailureFacts } from "./facts.ts"
import { errorRecord, terminalErrorCodes } from "./types.ts"

const ERROR_BODY_BYTES = 8192
async function readErrorBody(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0, text = ""
  try {
    while (bytes < ERROR_BODY_BYTES) {
      const next = await reader.read()
      if (next.done) return text + decoder.decode()
      const remaining = ERROR_BODY_BYTES - bytes
      text += decoder.decode(next.value.subarray(0, remaining), { stream: true })
      bytes += next.value.byteLength
    }
    // Cancellation itself may be asynchronous. The error must not wait for an
    // upstream producer to cooperate after its diagnostic bound is reached.
    void reader.cancel().catch(() => {})
    return text + decoder.decode()
  } finally { reader.releaseLock() }
}

export async function describeHttpError(label: string, response: Response, request?: Pick<LLMRequest, "onTerminalResponse">): Promise<Error> {
  const status = response.status
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    const code = status === 401 || status === 403 ? "AUTH" : status === 402 ? "QUOTA" : "INVALID_ARGUMENT"
    try { request?.onTerminalResponse?.({ code, httpStatus: status }) } catch { /* diagnostic observer */ }
  }
  const body = await readErrorBody(response)
  let source: Record<string, unknown> = {}
  let bodyRequestId: unknown
  try { const parsed = errorRecord(JSON.parse(body)); source = errorRecord(parsed?.error) ?? parsed ?? {}; bodyRequestId = parsed?.request_id ?? source.request_id ?? source.requestId } catch { /* A bounded plain diagnostic may still carry a precise reason. */ }
  const message = typeof source.message === "string" ? source.message : body
  const providerCode = typeof source.code === "string" ? source.code : typeof source.type === "string" ? source.type : typeof source.status === "string" ? source.status : undefined
  const classified = retryErrorCode({ message, code: providerCode, httpStatus: status })
  const capacity = isModelCapacityError({ message, code: providerCode })
  const code = classified && terminalErrorCodes.has(classified) ? classified
    : status >= 400 && status < 500 && status !== 408 && status !== 429 ? "INVALID_ARGUMENT"
    : capacity ? "SERVER" : status === 429 ? "RATE_LIMIT" : status === 408 ? "TIMEOUT" : status >= 500 ? "SERVER" : "INVALID_ARGUMENT"
  const advice = response.headers.get("retry-after")?.trim()
  const now = Date.now()
  const deadline = !advice ? NaN : /^\d+(?:\.\d+)?$/.test(advice) ? now + Number(advice) * 1000 : Date.parse(advice)
  const capacityLimited = capacity && code === "SERVER"
  const modelFailure = providerFailureFacts({ ...source, message, ...(source.code === undefined && providerCode ? { code: providerCode } : {}) }, code, status,
    response.headers.get("request-id") ?? response.headers.get("x-request-id") ?? response.headers.get("x-amzn-requestid") ?? (typeof bodyRequestId === "string" ? bodyRequestId : undefined))
  return Object.assign(new Error(`${label} request failed: ${status}${capacityLimited ? " (model is at capacity)" : ""}`), {
    code, httpStatus: status, modelFailure,
    ...(capacityLimited ? { capacityLimited: true } : {}),
    ...(Number.isFinite(deadline) ? { retryAfterAt: Math.max(now, deadline) } : {}),
  })
}
