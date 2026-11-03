import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { canonicalJsonData } from '../serialization/json-data.ts'

/** Complete current floor, never a conversation input or acceptance. */
export interface RuntimeContextRecordV1 {
  type: 'runtime/context'
  version: 1
  sections: readonly { name: string; text: string }[]
  seq?: number
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields)
  return required.every(key => Object.hasOwn(fields, key)) && keys.every(key => typeof key === 'string'
    && (required.includes(key) || optional.includes(key)) && fields[key]!.enumerable && 'value' in fields[key]!)
}
export function validRuntimeContextRecord(value: unknown): value is RuntimeContextRecordV1 {
  try {
    if (!record(value, ['type', 'version', 'sections'], ['seq']) || value.type !== 'runtime/context' || value.version !== 1
      || Object.hasOwn(value, 'seq') && !(typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq >= 0)) return false
    const sections = value.sections
    if (!Array.isArray(sections) || types.isProxy(sections) || Object.getPrototypeOf(sections) !== Array.prototype || sections.length > 64
      || Reflect.ownKeys(sections).length !== sections.length + 1) return false
    const names = new Set<string>()
    for (let index = 0; index < sections.length; index++) {
      const field = Object.getOwnPropertyDescriptor(sections, String(index))
      if (!field?.enumerable || !('value' in field)) return false
      const section = field.value
      if (!record(section, ['name', 'text']) || typeof section.name !== 'string' || !section.name.length
        || Buffer.byteLength(section.name) > 128 || typeof section.text !== 'string' || names.has(section.name)) return false
      names.add(section.name)
    }
    return true
  } catch { return false }
}
export function validateRuntimeContextRecord(value: unknown, formatVersion: number): void {
  if (formatVersion < 12 || !validRuntimeContextRecord(value)) throw new TypeError('Invalid runtime/context record or format')
}
/** Locate the discriminant without invoking an accessor. Legacy empty records
 * retain their existing reader behavior; an inherited runtime tag still must
 * pass the closed record's own-property contract. */
export function validateRuntimeContextDiscriminant(value: object, formatVersion: number): void {
  for (let object: object | null = value; object; object = Object.getPrototypeOf(object)) {
    const field = Object.getOwnPropertyDescriptor(object, 'type')
    if (!field) continue
    if (!('value' in field)) throw new TypeError('Invalid event discriminant')
    if (field.value === 'runtime/context') validateRuntimeContextRecord(value, formatVersion)
    return
  }
}
export function runtimeContextDigest(sections: RuntimeContextRecordV1['sections']): string {
  return createHash('sha256').update('ih.runtime-context.v1\0').update(canonicalJsonData(sections)).digest('hex')
}
export function renderRuntimeContext(sections: RuntimeContextRecordV1['sections']): string {
  return sections.map(section => `## ${section.name}\n\n${section.text}`).join('\n\n')
}
