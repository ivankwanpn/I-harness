/** A route-owned observation of final output controls, independent of request
 * validation, provider capacity, execution permission and checkpoint quality. */
export type PreparedTextOutput =
  | Readonly<{ status: 'allowed'; reason: 'ordinary-text' }>
  | Readonly<{ status: 'blocked'; reason: 'structured-output' | 'forced-tool' }>
  | Readonly<{ status: 'unknown'; reason: 'unsupported-output-options' | 'not-declared' | 'invalid-declaration' }>

const unknown = (reason: 'not-declared' | 'invalid-declaration'): PreparedTextOutput => Object.freeze({ status: 'unknown', reason })
/** Never evaluate caller-controlled accessors or retain raw declaration data. */
export function normalizePreparedTextOutput(value: unknown): PreparedTextOutput {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown('invalid-declaration')
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 2 || !keys.includes('status') || !keys.includes('reason')) return unknown('invalid-declaration')
    const status = Object.getOwnPropertyDescriptor(value, 'status'), reason = Object.getOwnPropertyDescriptor(value, 'reason')
    if (!status || !reason || !('value' in status) || !('value' in reason)) return unknown('invalid-declaration')
    const valid = status.value === 'allowed' && reason.value === 'ordinary-text'
      || status.value === 'blocked' && ['structured-output', 'forced-tool'].includes(reason.value)
      || status.value === 'unknown' && ['unsupported-output-options', 'not-declared', 'invalid-declaration'].includes(reason.value)
    return valid ? Object.freeze({ status: status.value, reason: reason.value }) as PreparedTextOutput : unknown('invalid-declaration')
  } catch { return unknown('invalid-declaration') }
}
export function readPreparedTextOutput(prepared: { readonly textOutput?: PreparedTextOutput }): PreparedTextOutput {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prepared, 'textOutput')
    if (!descriptor) return 'textOutput' in prepared ? unknown('invalid-declaration') : unknown('not-declared')
    if ('value' in descriptor && descriptor.value === undefined) return unknown('not-declared')
    return 'value' in descriptor ? normalizePreparedTextOutput(descriptor.value) : unknown('invalid-declaration')
  } catch { return unknown('invalid-declaration') }
}
