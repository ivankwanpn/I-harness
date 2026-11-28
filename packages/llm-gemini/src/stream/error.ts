import { modelFailureFacts, safeModelFailureFacts } from '@i-harness/llm-seam'

// Google REST errors carry an HTTP-equivalent numeric code and a named RPC
// status in the body. Neither field changes the actual 200 streaming response.
const byStatus = new Map<string,string>([
  ['INVALID_ARGUMENT','INVALID_ARGUMENT'], ['FAILED_PRECONDITION','INVALID_ARGUMENT'], ['NOT_FOUND','INVALID_ARGUMENT'],
  ['UNAUTHENTICATED','AUTH'], ['PERMISSION_DENIED','AUTH'], ['RESOURCE_EXHAUSTED','RATE_LIMIT'],
  ['CANCELLED','ABORTED'], ['INTERNAL','SERVER'], ['UNAVAILABLE','SERVER'], ['DEADLINE_EXCEEDED','TIMEOUT'],
])
function numericFailure(code: number): string | undefined {
  if (code === 401 || code === 403) return 'AUTH'
  if (code === 402) return 'QUOTA'
  if (code === 408 || code === 504) return 'TIMEOUT'
  if (code === 429) return 'RATE_LIMIT'
  if (code === 499) return 'ABORTED'
  if (code >= 500 && code < 600) return 'SERVER'
  if (code >= 400 && code < 500) return 'INVALID_ARGUMENT'
}

export function geminiStreamError(value: unknown): Error {
  const error = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}
  const status = typeof error.status === 'string' && error.status.length <= 64 ? error.status : undefined
  const numeric = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? numericFailure(error.code) : undefined
  const message = typeof error.message === 'string' ? error.message.slice(0,8192) : ''
  const code = numeric === 'AUTH' || numeric === 'QUOTA' ? numeric : (status && byStatus.get(status)) || numeric ||
    (status || message.trim() ? 'UNKNOWN' : 'MALFORMED_RESPONSE')
  // The shared classifier extracts recognised overflow bounds from an
  // INVALID_ARGUMENT diagnostic. Only its redacted scalar facts leave here.
  const facts = safeModelFailureFacts({ ...modelFailureFacts({code,message}), providerCode:status })!
  return Object.assign(new Error(facts.message), {code:facts.code, modelFailure:facts})
}
