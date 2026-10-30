import { isAbsolute } from 'node:path'
import koffi from 'koffi'
import type { NativePtr } from './ffi.ts'

let retirementTail: Promise<unknown> = Promise.resolve()

/** Shared bounded worker admission; always leave the native callback stack first. */
export function queueWaitDrain<T>(call: () => Promise<T>): Promise<T> {
  const result = retirementTail.then(() => new Promise<void>(resolve => setImmediate(resolve))).then(call)
  retirementTail = result.catch(() => {})
  return result
}

export function validateBridgePath(path: string, platform = process.platform, arch = process.arch): void {
  if (platform !== 'win32') throw new Error('ACL wait bridge requires Windows')
  if (arch !== 'x64') throw new Error('ACL wait bridge requires x64')
  if (!isAbsolute(path)) throw new Error('ACL wait bridge path must be absolute')
}

/** Loads only the caller-selected asset; the caller owns its provenance. */
export function loadWaitDrainBridge(path: string): (registration: NativePtr) => Promise<number> {
  validateBridgePath(path)
  const library = koffi.load(path)
  const call = library.func('__stdcall', 'ih_acl_unregister_wait_and_drain', 'uint32', ['void *'])
  return registration => queueWaitDrain(() => new Promise<number>((resolve, reject) => {
    call.async(registration, (error: Error | null, result: number) => {
      if (error) reject(error)
      else resolve(result)
    })
  }))
}
