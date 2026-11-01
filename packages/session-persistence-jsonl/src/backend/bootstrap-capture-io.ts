import { open, type FileHandle } from 'node:fs/promises'
import { isHeldFactOwner, type HeldFactOwner } from '@i-harness/session-persistence'

export type CaptureResource = { handle: FileHandle; error?: unknown; consumed?: boolean; closing?: Promise<void> }
export type CaptureLedger = { id: string; owner: HeldFactOwner['owner']; pending: Set<Promise<unknown>>; handles: Set<CaptureResource>; settled: boolean; diagnostics: unknown[] }

/** One instance per backend. Capture, headers and selected journals retain the
 * same original resources until successful disposal, including failed closes. */
export function createBootstrapCaptureIO() {
  const ledgers = new WeakMap<object, CaptureLedger>()
  function scope(id: string, owner: HeldFactOwner) {
    if (!isHeldFactOwner(owner) || owner.owner.sessionId !== id) throw new TypeError('Invalid capture IO owner')
    owner.assertHeld()
  }
  function assertNoCleanupDebt(ledger: CaptureLedger) {
    const debt = [...ledger.handles].find(resource => Object.hasOwn(resource, 'error'))
    if (debt) throw debt.error
  }
  function tracked<T>(id: string, owner: HeldFactOwner, work: (ledger: CaptureLedger) => Promise<T>): Promise<T> {
    scope(id, owner)
    let ledger = ledgers.get(owner.owner)
    if (!ledger) { ledger = { id, owner: owner.owner, pending: new Set(), handles: new Set(), settled: false, diagnostics: [] }; ledgers.set(owner.owner, ledger) }
    assertNoCleanupDebt(ledger)
    ledger.settled = false
    const actual = ledger, flight = Promise.resolve().then(() => work(actual))
    actual.pending.add(flight)
    void flight.finally(() => actual.pending.delete(flight)).catch(() => {})
    return flight
  }
  async function acquire(ledger: CaptureLedger, path: string, flags: string): Promise<CaptureResource> {
    const handle = await open(path, flags)
    const resource: CaptureResource = { handle }; ledger.handles.add(resource)
    return resource
  }
  async function close(ledger: CaptureLedger, resource: CaptureResource): Promise<void> {
    if (!ledger.handles.has(resource)) return
    if (resource.closing) return resource.closing
    if (resource.consumed) throw resource.error
    const flight = (async () => {
      try { await resource.handle.close(); ledger.handles.delete(resource); delete resource.error }
      catch (error) { resource.error = error; resource.consumed = resource.handle.fd < 0; throw error }
    })()
    resource.closing = flight
    try { await flight } finally { if (resource.closing === flight) resource.closing = undefined }
  }
  async function bytes(ledger: CaptureLedger, path: string, limit: number, guard: () => void): Promise<Buffer | undefined> {
    let resource: CaptureResource
    try { resource = await acquire(ledger, path, 'r') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    try {
      guard(); if ((await resource.handle.stat()).size > limit) throw new Error('Capture stage exceeds limit')
      guard(); const value = await resource.handle.readFile(); guard()
      if (value.length > limit) throw new Error('Capture stage exceeds limit')
      return value
    } finally { await close(ledger, resource) }
  }
  async function settleBootstrapCaptureIO(id: string, owner: HeldFactOwner) {
    scope(id, owner)
    const ledger = ledgers.get(owner.owner)
    if (!ledger || ledger.id !== id) throw new TypeError('Original capture IO owner required')
    while (ledger.pending.size) await Promise.allSettled([...ledger.pending])
    const results = await Promise.allSettled([...ledger.handles].map(resource => close(ledger, resource)))
    scope(id, owner)
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Original capture IO cleanup unresolved')
    ledger.settled = true
  }
  return { scope, tracked, acquire, close, bytes, assertNoCleanupDebt, settleBootstrapCaptureIO }
}
export type BootstrapCaptureIO = ReturnType<typeof createBootstrapCaptureIO>
