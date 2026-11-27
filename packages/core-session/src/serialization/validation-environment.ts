import { Buffer as NodeBuffer } from 'node:buffer'
import { TextEncoder as NodeTextEncoder, types } from 'node:util'

const { parse: originalParse, stringify: originalStringify } = JSON
const originalObjectPrototype = Object.prototype, originalArrayPrototype = Array.prototype
const originalDataPrototypes = [originalObjectPrototype, originalArrayPrototype].map(prototype => {
  const keys = Reflect.ownKeys(prototype)
  return { prototype, keys, fields: keys.map(key => Object.getOwnPropertyDescriptor(prototype, key)!) }
})
const originalTextEncoderPrototype = NodeTextEncoder.prototype
const originalGlobalBuffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
const originalUtf8Encode = ownMethod(originalTextEncoderPrototype, 'encode')
const originalByteLength = ownMethod(NodeBuffer, 'byteLength')
const originalBufferFrom = ownMethod(NodeBuffer, 'from')
const originalBufferCompare = ownMethod(NodeBuffer, 'compare')

function ownMethod(receiver: object, key: string) {
  const value: unknown = Object.getOwnPropertyDescriptor(receiver, key)?.value
  return typeof value === 'function' && !types.isProxy(value) ? value : undefined
}

export function unchangedDataPrototypes(): boolean {
  // Freezing own fields does not freeze inherited optional fields or methods.
  // A custom prototype keeps the original repeat validation behavior.
  for (let index = 0; index < originalDataPrototypes.length; index++) {
    const { prototype, keys, fields } = originalDataPrototypes[index]!
    if (Reflect.ownKeys(prototype).length !== keys.length) return false
    for (let position = 0; position < keys.length; position++) {
      const expected = fields[position]!, actual = Object.getOwnPropertyDescriptor(prototype, keys[position]!)
      if (!actual || actual.configurable !== expected.configurable || actual.enumerable !== expected.enumerable) return false
      if (Object.hasOwn(expected, 'value')) {
        if (!Object.hasOwn(actual, 'value') || !Object.is(actual.value, expected.value) || actual.writable !== expected.writable) return false
      } else if (prototype !== originalObjectPrototype || keys[position] !== '__proto__'
        || !Object.hasOwn(actual, 'get') || actual.get !== expected.get || actual.set !== expected.set) return false
    }
  }
  return true
}

/** A comparison of the native encoding operations used by history validation. */
export function isOriginalArchiveValidationEnvironment() {
  const buffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
  // Node's lazy accessor can still be installed after its value was replaced.
  const originalBuffer = buffer?.value === NodeBuffer || (buffer?.get !== undefined && buffer.get === originalGlobalBuffer?.get
    && buffer.set === originalGlobalBuffer?.set && !types.isProxy(buffer.get) && Reflect.apply(buffer.get, globalThis, []) === NodeBuffer)
  return Object.getOwnPropertyDescriptor(JSON, 'parse')?.value === originalParse
    && Object.getOwnPropertyDescriptor(JSON, 'stringify')?.value === originalStringify
    && originalUtf8Encode !== undefined && Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder')?.value === NodeTextEncoder
    && Object.getOwnPropertyDescriptor(originalTextEncoderPrototype, 'encode')?.value === originalUtf8Encode
    && originalBuffer && originalByteLength !== undefined && Object.getOwnPropertyDescriptor(NodeBuffer, 'byteLength')?.value === originalByteLength
    && originalBufferFrom !== undefined && Object.getOwnPropertyDescriptor(NodeBuffer, 'from')?.value === originalBufferFrom
    && originalBufferCompare !== undefined && Object.getOwnPropertyDescriptor(NodeBuffer, 'compare')?.value === originalBufferCompare
    && Object.getPrototypeOf(originalObjectPrototype) === null
    && Object.getPrototypeOf(originalArrayPrototype) === originalObjectPrototype
    && !Object.hasOwn(originalObjectPrototype, 'toJSON') && !Object.hasOwn(originalArrayPrototype, 'toJSON')
}
