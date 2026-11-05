import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import type { FactOwner } from '@i-harness/core-session'
import { createCodeModeEventFacts } from '../src/event-facts.ts'

/** Direct producer fixtures own their original cancellation/terminal seal. */
function directFacts(owner: FactOwner, onChange?: () => void) {
  const live = new Set<string>()
  const facts = createCodeModeEventFacts(owner, async () => {
    for (const cellId of [...live]) { live.delete(cellId); await facts.required({ type: 'code/cell', cellId, state: 'terminated' }) }
  }, onChange)
  const optional = facts.optional, required = facts.required
  facts.optional = async (...args) => { await optional(...args); live.add(args[0].cellId) }
  facts.required = (...args) => { if (args[0].type === 'code/cell') live.delete(args[0].cellId); return required(...args) }
  return facts
}
it('releases only the recovered original output hold while keeping its live mount source usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-output-hold-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const facts = directFacts(document)
  let blocked = true, installed = 0
  try {
    await facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })
    await expect(facts.requiredPrepared('original', async () => {
      if (blocked) throw new Error('Original store receipt unknown')
      return { type: 'code/output', cellId: 'original', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' }, preview: '', media: [], retention: { kind: 'unavailable', reason: 'quota' } } }
    }, () => { installed++ })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(facts.optional({ type: 'code/cell', cellId: 'blocked', state: 'started' })).rejects.toThrow()
    blocked = false
    await facts.refresh()
    expect(installed).toBe(1)
    await expect(facts.optional({ type: 'code/cell', cellId: 'next', state: 'started' })).resolves.toBeUndefined()
  } finally { blocked = false; await facts.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('cannot publish a queued terminal from source pre-drain before earlier output storage settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-output-close-order-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const facts = directFacts(document)
  let blocked = true
  try {
    await facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })
    await expect(facts.requiredPrepared('original', async () => {
      if (blocked) throw new Error('Original output storage unknown')
      return { type: 'code/output', cellId: 'original', envelope: { version: 1, execution: { outcome: 'unknown', dispatch: 'not-dispatched' }, preview: '', media: [], retention: { kind: 'unavailable', reason: 'quota' } } }
    })).rejects.toThrow()
    const terminal = { type: 'code/cell' as const, cellId: 'original', state: 'terminated' as const, error: 'original stop' }
    const queued = facts.required(terminal)
    terminal.error = 'later mutation'
    await expect(queued).rejects.toThrow()
    await expect(facts.close()).rejects.toThrow()
    expect(document.view.events.map(event => event.type === 'code/cell' ? event.state : event.type)).toEqual(['started'])
    blocked = false
    await facts.close()
    expect(document.view.events.map(event => event.type === 'code/cell' ? event.state : event.type)).toEqual(['started', 'code/output', 'terminated'])
    expect(document.view.events.at(-1)).toMatchObject({ error: 'original stop' })
  } finally { blocked = false; await facts.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('keeps a same-cell accepted backlog on its original source while recovery forbids new registrations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-output-backlog-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const facts = directFacts(document)
  let blocked = true
  const result = (preview: string) => ({ type: 'code/output' as const, cellId: 'original', envelope: { version: 1 as const, execution: { outcome: 'succeeded' as const, dispatch: 'not-dispatched' as const }, preview, media: [], retention: { kind: 'unavailable' as const, reason: 'quota' as const } } })
  try {
    await facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })
    await expect(facts.requiredPrepared('original', async () => { if (blocked) throw new Error('First original receipt unknown'); return result('first') })).rejects.toThrow()
    await expect(Promise.resolve().then(() => facts.requiredPrepared('original', async () => result('second')))).rejects.toThrow()
    blocked = false
    await facts.refresh()
    expect(document.view.events.filter(event => event.type === 'code/output').map(event => event.envelope?.preview)).toEqual(['first', 'second'])
    await facts.optional({ type: 'code/cell', cellId: 'next', state: 'started' })
  } finally { blocked = false; await facts.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('mirrors a transient original hold until its original checkpoint verifies recovery and isolates passive observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-observation-hold-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  let blocked = true, preparations = 0, observeRelease = false, emptyButHeld = false
  const states: string[] = []
  const facts = directFacts(document, () => {
    states.push(facts.observationState())
    if (observeRelease && facts.observationState() === 'unavailable') {
      try { facts.assertObserved(); emptyButHeld = true } catch { /* Still pending; no readiness certificate. */ }
    }
    throw new Error('observer failure')
  })
  try {
    await facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })
    await expect(facts.requiredPrepared('original', async () => {
      preparations++
      if (blocked) throw new Error('Original preparation unavailable')
      return { type: 'code/output', cellId: 'original', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' }, preview: '', media: [], retention: { kind: 'unavailable', reason: 'quota' } } }
    })).rejects.toThrow()
    const before = preparations
    expect(facts.observationState?.()).toBe('unavailable')
    facts.assertHeld()
    expect(facts.observationState?.()).toBe('unavailable')
    expect(preparations).toBe(before)
    blocked = false; observeRelease = true
    await facts.refresh()
    expect(emptyButHeld).toBe(true)
    expect(facts.observationState?.()).toBe('available')
    expect(states.at(-1)).toBe('available')
    facts.requireRecovery()
    await facts.required({ type: 'code/cell', cellId: 'original', state: 'completed' })
    expect(facts.observationState?.()).toBe('unavailable')
    const closing = facts.close()
    expect(facts.observationState?.()).toBe('retired')
    await closing
  } finally { blocked = false; await facts.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('keeps installation faults unavailable through original failed close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-observation-install-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const facts = directFacts(document)
  try {
    await facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })
    await expect(facts.required({ type: 'code/cell', cellId: 'original', state: 'completed' }, () => { throw new Error('local installation failed') })).rejects.toThrow()
    expect(facts.observationState?.()).toBe('unavailable')
    facts.assertHeld()
    expect(facts.observationState?.()).toBe('unavailable')
    await expect(facts.close()).rejects.toThrow()
    expect(facts.observationState?.()).toBe('retired')
  } finally { await facts.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('registers pending before preparation awaits and reports installation before final availability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-observation-pending-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), states: string[] = []
  const facts = directFacts(document, () => states.push(facts.observationState()))
  let installed: string | undefined
  try {
    await facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })
    const storing = facts.requiredPrepared('original', async () => {
      entered.resolve(); await release.promise
      return { type: 'code/output', cellId: 'original', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' }, preview: '', media: [], retention: { kind: 'unavailable', reason: 'quota' } } }
    }, () => { installed = facts.observationState() })
    expect(facts.observationState?.()).toBe('unavailable')
    await entered.promise
    expect(facts.observationState?.()).toBe('unavailable')
    release.resolve(); await storing
    expect(installed).toBe('unavailable')
    expect(facts.observationState?.()).toBe('available')
    expect(states.at(-1)).toBe('available')
  } finally { release.resolve(); await facts.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('keeps cancellation bookkeeping unavailable until the original callback returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-observation-cancel-'))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const facts = directFacts(document)
  let cancelledState: string | undefined
  try {
    await facts.optional({ type: 'code/cell', cellId: 'original', state: 'started' })
    const store = facts.store({ type: 'code/store', version: 1, cellId: 'original', writes: [['discard', 7]] }, () => {}, () => { cancelledState = facts.observationState() })
    facts.stopOptional()
    await store
    expect(cancelledState).toBe('unavailable')
    expect(facts.observationState?.()).toBe('available')
    expect(document.view.events.filter(event => event.type === 'code/store')).toEqual([])
  } finally { await facts.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
