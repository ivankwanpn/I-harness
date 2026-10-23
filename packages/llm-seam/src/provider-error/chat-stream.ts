import { isModelCapacityError, retryErrorCode } from './classify.ts'
import { providerFailureFacts } from './facts.ts'
import { canonicalErrorCodes } from './types.ts'

/** Chat's explicit SSE failure has no HTTP failure status. Use the same
 * classifier and diagnostic redaction as HTTP, without inventing a status or
 * retaining the provider payload in the Error/cause chain. */
export function describeChatStreamError(value: unknown): Error {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const message = typeof source.message === 'string' ? source.message.slice(0, 8192) : ''
  const providerCode = typeof source.code === 'string' ? source.code.slice(0, 256) : typeof source.type === 'string' ? source.type.slice(0, 256) : undefined
  const malformed = !message.trim() && !providerCode?.trim()
  const classified = malformed ? 'MALFORMED_RESPONSE' : retryErrorCode({ message, code: providerCode })
  const code = classified && canonicalErrorCodes.has(classified) ? classified : 'UNKNOWN'
  const modelFailure = providerFailureFacts({ ...source, message }, code, undefined, typeof source.request_id === 'string' ? source.request_id : undefined)
  return Object.assign(new Error(modelFailure.message), {
    code, modelFailure,
    ...(code === 'SERVER' && isModelCapacityError({ message, code: providerCode }) ? { capacityLimited: true } : {}),
  })
}
