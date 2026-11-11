import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { decodeFactBatch } from '@i-harness/core-session'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'

it.each(['unknown', 'throw-after-commit', 'admit-throw-after-commit', 'reentrant', 'committed', 'absent', 'FACT_PRECONDITION_STALE', 'FACT_INVALID_GROUP', 'FACT_CLOSED'] as const)('retains the real required original close receipt for %s', async mode => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'receipt-'))
  let armed = false, closeAppends = 0, physicalCloseCommits = 0, afterCommitThrows = 0, nativeCloseReconciles = 0
  const backend = createJsonlBackend(root, { wrapOwnedBatch: original => async (...args) => {
    const close = armed && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/action' && event.op === 'close')
    if (!close) return original(...args)
    closeAppends++
    if (mode.startsWith('FACT_')) return { kind: 'not-issued', code: mode as 'FACT_CLOSED' }
    if (mode === 'absent') return { kind: 'absent', key: args[3].key }
    const committed = await original(...args)
    if (committed.kind === 'committed') physicalCloseCommits++
    if (mode === 'throw-after-commit') { afterCommitThrows++; throw new Error('original append committed before transport threw') }
    return mode === 'unknown' ? { kind: 'unknown', key: args[3].key } : committed
  }, wrapOwnedReconcile: original => async (...args) => {
    if (armed && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/action' && event.op === 'close')) nativeCloseReconciles++
    return original(...args)
  } }), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
  const document = await coordinator.openManagedDocument('child')
  await document.delivery.record({ type: 'subagent/inbox', messageId: 'saved', message: 'original', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const action = document.beginAction(), register = action.registerSettlementSource.bind(action)
  let captures = 0, admits = 0, reconciles = 0, observes = 0
  let retained: import('@i-harness/core-session').CapturedActionFact<import('@i-harness/core-session').ProducerFactOutcome> | undefined
  action.registerSettlementSource = (...args) => {
    const source = register(...args), capture = source.generation.capture.bind(source.generation)
    source.generation.capture = event => {
      const original = capture(event)
      if (event.type === 'context/action' && event.op === 'close') {
        captures++; retained = original
        const admit = original.admit.bind(original), reconcile = original.reconcile.bind(original), observe = original.observe.bind(original)
        original.admit = async function () {
          expect(this).toBe(original); admits++
          if (mode === 'reentrant') {
            await expect(generation.close('stopped')).rejects.toMatchObject({ code: 'GENERATION_UNCERTAIN' })
            await expect(generation.recoverClose!()).rejects.toMatchObject({ code: 'GENERATION_UNCERTAIN' })
          }
          const result = await admit(); if (mode === 'admit-throw-after-commit') throw undefined; return result
        }
        original.reconcile = function () { expect(this).toBe(original); reconciles++; return reconcile() }
        original.observe = function () { expect(this).toBe(original); observes++; return observe() }
      }
      return original
    }
    return source
  }
  const lifecycle = createGenerationLifecycle(document.view, 'child', action)
  const generation = await lifecycle.open('main', { kind: 'delegated-input', ref: 'inbox', seq: 0, messageId: 'saved' })
  expect(generation.originalCloseInvoked!()).toBe(false)
  await expect(generation.recoverClose!()).rejects.toMatchObject({ code: 'GENERATION_UNCERTAIN' })
  expect(captures).toBe(0)
  armed = true
  const first = await Promise.allSettled([generation.close('failed'), generation.close('stopped')])
  expect(captures).toBe(1); expect(admits).toBe(1); expect(generation.originalCloseInvoked!()).toBe(true)
  // A thrown backend ACK is reconciled against the original physical journal
  // by managed-document before admission resolves. It does not replay append.
  expect(first[0]!.status).toBe(mode === 'committed' || mode === 'reentrant' || mode === 'throw-after-commit' ? 'fulfilled' : 'rejected')
  if (mode === 'throw-after-commit') {
    expect([afterCommitThrows, closeAppends, physicalCloseCommits, nativeCloseReconciles]).toEqual([1, 1, 1, 1])
  }
  expect(first[1]!.status).toBe(first[0]!.status)
  // Replacing aliases cannot redirect recovery away from the original receiver.
  retained!.admit = retained!.observe = retained!.reconcile = async () => { throw Error('replacement alias') }
  const terminal = mode === 'absent' || mode.startsWith('FACT_')
  if (terminal) {
    await expect(generation.recoverClose!()).rejects.toBeDefined()
    await expect(generation.recoverClose!()).rejects.toBeDefined()
    expect(reconciles).toBe(0); expect(admits).toBe(1)
    // The real registered source remains held; this is expected refusal debt.
    await expect(lifecycle.drain()).rejects.toBeDefined()
    action.finish()
    await expect(coordinator.close()).rejects.toBeDefined()
  } else {
    await generation.recoverClose!()
    expect(reconciles).toBe(mode === 'committed' || mode === 'reentrant' || mode === 'throw-after-commit' || mode === 'admit-throw-after-commit' ? 0 : 1)
    expect(observes).toBe(mode === 'admit-throw-after-commit' ? 1 : 0)
    expect(captures).toBe(1); expect(admits).toBe(1)
    expect(document.view.events.filter(event => event.type === 'context/action' && event.op === 'close')).toHaveLength(1)
    await lifecycle.drain(); action.finish(); await coordinator.close()
  }
  console.info('original-required-close-receipt', JSON.stringify({ mode, captures, admits, reconciles, observes, terminal }))
})

it.each([undefined, null, false, 0, ''])('retains capture construction failure %s without recapture or clock renewal', async failure => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'capture-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
  const document = await coordinator.openManagedDocument('child')
  await document.delivery.record({ type: 'subagent/inbox', messageId: 'saved', message: 'original', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const action = document.beginAction(), register = action.registerSettlementSource.bind(action)
  let captures = 0
  action.registerSettlementSource = (...input) => {
    const source = register(...input), capture = source.generation.capture.bind(source.generation)
    source.generation.capture = event => { if (event.type === 'context/action' && event.op === 'close') { captures++; throw failure }; return capture(event) }
    return source
  }
  const lifecycle = createGenerationLifecycle(document.view, 'child', action), generation = await lifecycle.open('main', { kind: 'delegated-input', ref: 'inbox', seq: 0, messageId: 'saved' })
  await expect(generation.close('failed')).rejects.toBe(failure)
  await expect(generation.close('stopped')).rejects.toBe(failure)
  await expect(generation.recoverClose!()).rejects.toBe(failure)
  expect(captures).toBe(1)
  expect(() => generation.assertOpen()).toThrow()
  await lifecycle.drain(); action.finish(); await coordinator.close()
})

it('recovers the same real required nonissued close after Stop while ordinary aliases retain rejection', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'close-'))
  const drafts: unknown[] = []
  let blocked = true, armed = false
  const backend = createJsonlBackend(root, { wrapOwnedBatch: original => async (...args) => {
    if (armed && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/action' && event.op === 'close')) {
      drafts.push(decodeFactBatch(args[3].bytes).events)
      if (blocked) return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' }
    }
    return original(...args)
  } }), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
  const document = await coordinator.openManagedDocument('child')
  await document.delivery.record({ type: 'subagent/inbox', messageId: 'saved', message: 'original', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const controller = new AbortController(), action = document.beginAction(controller.signal)
  const lifecycle = createGenerationLifecycle(document.view, 'child', action)
  const generation = await lifecycle.open('main', { kind: 'delegated-input', ref: 'inbox', seq: 0, messageId: 'saved' })
  armed = true
  try {
    const expiresAt = document.view.events.find(event => event.type === 'context/action' && event.op === 'open')!
    const original = generation.close('failed')
    await expect(original).rejects.toMatchObject({ code: 'GENERATION_UNCERTAIN' })
    blocked = false; controller.abort()
    await expect(generation.close('stopped')).rejects.toMatchObject({ code: 'GENERATION_UNCERTAIN' })
    expect(drafts).toHaveLength(1)
    expect(generation.recoverClose).toBeTypeOf('function')
    await generation.recoverClose!()
    expect(() => generation.assertOpen()).toThrow()
    expect(document.view.events.find(event => event.type === 'context/action' && event.op === 'open')).toBe(expiresAt)
    await lifecycle.drain(); action.finish()
    expect(drafts).toHaveLength(2); expect(drafts[0]).toEqual(drafts[1])
    expect(document.view.events.filter(event => event.type === 'context/action' && event.op === 'close')).toMatchObject([{ disposition: 'failed' }])
    await expect(generation.close('stopped')).rejects.toMatchObject({ code: 'GENERATION_UNCERTAIN' })
  } finally { blocked = false; await generation.recoverClose?.(); await lifecycle.drain(); action.finish(); await coordinator.close() }
})

it('accepts ordinary early success for a handle whose original state is already closed without creating a recovery intent', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'closed-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
  const document = await coordinator.openManagedDocument('child')
  await document.delivery.record({ type: 'subagent/inbox', messageId: 'saved', message: 'original', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const action = document.beginAction(), lifecycle = createGenerationLifecycle(document.view, 'child', action)
  const origin = { kind: 'delegated-input' as const, ref: 'inbox' as const, seq: 0, messageId: 'saved' }
  const first = await lifecycle.open('main', origin), alias = await lifecycle.open('main', origin)
  await first.close('failed')
  await alias.close('stopped'); await alias.close('failed')
  expect(alias.originalCloseInvoked!()).toBe(false)
  expect(document.view.events.filter(event => event.type === 'context/action' && event.op === 'close')).toHaveLength(1)
  await lifecycle.drain(); action.finish(); await coordinator.close()
})

