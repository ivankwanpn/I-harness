import { expect, it } from 'vitest'
import { createSession, createNondurableFactOwner, type AcceptedDraft } from '../src/index.ts'

const accepted = (): AcceptedDraft => ({ type: 'model/exchange-accepted', version: 1, exchangeId: 'original-exchange', actionId: 'action', attemptId: 'attempt',
  stepStartSeq: { kind: 'prior', seq: 1, expectedType: 'step/start' }, assistantSeq: { kind: 'group', position: 0, expectedType: 'assistant/message' }, callSeqs: [] })
async function setup(observer?: Parameters<typeof createSession>[0]) {
  const session = createSession(observer), action = createNondurableFactOwner(session).beginAction()
  await action.facts.agent.lifecycle({ type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  await action.facts.agent.lifecycle({ type: 'step/start', actionId: 'action', attemptId: 'attempt' })
  return { session, action }
}

it('captures the same closed acceptance group as ordinary accept and freezes its original payload', async () => {
  const captured = await setup(), raw = await setup(), assistant = { type: 'assistant/message' as const, text: 'original' }, draft = accepted()
  const original = captured.action.captureModelExchange(assistant, draft)
  assistant.text = 'changed'; draft.exchangeId = 'changed'
  expect(await original.admit()).toMatchObject({ kind: 'memory-committed', durability: 'nondurable', seqs: [2, 3] })
  await raw.action.facts.agent.accept({ type: 'assistant/message', text: 'original' }, accepted())
  expect(captured.session.events).toEqual(raw.session.events)
  captured.action.stop()
  expect(await original.observe()).toMatchObject({ kind: 'memory-committed', seqs: [2, 3] })
  expect(await original.reconcile()).toMatchObject({ kind: 'memory-committed', seqs: [2, 3] })
  expect(captured.session.events).toHaveLength(4)
  captured.action.finish(); raw.action.finish()
})

it('cannot issue a captured acceptance initially canceled by Stop or by reconcile afterward', async () => {
  const f = await setup(), original = f.action.captureModelExchange({ type: 'assistant/message', text: 'never accepted' }, accepted())
  f.action.stop()
  expect(await original.admit()).toEqual({ kind: 'not-issued', code: 'FACT_CANCELLED' })
  expect(await original.observe()).toEqual({ kind: 'not-issued', code: 'FACT_CANCELLED' })
  expect(await original.reconcile()).toEqual({ kind: 'not-issued', code: 'FACT_CANCELLED' })
  expect(f.session.events).toHaveLength(2)
  f.action.finish()
})

it('rejects executable acceptance fields without invoking their getter', async () => {
  const f = await setup(); let reads = 0
  const unsafe = Object.defineProperty(accepted(), 'exchangeId', { enumerable: true, get() { reads++; return 'unsafe' } })
  const original = f.action.captureModelExchange({ type: 'assistant/message', text: 'rejected' }, unsafe)
  expect(await original.admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  expect(reads).toBe(0); expect(f.session.events).toHaveLength(2)
  f.action.finish()
})

it('retains actual nondurable installation when the original append observer throws', async () => {
  const failure = Error('original acceptance observer failure')
  const f = await setup(event => { if (event.type === 'model/exchange-accepted') throw failure })
  const original = f.action.captureModelExchange({ type: 'assistant/message', text: 'installed locally' }, accepted())
  await expect(original.admit()).rejects.toBe(failure)
  f.action.stop()
  expect(await original.observe()).toEqual({ kind: 'memory-committed', durability: 'nondurable', seqs: [2, 3] })
  expect(await original.reconcile()).toEqual({ kind: 'memory-committed', durability: 'nondurable', seqs: [2, 3] })
  expect(f.session.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
  f.action.finish()
})

it.each(['generation-getter', 'accepted-proxy'] as const)('rejects %s before the shared group constructor inspects executable fields', async selected => {
  const f = await setup(); let reads = 0
  const generation = Object.defineProperty({ type: 'context/action', version: 1, op: 'accepted', ownerSessionId: 'owner', actionId: 'generation', executionDomain: 'physical', attemptId: 'physical', sendId: 'send' }, 'trustedAt', { enumerable: true, get() { reads++; return 1 } })
  const proxy = new Proxy(accepted(), { ownKeys(target) { reads++; return Reflect.ownKeys(target) } })
  const original = f.action.captureModelExchange({ type: 'assistant/message', text: 'rejected' }, selected === 'accepted-proxy' ? proxy : accepted(), selected === 'generation-getter' ? generation as never : undefined)
  expect(reads).toBe(0)
  expect(await original.admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  expect(f.session.events).toHaveLength(2)
  f.action.finish()
})
