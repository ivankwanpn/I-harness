import { expect, it } from 'vitest'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'

it('revokes an original retained operation synchronously and joins its cleanup before mutation', async () => {
  const observations = createBindingObservations({ async putDocument() {}, async getDocument() {} }, { lockEnabled: false, async acquireLease() { throw new Error('unused') } })
  const gate = Promise.withResolvers<void>(); let revoked = false, closed = false
  const registration = observations.registerOwnedDocumentOperation('parent', 'task-parent', { revoke() { revoked = true }, async close() { await gate.promise; closed = true }, async retryClose() { await gate.promise; closed = true } })
  const owned = registration.beginOwnedWrite(); owned.finish()
  expect(() => ({ ...registration }).beginOwnedWrite()).toThrow()
  const mutation = observations.beginMutation([], ['task-parent']); expect(revoked).toBe(true)
  let joined = false; const join = mutation.join().then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false); gate.resolve(); await join; expect(closed).toBe(true)
  expect(() => registration.beginOwnedWrite()).toThrow()
  registration.unregister(); mutation.finish()
  expect(() => registration.beginOwnedWrite()).toThrow()
})
