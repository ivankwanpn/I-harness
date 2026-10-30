import koffi from 'koffi'
import { allocBytes, allocPtrSlot, allocUint32, decodePtr, encodeUint32, isNullPtr, isInvalidHandle, throwLastError, throwWin32, type NativePtr, type Win32Bindings } from './ffi.ts'

type Entry = { done: boolean; unknown?: boolean; unknownError?: unknown; domain: 'heap' | 'handle' | 'local' | 'control'; value?: NativePtr; scope?: NativeInitOwner; release(): void }
export class NativeReleaseUnknown extends Error {
  readonly outcome = 'unknown'
  constructor(name: string, cause: unknown) { super(`${name} release outcome unknown; original resource remains pinned`, { cause }) }
}
/** Original init owner: reverse dependency order, allocator provenance and retry state. */
export class NativeInitOwner {
  private entries: Entry[] = []
  private retirementRevision = 0
  constructor(readonly api: Win32Bindings) {}
  /** A finite native-use guard; even a failed retirement attempt ends that use. */
  captureCurrent() {
    const revision = this.retirementRevision
    return () => { if (revision !== this.retirementRevision) throw new Error('Native resource owner is retiring') }
  }
  /** Finite borrow of this exact original heap entry, never a reused address. */
  captureHeapCurrent(value: NativePtr) {
    const matches = this.entries.filter(entry => entry.domain === 'heap' && entry.value === value)
    if (matches.length !== 1) throw new Error('original heap allocation is absent or ambiguous after address reuse')
    const entry = matches[0]!
    const current = this.captureCurrent()
    const assert = () => { current(); if (!entry || entry.done || entry.unknown) throw new Error('original heap resource is not live') }
    assert()
    return assert
  }
  /** Register before BOOL initialization; VOID deletion is acknowledged only on return. */
  voidControl(initializeName: string, initialize: () => number, releaseName: string, release: () => void) {
    let state: 'unknown' | 'ready' | 'failed' = 'unknown'
    let failure: unknown = new Error(`${initializeName} outcome unknown`)
    const entry = this.own(() => {
      if (state === 'unknown') throw failure
      if (state === 'failed') return
      this.consume(entry, releaseName, release, result => result === undefined ? 'released' : 'unknown', () => { throw new Error('VOID control cannot report failure status') })
    })
    let result: number
    try { result = initialize() } catch (error) { failure = new Error(`${initializeName} outcome unknown`, { cause: error }); throw failure }
    const ack = boolAck(result)
    if (ack === 'unknown') throw failure
    if (ack === 'not-released') { state = 'failed'; throwLastError(this.api, initializeName) }
    state = 'ready'
    return () => this.retire(entry)
  }
  /** Non-consuming dependency check on original heap storage. The control entry
   * blocks cleanup/transfer; the backing entry also checks direct retirement. */
  retirementGate(value: NativePtr, check: () => void) {
    const backing = this.entries.find(entry => !entry.done && entry.domain === 'heap' && entry.value === value)
    if (!backing) throw new Error('retirement gate backing storage is not owned')
    const release = backing.release
    backing.release = () => { check(); release() }
    this.own(check)
  }
  deferBool(name: string, invoke: () => number, afterSuccess?: () => void) {
    const entry = this.own(() => { this.consume(entry, name, invoke, boolAck, () => throwLastError(this.api, name)); afterSuccess?.() })
    return () => this.retire(entry)
  }
  scope() { const scope = new NativeInitOwner(this.api); const entry = this.own(() => scope.cleanup()) as Entry; entry.scope = scope; return scope }
  cleanupScopes() { for (const entry of [...this.entries].reverse()) if (entry.scope) this.retire(entry) }
  private retire(entry: Entry) {
    if (entry.done) return
    this.retirementRevision++
    if (entry.unknown) throw entry.unknownError
    entry.release()
    entry.done = true
  }
  private consume(entry: Entry, name: string, invoke: () => unknown, classify: (result: unknown) => 'released' | 'not-released' | 'unknown', fail: () => never) {
    // Set before issue. An unclassified exception can occur after consumption.
    entry.unknown = true
    let result: unknown
    try { result = invoke() } catch (error) { entry.unknownError = new NativeReleaseUnknown(name, error); throw entry.unknownError }
    const ack = classify(result)
    if (ack === 'released') { entry.done = true; entry.unknown = false; return }
    if (ack === 'not-released') { entry.unknown = false; fail() }
    entry.unknownError = new NativeReleaseUnknown(name, new Error('invalid native release acknowledgment'))
    throw entry.unknownError
  }
  private heap(value: NativePtr) {
    const entry = this.own(() => this.consume(entry, 'koffi.free', () => koffi.free(value), result => result === undefined ? 'released' : 'unknown', () => { throw new Error('unreachable heap failure status') }), value, 'heap')
    return value
  }
  private own(release: () => void, value?: NativePtr, domain: Entry['domain'] = 'control') { const entry = { release, value, domain, done: false }; this.entries.push(entry); return entry }
  bytes(size: number) { const value = allocBytes(size); if (isNullPtr(value)) throw new Error('native allocation failed'); return this.heap(value) }
  slot() { const value = allocPtrSlot(); if (isNullPtr(value)) throw new Error('native allocation failed'); this.heap(value); koffi.encode(value, 'void *', null); return value }
  uint32() { const value = allocUint32(); if (isNullPtr(value)) throw new Error('native allocation failed'); this.heap(value); encodeUint32(value, 0); return value }
  handle(acquire: () => NativePtr, name: string) {
    let known = false
    const entry = this.own(() => { if (!known) throw new Error(`${name} acquisition unresolved`); this.consume(entry, 'CloseHandle', () => this.api.closeHandle(entry.value!), boolAck, () => throwLastError(this.api, 'CloseHandle', name)) }, undefined, 'handle')
    const value = acquire()
    if (isInvalidHandle(value)) { entry.done = true; throwLastError(this.api, name) }
    entry.value = value; known = true
    return value
  }
  output(slot: NativePtr, kind: 'handle' | 'local', name: string, issue: () => number, statusReturn?: boolean, nullable?: false): NativePtr
  output(slot: NativePtr, kind: 'handle' | 'local', name: string, issue: () => number, statusReturn: boolean, nullable: true): NativePtr | null
  output(slot: NativePtr, kind: 'handle' | 'local', name: string, issue: () => number, statusReturn = false, nullable = false) {
    const current = this.captureCurrent()
    let state: 'unknown' | 'success' | 'failed' = 'unknown'
    let decoded = false, pointer: NativePtr | null = null
    const entry = this.own(() => {
      if (state === 'failed') return
      const pointer = value()
      if (pointer === null) return
      if (kind === 'handle') this.consume(entry, 'CloseHandle', () => this.api.closeHandle(pointer), boolAck, () => throwLastError(this.api, 'CloseHandle', name))
      else this.consume(entry, 'LocalFree', () => this.api.localFree(pointer), result => result === null || result === 0n ? 'released' : result === pointer ? 'not-released' : 'unknown', () => throwLastError(this.api, 'LocalFree', name))
    }, undefined, kind)
    const value = (): NativePtr | null => {
      if (!decoded) { pointer = decodePtr(slot); if (pointer === null && (!nullable || state !== 'success')) throw new Error(`${name} output acquisition unresolved`); entry.value = pointer ?? undefined; decoded = true }
      return pointer
    }
    const result = issue()
    if (statusReturn ? result !== 0 : result === 0) {
      state = 'failed'
      const code = statusReturn ? result : this.api.getLastError()
      throwWin32(this.api, name, code)
    }
    state = 'success'
    // Reentrant retirement can already have retired this entry and its slot.
    // Cleanup still recovers through value() on the original owner; only this
    // initial post-issue native read requires the original finite-use session.
    current()
    return value()
  }
  release(value: NativePtr, domain: Entry['domain']) {
    const entry = [...this.entries].reverse().find(entry => !entry.done && entry.value === value && entry.domain === domain)
    if (!entry) throw new Error('resource is not owned')
    this.retire(entry)
  }
  cleanup(except?: NativePtr) {
    const retained = except === undefined ? undefined : [...this.entries].reverse().find(entry => !entry.done && entry.value === except)
    if (retained?.unknown) throw retained.unknownError
    for (const entry of [...this.entries].reverse()) {
      if (entry.done || entry === retained) continue
      this.retire(entry)
    }
  }
  transfer(value: NativePtr) { this.cleanup(value); const entry = [...this.entries].reverse().find(entry => !entry.done && entry.value === value); if (entry?.unknown) throw entry.unknownError; if (entry) entry.done = true }
}
function boolAck(result: unknown): 'released' | 'not-released' | 'unknown' {
  return typeof result !== 'number' || !Number.isInteger(result) || result < -0x80000000 || result > 0x7fffffff ? 'unknown' : result === 0 ? 'not-released' : 'released'
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
