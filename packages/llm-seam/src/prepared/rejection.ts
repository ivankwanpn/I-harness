import { coherentRejection, createPreparedValidation, readPreparedValidation, type FinalRejectionReason, type PreparedValidation } from './validation.ts'
import type { PreparedModelRequest } from './types.ts'

export function finalValidationError(reason: FinalRejectionReason, validation: PreparedValidation): Error {
  if (!coherentRejection(reason, validation)) throw new TypeError('Invalid final rejection contract')
  return Object.assign(new Error(`Model request rejected locally: ${reason}`), { code: 'INVALID_ARGUMENT', legacyErrorEvent: true, modelFailure: { code: 'INVALID_ARGUMENT', reason, validation } })
}
export function assertPreparedValidation(prepared: Pick<PreparedModelRequest, 'validation' | 'measurement'>): void {
  const report = readPreparedValidation(prepared)
  if (report.status !== 'invalid') return
  const reasons: FinalRejectionReason[] = ['binding', 'message-order', 'native-replay', 'unsupported-parameter', 'output-limit', 'media-limit', 'schema']
  throw finalValidationError(reasons.find(reason => coherentRejection(reason, report))!, report)
}
export function preparedBindingError(prepared: Pick<PreparedModelRequest, 'validation' | 'measurement'>): Error {
  const original = readPreparedValidation(prepared)
  const report = createPreparedValidation({ ...original, status: 'invalid', issues: [{ rule: 'binding', site: 'model' }], omittedIssueCount: 0 })
  return finalValidationError('binding', report)
}
