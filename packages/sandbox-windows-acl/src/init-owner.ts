import koffi from 'koffi'
import { allocBytes, allocPtrSlot, allocUint32, decodePtr, encodeUint32, isNullPtr, isInvalidHandle, throwLastError, throwWin32, type NativePtr, type Win32Bindings } from './ffi.ts'

type Entry = { done: boolean; domain: 'heap' | 'handle' | 'local' | 'control'; value?: NativePtr; scope?: NativeInitOwner; release(): void }
/** Original init owner: reverse dependency order, allocator provenance and retry state. */
export class NativeInitOwner {
  private entries: Entry[] = []
  constructor(readonly api: Win32Bindings) {}
  defer(release: () => void) { const entry = this.own(release); return () => { if (!entry.done) { entry.release(); entry.done = true } } }
  scope() { const scope = new NativeInitOwner(this.api); const entry = this.own(() => scope.cleanup()) as Entry; entry.scope = scope; return scope }
  cleanupScopes() { for (const entry of [...this.entries].reverse()) if (entry.scope && !entry.done) { entry.release(); entry.done = true } }
  private own(release: () => void, value?: NativePtr, domain: Entry['domain'] = 'control') { const entry = { release, value, domain, done: false }; this.entries.push(entry); return entry }
  bytes(size: number) { const value = allocBytes(size); if (isNullPtr(value)) throw new Error('native allocation failed'); this.own(() => koffi.free(value), value, 'heap'); return value }
  slot() { const value = allocPtrSlot(); if (isNullPtr(value)) throw new Error('native allocation failed'); this.own(() => koffi.free(value), value, 'heap'); koffi.encode(value, 'void *', null); return value }
  uint32() { const value = allocUint32(); if (isNullPtr(value)) throw new Error('native allocation failed'); this.own(() => koffi.free(value), value, 'heap'); encodeUint32(value, 0); return value }
  handle(acquire: () => NativePtr, name: string) {
    let known = false
    const entry = this.own(() => { if (!known) throw new Error(`${name} acquisition unresolved`); if (!this.api.closeHandle(entry.value!)) throwLastError(this.api, 'CloseHandle', name) }, undefined, 'handle')
    const value = acquire()
    if (isInvalidHandle(value)) { entry.done = true; throwLastError(this.api, name) }
    entry.value = value; known = true
    return value
  }
  output(slot: NativePtr, kind: 'handle' | 'local', name: string, issue: () => number, statusReturn?: boolean, nullable?: false): NativePtr
  output(slot: NativePtr, kind: 'handle' | 'local', name: string, issue: () => number, statusReturn: boolean, nullable: true): NativePtr | null
  output(slot: NativePtr, kind: 'handle' | 'local', name: string, issue: () => number, statusReturn = false, nullable = false) {
    let state: 'unknown' | 'success' | 'failed' = 'unknown'
    let decoded = false, pointer: NativePtr | null = null
    const entry = this.own(() => {
      if (state === 'failed') return
      const pointer = value()
      if (pointer === null) return
      if (kind === 'handle') { if (!this.api.closeHandle(pointer)) throwLastError(this.api, 'CloseHandle', name) }
      else if (!isNullPtr(this.api.localFree(pointer))) throwLastError(this.api, 'LocalFree', name)
    }, undefined, kind)
    const value = (): NativePtr | null => {
      if (!decoded) { pointer = decodePtr(slot); if (pointer === null && (!nullable || state !== 'success')) throw new Error(`${name} output acquisition unresolved`); entry.value = pointer ?? undefined; decoded = true }
      return pointer
    }
    const result = issue()
    if (statusReturn ? result !== 0 : result === 0) {
      const code = statusReturn ? result : this.api.getLastError()
      state = 'failed'; throwWin32(this.api, name, code)
    }
    state = 'success'
    return value()
  }
  release(value: NativePtr, domain: Entry['domain']) {
    const entry = [...this.entries].reverse().find(entry => !entry.done && entry.value === value && entry.domain === domain)
    if (!entry) throw new Error('resource is not owned')
    entry.release(); entry.done = true
  }
  cleanup(except?: NativePtr) {
    const retained = except === undefined ? undefined : [...this.entries].reverse().find(entry => !entry.done && entry.value === except)
    for (const entry of [...this.entries].reverse()) {
      if (entry.done || entry === retained) continue
      entry.release(); entry.done = true
    }
  }
  transfer(value: NativePtr) { this.cleanup(value); const entry = [...this.entries].reverse().find(entry => !entry.done && entry.value === value); if (entry) entry.done = true }
}
type CleanupOwner = { disposeAsync(): Promise<void> } | { dispose(): void }
export class NativeInitializationFailure extends AggregateError {
  readonly owner!: CleanupOwner
  constructor(primary: unknown, cleanup: unknown, owner: CleanupOwner) { super(primary === cleanup ? [primary] : [primary, cleanup], 'native initialization failed with retained cleanup debt', { cause: primary }); Object.defineProperty(this, 'owner', { value: owner, enumerable: false }) }
  disposeAsync(): Promise<void> {
    if ('disposeAsync' in this.owner) return this.owner.disposeAsync()
    try { this.owner.dispose(); return Promise.resolve() } catch (error) { return Promise.reject(error) }
  }
}
/** Internal acknowledgement: mutation returned; only bookkeeping/cleanup failed. */
export class NativeCleanupFailure extends AggregateError {
  constructor(errors: unknown[], readonly operationCompleted: boolean) { super(errors, 'native operation cleanup incomplete', { cause: errors[0] }) }
}
export function runInitScope<T>(api: Win32Bindings, parent: NativeInitOwner | undefined, action: (scope: NativeInitOwner) => T): T {
  const scope = parent ? parent.scope() : new NativeInitOwner(api)
  let value: T
  try { value = action(scope) } catch (error) {
    try { scope.cleanup() } catch (cleanup) {
      if (!parent) throw new NativeInitializationFailure(error, cleanup, { disposeAsync: async () => scope.cleanup() })
      throw new NativeCleanupFailure(error instanceof NativeCleanupFailure ? [...error.errors, cleanup] : [error, cleanup], error instanceof NativeCleanupFailure && error.operationCompleted)
    }
    throw error
  }
  try { scope.cleanup() } catch (cleanup) {
    if (!parent) throw new NativeInitializationFailure(cleanup, cleanup, { disposeAsync: async () => scope.cleanup() })
    throw new NativeCleanupFailure([cleanup], true)
  }
  return value
}
export function withInitOwner<T extends NativePtr | void>(api: Win32Bindings, supplied: NativeInitOwner | undefined, action: (owner: NativeInitOwner) => T): T {
  const owner = supplied ?? new NativeInitOwner(api)
  try {
    const value = action(owner)
    if (!supplied) { if (value !== undefined) owner.transfer(value); else owner.cleanup() }
    return value
  } catch (error) {
    if (supplied) throw error
    try { owner.cleanup() } catch (cleanup) { throw new NativeInitializationFailure(error, cleanup, { disposeAsync: async () => owner.cleanup() }) }
    throw error
  }
}
