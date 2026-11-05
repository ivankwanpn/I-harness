import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionLockConflictError } from '@i-harness/fs-lock'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { CommitLogNotFoundError } from '@i-harness/session-commit-log'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-coord-'))
  roots.push(root)
  const coordinator = createCommitCoordinator({ root })
  coordinators.push(coordinator)
  return { root, coordinator }
}

function legacyStore(events: Array<Record<string, unknown>>, ids = ['old']) {
  let reads = 0
  return {
    get reads() { return reads },
    store: {
      async read(id: string) {
        reads++
        if (!ids.includes(id)) throw new Error('missing')
        return { version: CURRENT_FORMAT_VERSION, events: events.map((event, seq) => ({ ...event, seq })) as never[], meta: { sessionId: id, createdAt: 'c', formatVersion: CURRENT_FORMAT_VERSION } }
      },
      async list() { return ids },
    },
  }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('commit coordinator', () => {
  it('creates, loads and appends with assigned seqs', async () => {
    const { coordinator } = await setup()
    const { id } = await coordinator.create({ sessionId: 's1' })
    expect(id).toBe('s1')
    await coordinator.append('s1', [{ type: 'user/message', text: 'hi' }])
    await coordinator.append('s1', [{ type: 'user/message', text: 'again' }])

    const { session } = await coordinator.load('s1')
    expect(session.formatVersion).toBe(CURRENT_FORMAT_VERSION)
    expect(session.events).toEqual([
      { type: 'user/message', text: 'hi', seq: 0 },
      { type: 'user/message', text: 'again', seq: 1 },
    ])
  })

  it('refuses a non-contiguous explicit seq', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    await expect(coordinator.append('s1', [{ type: 'user/message', text: 'x', seq: 5 }])).rejects.toThrow(/sequence invariant/)
  })

  it('merges metadata and profiles without reading events', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1', title: 'first' })
    const updated = await coordinator.updateMeta('s1', { title: 'second' })
    expect(updated.title).toBe('second')
    const profile = await coordinator.profile('s1')
    expect(profile.meta.title).toBe('second')
    expect(profile.blank).toBe(true)
  })

  it('round-trips a document through the sidecar store', async () => {
    const { coordinator } = await setup()
    await coordinator.putDocument('task-registry', { tasks: [{ id: 't1' }], revision: 2 })
    expect(await coordinator.getDocument('task-registry')).toEqual({ tasks: [{ id: 't1' }], revision: 2 })
    expect(await coordinator.getDocument('missing')).toBeUndefined()
  })

  it('lists committed sessions', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 'a' })
    await coordinator.create({ sessionId: 'b' })
    expect(await coordinator.list()).toEqual(['a', 'b'])
  })

  it('holds the write lease through loadOwned until release', async () => {
    const { root, coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    await coordinator.loadOwned('s1')
    const second = createCommitCoordinator({ root, acquireDeadlineMs: 80, acquireRetryMs: 5 })
    coordinators.push(second)
    await expect(second.loadOwned('s1')).rejects.toBeInstanceOf(SessionLockConflictError)
    await coordinator.releaseOwnership('s1')
    await expect(second.loadOwned('s1')).resolves.toBeDefined()
  })

  it('reads a legacy session without writing a new generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-commit-coord-'))
    roots.push(root)
    const legacy = legacyStore([{ type: 'user/message', text: 'old' }])
    const coordinator = createCommitCoordinator({ root, legacy: legacy.store })
    coordinators.push(coordinator)
    const { session } = await coordinator.load('old')
    expect(session.events).toEqual([{ type: 'user/message', text: 'old', seq: 0 }])
    expect(await stat(join(root, 'old')).then(() => true, () => false)).toBe(false)
    expect(legacy.reads).toBe(1)
  })

  it('migrates a legacy session to format 15 on its first write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-commit-coord-'))
    roots.push(root)
    const legacy = legacyStore([{ type: 'user/message', text: 'old' }])
    const coordinator = createCommitCoordinator({ root, legacy: legacy.store })
    coordinators.push(coordinator)
    await coordinator.append('old', [{ type: 'user/message', text: 'new' }])
    expect(await stat(join(root, 'old', 'session.v15.jsonl')).then(() => true, () => false)).toBe(true)
    const { session } = await coordinator.load('old')
    expect(session.events.map(event => (event as { text?: string }).text)).toEqual(['old', 'new'])
    expect(legacy.reads).toBe(1)
  })

  it('unions legacy ids into list and profiles them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ih-commit-coord-'))
    roots.push(root)
    const legacy = legacyStore([{ type: 'turn/start' }])
    const coordinator = createCommitCoordinator({ root, legacy: legacy.store })
    coordinators.push(coordinator)
    await coordinator.create({ sessionId: 'fresh' })
    expect(await coordinator.list()).toEqual(['fresh', 'old'])
    const profile = await coordinator.profile('old')
    expect(profile.meta.sessionId).toBe('old')
    expect(profile.blank).toBe(false)
  })

  it('forks a committed prefix into a new generation', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 'p' })
    await coordinator.append('p', [{ type: 'user/message', text: 'a' }, { type: 'user/message', text: 'b' }, { type: 'user/message', text: 'c' }])
    const { id } = await coordinator.fork('p', { cut: 2, sessionId: 'c1' })
    expect(id).toBe('c1')
    const { session } = await coordinator.load('c1')
    expect(session.events.map(event => (event as { text?: string }).text)).toEqual(['a', 'b'])
    expect((session as { header?: unknown }).header).toMatchObject({ parentSession: 'p', seedLength: 2 })
    expect(await coordinator.list()).toEqual(['c1', 'p'])
    await expect(coordinator.fork('p', { cut: 9 })).rejects.toThrow(/fork cut/)
  })

  it('records and settles birth intents durably', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's' })
    await coordinator.beginIntent('s', 'i1', { kind: 'child-birth', childId: 'x' })
    expect((await coordinator.intents('s')).get('i1')).toEqual({ kind: 'child-birth', childId: 'x' })
    await coordinator.endIntent('s', 'i1', 'committed')
    expect((await coordinator.intents('s')).size).toBe(0)
    await coordinator.beginIntent('s', 'i2', { kind: 'child-birth' })
    await coordinator.close()
    const reopened = createCommitCoordinator({ root: (coordinator as { storageRoot: string }).storageRoot })
    coordinators.push(reopened)
    expect((await reopened.intents('s')).get('i2')).toEqual({ kind: 'child-birth' })
  })

  it('opens a managed document and commits a fact group', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    const document = await coordinator.openManagedDocument('s1')
    const outcome = await document.metadata.enterPlan('proposal')
    expect(outcome.kind).toBe('committed')
    expect(document.view.events.map(event => event.type)).toEqual(['plan/mode', 'user/message'])
    await coordinator.closeManagedDocument('s1')
    const { session } = await coordinator.load('s1')
    expect(session.events.map(event => event.type)).toEqual(['plan/mode', 'user/message'])
    const reopened = await coordinator.openManagedDocument('s1')
    expect(reopened.view.events.map(event => event.type)).toEqual(['plan/mode', 'user/message'])
    await coordinator.closeManagedDocument('s1')
  })

  it('deletes a session behind a durable receipt and notifies listeners', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    await coordinator.append('s1', [{ type: 'user/message', text: 'x' }])
    const seen: string[] = []
    const off = coordinator.onDocumentDeleted(async id => { seen.push(id) })
    const manifest = { documents: [], files: [] }
    await coordinator.deleteOwnedSession('s1', manifest)
    off()
    expect(seen).toEqual(['s1'])
    expect(await coordinator.list()).toEqual([])
    await expect(coordinator.load('s1')).rejects.toBeInstanceOf(CommitLogNotFoundError)
    expect(await coordinator.deletionReceipt('s1')).toEqual(manifest)
    const recreated = await coordinator.create({ sessionId: 's1' })
    expect(recreated.id).toBe('s1')
    const { session } = await coordinator.load('s1')
    expect(session.events).toEqual([])
  })

  it('reports live ownership while a handle is retained', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    expect(coordinator.hasLiveOwnership('s1')).toBe(false)
    await coordinator.loadOwned('s1')
    expect(coordinator.hasLiveOwnership('s1')).toBe(true)
    await coordinator.releaseOwnership('s1')
    expect(coordinator.hasLiveOwnership('s1')).toBe(false)
  })

  it('routes appends through the retained owned handle', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    await coordinator.loadOwned('s1')
    await coordinator.append('s1', [{ type: 'user/message', text: 'owned' }])
    const { session } = await coordinator.load('s1')
    expect(session.events).toEqual([{ type: 'user/message', text: 'owned', seq: 0 }])
  })
})
