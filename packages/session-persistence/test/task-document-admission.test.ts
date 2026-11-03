import { expect, it } from 'vitest'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'

it('revokes an original retained operation synchronously and joins its cleanup before mutation', async () => {
  const observations = createBindingObservations({ async putDocument() {}, async getDocument() {} }, { lockEnabled: false, async acquireLease() { throw new Error('unused') } })
  const gate = Promise.withResolvers<void>(); let revoked = false, closed = false
  const registration = observations.registerOwnedDocumentOperation('parent', 'task-parent', { revoke() { revoked = true }, async close() { await gate.promise; closed = true }, async retryClose() { await gate.promise; closed = true } })
  const owned = registration.beginOwnedWrite(); owned.finish('settled')
  expect(() => ({ ...registration }).beginOwnedWrite()).toThrow()
  const mutation = observations.beginMutation([], ['task-parent']); expect(revoked).toBe(true)
  let joined = false; const join = mutation.join().then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false); gate.resolve(); await join; expect(closed).toBe(true)
  expect(() => registration.beginOwnedWrite()).toThrow()
  registration.unregister(); mutation.finish()
  expect(() => registration.beginOwnedWrite()).toThrow()
})

it('registers a pre-header ticket before joining an older original task operation', async () => {
  const observations = createBindingObservations({ async putDocument() {}, async getDocument() {} }, { lockEnabled: false, async acquireLease() { throw Error('unused') } })
  const gate = Promise.withResolvers<void>(); let revoked = false, transitionRevoked = false
  const previous = observations.registerOwnedDocumentOperation('p', 'task-p', { revoke() { revoked = true }, async close() { await gate.promise }, async retryClose() { await gate.promise } })
  const transition = observations.beginTaskTransition('p', { revoke() { transitionRevoked = true }, async close() {}, async retryClose() {} })
  expect(revoked).toBe(true)
  expect(() => observations.registerOwnedDocumentOperation('p', 'task-p', { revoke() {}, async close() {}, async retryClose() {} })).toThrow()
  expect(() => observations.beginTaskTransition('p', { revoke() {}, async close() {}, async retryClose() {} })).toThrow()
  let joined = false; const waiting = transition.join().then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false); gate.resolve(); await waiting; previous.unregister()
  transition.assertCurrent()
  const retirement = observations.beginRetirement('p'); expect(transitionRevoked).toBe(true)
  await retirement.join(); expect(() => transition.assertCurrent()).toThrow()
  transition.finish('settled'); retirement.finish()
  expect(() => transition.assertCurrent()).toThrow()
})

it('rejects changed transition callbacks and copied ticket receivers before further admission', async () => {
  const observations = createBindingObservations({ async putDocument() {}, async getDocument() {} }, { lockEnabled: false, async acquireLease() { throw Error('unused') } })
  const owner = { revoke() {}, async close() {}, async retryClose() {} }
  const ticket = observations.beginTaskTransition('p', owner)
  await ticket.join(); expect(() => ticket.assertCurrent.call({})).toThrow()
  const close = owner.close; owner.close = async () => {}; expect(() => ticket.assertCurrent()).toThrow(); owner.close = close
  ticket.assertCurrent(); ticket.finish('settled')
  const next = observations.beginTaskTransition('p', owner); await next.join(); next.finish('settled')
})

it('joins an issued original task writer before admitting the transition lease', async () => {
  const observations = createBindingObservations({ async putDocument() {}, async getDocument() {} }, { lockEnabled: false, async acquireLease() { throw Error('unused') } })
  const gate = Promise.withResolvers<void>(); let revoked = false
  let token: { finish(outcome: 'settled'): void }
  const prior = observations.registerOwnedDocumentOperation('p', 'task-p', { revoke() { revoked = true }, async close() { await gate.promise; token.finish('settled') }, async retryClose() { await gate.promise } })
  token = prior.beginOwnedWrite()
  const transition = observations.beginTaskTransition('p', { revoke() {}, async close() {}, async retryClose() {} })
  expect(revoked).toBe(true); let joined = false; const join = transition.join().then(() => { joined = true })
  await Promise.resolve(); expect(joined).toBe(false); gate.resolve(); await join
  prior.unregister(); transition.assertCurrent(); transition.finish('settled')
})
