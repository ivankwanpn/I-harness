import { expect, it } from 'vitest'
import { createSession, createNondurableFactOwner } from '../src/index.ts'

const terminal = { type: 'context/recovery' as const, version: 1 as const, ownerSessionId: 'owner', recoveryId: 'original', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), state: 'blocked' as const, retryConsumed: true }

it('captures terminal recovery before Stop and settles immutable original data after Stop', async () => {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction()
  const source = action.registerSettlementSource(async () => {})
  const draft = { ...terminal }, capture = source.recovery.capture(draft)
  draft.recoveryId = 'mutated'
  action.stop()
  expect(await action.facts.metadata.admit(terminal)).toMatchObject({ kind: 'not-issued', code: 'FACT_CANCELLED' })
  expect(await capture.admit()).toMatchObject({ kind: 'memory-committed' })
  expect(session.events.at(-1)).toMatchObject({ recoveryId: 'original', state: 'blocked' })
  expect(await source.recovery.capture({ ...terminal, state: 'resolved' }).admit()).toMatchObject({ kind: 'memory-committed' })
  await source.close()
  expect(() => source.recovery.capture(terminal)).toThrow('FACT_CLOSED')
})

it('rejects nonterminal, envelope, executable and extra recovery drafts without invoking getters', async () => {
  const action = createNondurableFactOwner(createSession()).beginAction(), source = action.registerSettlementSource(async () => {})
  let reads = 0
  const accessor = Object.defineProperty({ ...terminal }, 'reason', { enumerable: true, get() { reads++; return 'unsafe' } })
  const opaque = Object.assign(new (class {})(), terminal)
  for (const draft of [{ ...terminal, state: 'required' }, { ...terminal, state: 'retry-started' }, { ...terminal, type: 'context/budget' }, { ...terminal, seq: 1 }, { ...terminal, ignorable: true }, { ...terminal, envelope: {} }, { ...terminal, extra: true }, accessor, opaque, new Proxy(terminal, {})]) {
    expect(await source.recovery.capture(draft as never).admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  }
  expect(reads).toBe(0)
  await source.close()
})
