import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createCodeModeEventFacts } from '../src/event-facts.ts'

it('releases only the recovered original output hold while keeping its live mount source usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-code-output-hold-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const facts = createCodeModeEventFacts(document, async () => {})
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
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const facts = createCodeModeEventFacts(document, async () => {})
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
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const facts = createCodeModeEventFacts(document, async () => {})
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
