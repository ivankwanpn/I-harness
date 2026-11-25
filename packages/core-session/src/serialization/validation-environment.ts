import { Buffer as NodeBuffer } from 'node:buffer'
import { TextEncoder as NodeTextEncoder, types } from 'node:util'

const { parse: originalParse, stringify: originalStringify } = JSON
const originalObjectPrototype = Object.prototype, originalArrayPrototype = Array.prototype
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
