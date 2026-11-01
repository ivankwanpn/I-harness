import { expect, it } from 'vitest'
import { createDocuments } from '../src/coordinator/documents.ts'
it.each([false, undefined])('retains artifact pin behind consuming temporary lease failure %s', async cause => {
  let held = true, leaseCalls = 0, pinCalls = 0
  const docs = createDocuments({ async putDocument() {}, async getDocument() {} }, {
    lockEnabled: true,
    async acquireLease() { throw Error('raw lease bypass') },
    async pinDocumentOwnership() { return { assertHeld() {}, retainLive() {}, async release() { pinCalls++ } } },
    async acquireDocumentLease() { return { get held() { return held }, async release() { leaseCalls++; if (!held) return; held = false; throw cause } } },
  }, () => {})
  await expect(docs.putDocumentStrict('key', {})).rejects.toBeInstanceOf(AggregateError)
  expect(pinCalls).toBe(0)
  await expect(docs.retryDisposals()).rejects.toBeInstanceOf(AggregateError)
  expect(pinCalls).toBe(0); expect(leaseCalls).toBe(1)
})
it('retries earliest nonconsuming lease failure before releasing the original artifact pin', async () => {
  const events: string[] = []; let fail = true
  const docs = createDocuments({ async putDocument() { events.push('write') }, async getDocument() {} }, {
    lockEnabled: true, async acquireLease() { throw Error('raw lease bypass') },
    async pinDocumentOwnership() { return { assertHeld() {}, retainLive() {}, async release() { events.push('pin') } } },
    async acquireDocumentLease() { return { held: true, async release() { events.push('lease'); if (fail) throw undefined } } },
  }, () => {})
  await expect(docs.putDocumentStrict('key', {})).rejects.toBeInstanceOf(AggregateError)
  expect(events).toEqual(['write','lease']); fail = false; await docs.retryDisposals()
  expect(events).toEqual(['write','lease','lease','pin'])
})
