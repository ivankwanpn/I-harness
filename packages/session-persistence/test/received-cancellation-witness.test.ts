import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs, readInbox } from '@i-harness/core-session'
import { createSessionCoordinator, createControlledJsonlBackend as createJsonlBackend, ownedControls } from './helpers/composed.ts'
import { cancellationRetirementFor } from '../src/coordinator/received-input-cancellation.ts'

const cancel = { type: 'agent/input/cancelled' as const, version: 1 as const, inputId: 'one', reason: 'original' }
const input = { type: 'agent/input/admitted' as const, version: 1 as const, inputId: 'one', text: 'Own input', delivery: 'steer' as const, intent: 'system' as const }
const invalid = { kind: 'not-issued' as const, code: 'FACT_INVALID_GROUP' as const }

it.each(['promotion', 'cancellation'] as const)('retires only the exact superseded cancellation, survives id reuse, and honors closed source checks (%s)', async winner => {
  const root = await mkdtemp(join(tmpdir(), 'cancel-owner-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent'), source = document.registerReceivedInputSource(async () => {})
    committedFactSeqs(await source.captureAdmitted(input).admit())
    const old = source.captureCancellation(cancel)
    if (winner === 'cancellation') committedFactSeqs(await source.captureCancellation({ ...cancel, reason: 'winner' }).admit())
    else {
      const action = document.beginAction()
      committedFactSeqs(await action.facts.inputs.claim({ type: 'agent/input/promoted', version: 1, inputId: 'one' }, { type: 'user/message', text: input.text, input: { inputId: 'one', intent: 'system' } }))
      action.finish()
    }
    const local = await old.retryAbsent()
    expect(local).toEqual(invalid); expect(Object.isFrozen(local)).toBe(false)
    const first = await old.admit()
    expect(first).not.toBe(local)
    expect(first).toEqual(invalid); expect(Object.isFrozen(first)).toBe(true)
    // Genuine later admission through the native input port. An old handle
    // must never requeue its cancellation against this distinct admission.
    const action = document.beginAction()
    committedFactSeqs(await action.facts.inputs.admit({ ...input, text: 'New own input' })); action.finish()
    const before = document.view.events.length
    for (const operation of [old.admit, old.reconcile, old.observe, old.retryAbsent]) expect(await operation()).toBe(first)
    expect(document.view.events).toHaveLength(before); expect(readInbox(document.view).isPending('one')).toBe(true)
    await source.close()
    for (const operation of [old.admit, old.reconcile, old.observe, old.retryAbsent]) await expect(operation()).rejects.toMatchObject({ code: 'FACT_CLOSED' })
    // No registration floor: a new authentic source can cancel the own
    // admission which already existed when this receiver registered.
    const fresh = document.registerReceivedInputSource(async () => {})
    expect(await fresh.captureCancellation(cancel).admit()).toMatchObject({ kind: 'committed' })
    await fresh.close(); expect(readInbox(document.view).isPending('one')).toBe(false)
    await document.close()
    await expect(old.admit()).rejects.toMatchObject({ code: 'FACT_CLOSED' })
  } finally { await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

it('pins owned identity and original admission, rejects malformed/seed/unbound/current-pending witnesses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cancel-witness-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent'), source = document.registerReceivedInputSource(async () => {})
    const witness = cancellationRetirementFor(document.view, document)
    expect(witness(cancel)).toBeUndefined()
    committedFactSeqs(await source.captureAdmitted(input).admit())
    let getters = 0
    const hidden = Object.defineProperty({ ...cancel }, 'extra', { value: true })
    for (const value of [hidden, { ...cancel, version: 2 }, { ...cancel, extra: true }, { ...cancel, inputId: '' }, { ...cancel, reason: 42 }, { ...cancel, get reason() { getters++; return 'x' } }]) expect(witness(value)).toBeUndefined()
    expect(getters).toBe(0)
    expect(cancellationRetirementFor({ ...document.view }, document)(cancel)).toBeUndefined()
    const cold = await backend.read('parent')
    expect(cancellationRetirementFor({ formatVersion: cold.version, events: cold.events }, document)(cancel)).toBeUndefined()
    expect(cancellationRetirementFor(document.view, {})(cancel)).toBeUndefined()
    const original = witness(cancel)!
    expect(original(invalid)).toBe(false) // still pending, not absence proof
    committedFactSeqs(await source.captureCancellation({ ...cancel, reason: 'real disposition' }).admit())
    expect(original(invalid)).toBe(true)
    expect(witness(cancel)).toBeUndefined() // capture made after disposal
    const action = document.beginAction()
    committedFactSeqs(await action.facts.inputs.admit({ ...input, text: 'New admission' })); action.finish()
    expect(original(invalid)).toBe(false) // later reuse is not the original proof
    committedFactSeqs(await source.captureAdmitted({ ...input, inputId: 'seed', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'seed', originSessionId: 'other' } }).admit())
    expect(witness({ ...cancel, inputId: 'seed' })).toBeUndefined()
    await source.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not treat a declared seed-region admission as own cancellation retirement authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cancel-seed-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    await coordinator.create({ sessionId: 'child', parentSession: 'other', origin: 'subagent', seedLength: 1 })
    await backend.append('child', [{ ...input, seq: 0 }])
    const document = await coordinator.openManagedDocument('child'), source = document.registerReceivedInputSource(async () => {})
    expect(document.view.events[0]?.seq).toBe(0)
    expect(cancellationRetirementFor(document.view, document)(cancel)).toBeUndefined()
    await source.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['unbound', 'malformed', 'still-pending'] as const)('keeps a genuinely invalid required source strict (%s)', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'cancel-strict-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent'), source = document.registerReceivedInputSource(async () => {})
    if (kind !== 'unbound') committedFactSeqs(await source.captureAdmitted(input).admit())
    const event = kind === 'malformed' ? { ...cancel, get reason() { throw Error('Never evaluate invalid hooks') } } : kind === 'still-pending' ? { ...cancel, type: 'agent/input/admitted' } : cancel
    expect(await source.captureCancellation(event as never).admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    await expect(source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  } finally { await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

it('keeps an issued unknown cancellation on its original key until genuine backend reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cancel-issued-')), backend = createJsonlBackend(root)
  const append = ownedControls(backend).originalAppend.bind(backend), reconcile = ownedControls(backend).originalReconcile.bind(backend), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let issued = 0, reconciles = 0, closingReconcile = false
  ownedControls(backend).append = async (...args) => {
    const outcome = await append(...args)
    if (JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((event: { type: string }) => event.type === 'agent/input/cancelled')) { issued++; throw Error('Receipt lost after irreversible cancellation write') }
    return outcome
  }
  ownedControls(backend).reconcile = async (...args) => {
    if (!issued) return reconcile(...args)
    if (!closingReconcile) return { kind: 'unknown', key: args[3].key }
    reconciles++; entered.resolve(); await release.promise; return reconcile(...args)
  }
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent'), source = document.registerReceivedInputSource(async () => {})
    committedFactSeqs(await source.captureAdmitted(input).admit())
    const fact = source.captureCancellation(cancel), outcome = await fact.admit()
    expect(outcome.kind).toBe('unknown'); expect(readInbox(document.view).isPending('one')).toBe(true)
    let closed = false
    closingReconcile = true
    const closing = source.close().then(() => { closed = true })
    await entered.promise; expect(closed).toBe(false); expect(issued).toBe(1)
    release.resolve(); await closing
    expect(reconciles).toBe(1); expect(issued).toBe(1)
    expect(readInbox(document.view).isPending('one')).toBe(false)
    expect((await backend.read('parent')).events.filter(event => event.type === 'agent/input/cancelled')).toHaveLength(1)
    await document.close()
  } finally { release.resolve(); await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
