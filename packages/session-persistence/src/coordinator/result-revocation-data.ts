import { types } from 'node:util'

/** Capture request data without invoking caller getters; it grants no authority. */
export function captureResultTargetIds(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || types.isProxy(input)) throw TypeError('Original target array required')
  const values: string[] = []
  for (let index = 0; index < input.length; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index))
    if (!field || !('value' in field) || typeof field.value !== 'string' || !field.value) throw TypeError('Original target data required')
    values.push(field.value)
  }
  return Object.freeze([...new Set(values)].sort())
}
