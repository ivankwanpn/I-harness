import * as archive from '@i-harness/core-session/internal/archive'
import { committedFactSeqs, encodeFactBatch, factPrefixDigest, legacyPrefixDigest, type JournalMetadata, type SessionView } from '@i-harness/core-session'
import { originalColdArchiveHistoryReader } from '@i-harness/session-persistence/internal/archive-read'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend } from '../src/index.ts'
import { PREPARED_HISTORY_LIFETIME_MS } from '../src/backend/process-read.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts'

const barrier = vi.hoisted(() => ({
  afterSealedPage: undefined as (() => Promise<void>) | undefined,
  beforeRestore: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('../../session-persistence/src/archive-read-internal.ts', async load => {
  const original = await load<typeof import('../../session-persistence/src/archive-read-internal.ts')>()
  return {
    ...original,
    associateColdArchiveHistoryReader(backend: object, reader: import('../../session-persistence/src/archive-read-internal.ts').ColdArchiveHistoryReader) {
      original.associateColdArchiveHistoryReader(backend, reader.readFullForHistoryPage ? {
        ...reader,
        async readFullForHistoryPage(id) {
          const result = await reader.readFullForHistoryPage!(id)
          if (result?.retainDecoded) await barrier.afterSealedPage?.()
          return result
        },
      } : reader)
    },
  }
})

vi.mock('../../session-persistence/src/coordinator/managed-execution-source.ts', async load => {
  const original = await load<typeof import('../../session-persistence/src/coordinator/managed-execution-source.ts')>()
  return {
    ...original,
    createManagedExecutionSource(ports: Parameters<typeof original.createManagedExecutionSource>[0]) {
      const source = original.createManagedExecutionSource(ports)
      const initialize = source.initialize
      source.initialize = async () => {
        await barrier.beforeRestore?.()
        return initialize.call(source)
      }
      return source
    },
  }
})

vi.mock('@i-harness/core-session/internal/archive', async load => {
  const original = await load<typeof import('@i-harness/core-session/internal/archive')>()
  return { ...original, createArchiveJournalHistoryDecoder: vi.fn(original.createArchiveJournalHistoryDecoder) }
})

const decodes = vi.mocked(archive.createArchiveJournalHistoryDecoder)
const tail = { afterSeq: 0, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 5, includeTurns: true }
const originalEvent = {type: 'user/message' as const, text: 'before', provenance: {
  kind: 'human' as const, authority: 'request' as const, scope: 'turn' as const, producer: 'fixture',
}}

async function withHistory(run: (fixture: {
  root: string
  backend: ReturnType<typeof createJsonlBackend>
  coordinator: ReturnType<typeof createSessionCoordinator>
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ih-history-prepare-'))
  const backend = createJsonlBackend(root)
  const builder = createSessionCoordinator(backend)
  let coordinator: ReturnType<typeof createSessionCoordinator> | undefined
  try {
    for (const id of ['a', 'b']) {
      await builder.create({ sessionId: id })
      await builder.append(id, [originalEvent])
    }
    await builder.close()
    coordinator = createSessionCoordinator(backend)
    await run({ root, backend, coordinator })
  } finally {
    await (coordinator ?? builder).close()
    await rm(root, { recursive: true, force: true })
  }
}

it('detaches page and public snapshot from a one-use native writer decode', async () => withHistory(async ({ coordinator }) => {
  decodes.mockClear()
  const initial = await coordinator.readHistoryPage!('a', tail)
  const pageEvent = initial?.events[0]
  expect(decodes).toHaveBeenCalledTimes(1)
  expect(pageEvent).toMatchObject(originalEvent)
  if (pageEvent?.type !== 'user/message') throw Error('Expected original page event')
  expect(Reflect.set(pageEvent, 'text', 'page edit')).toBe(true)
  expect(Reflect.set(pageEvent.provenance!, 'scope', 'session')).toBe(true)

  const publicSnapshot = (await coordinator.snapshot!('a', { prepareHistoryPages: true })).session
  expect(Reflect.set(publicSnapshot.events[0]!, 'text', 'public edit')).toBe(true)
  const reloadedPage = await coordinator.readHistoryPage!('a', tail)
  expect(reloadedPage?.events[0]).toMatchObject(originalEvent)
  const preOpen = decodes.mock.calls.length
  const document = await coordinator.openManagedDocument('a')
  expect(decodes).toHaveBeenCalledTimes(preOpen)
  expect(document.view.events[0]).toMatchObject(originalEvent)
  await document.close()
  const next = await coordinator.openManagedDocument('a')
  expect(decodes.mock.calls.length).toBeGreaterThan(preOpen)
  expect(next.view.events[0]).toMatchObject(originalEvent)
}))

it.each(['preparing', 'committed', 'revoked'] as const)('qualifies the initial page while the original writable owner is %s', async mode => withHistory(async ({ coordinator }) => {
  const sealed = Promise.withResolvers<void>(), releasePage = Promise.withResolvers<void>()
  const restoring = Promise.withResolvers<void>(), releaseRestore = Promise.withResolvers<void>()
  barrier.afterSealedPage = async () => { sealed.resolve(); await releasePage.promise }
  if (mode !== 'committed') barrier.beforeRestore = async () => { restoring.resolve(); await releaseRestore.promise }
  const opening = coordinator.readHistoryPage!('a', tail)
  void opening.catch(() => {})
  let attaching: ReturnType<typeof acquireManagedExecution> | undefined
  async function append(attachment: Awaited<ReturnType<typeof acquireManagedExecution>>) {
    const action = attachment.owner.beginAction()
    try { committedFactSeqs(await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })) }
    finally { action.finish() }
  }
  try {
    await sealed.promise
    attaching = acquireManagedExecution(coordinator, 'a')
    void attaching.catch(() => {})
    if (mode === 'revoked') {
      await restoring.promise
      coordinator.revokeManagedDocumentNewWork!('a')
      releasePage.resolve()
      releaseRestore.resolve()
      await expect(attaching).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      await expect(opening).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      return
    }
    if (mode === 'preparing') {
      await restoring.promise
      releasePage.resolve()
      const winner = await Promise.race([opening, new Promise(resolve => setImmediate(() => resolve('waiting for writer')))])
      expect(winner).toMatchObject({ headSeq: 1, events: [originalEvent] })
      releaseRestore.resolve()
      await append(await attaching)
    } else {
      await append(await attaching)
      releasePage.resolve()
      expect(await opening).toMatchObject({ headSeq: 2, events: [originalEvent, { type: 'plan/mode', mode: 'on' }] })
    }
    const refreshed = await coordinator.readHistoryPage!('a', tail)
    expect(refreshed).toMatchObject({ headSeq: 2, events: [originalEvent, { type: 'plan/mode', mode: 'on' }] })
  } finally {
    barrier.afterSealedPage = undefined
    barrier.beforeRestore = undefined
    releasePage.resolve()
    releaseRestore.resolve()
    await Promise.allSettled([opening, ...(attaching ? [attaching] : [])])
  }
}))

it.each(['other session', 'replaced input', 'corrupted input'] as const)('does not promote prepared data across %s', async mode => withHistory(async ({ root, coordinator }) => {
  expect(await coordinator.readHistoryPage!('a', tail)).toBeDefined()
  const preOpen = decodes.mock.calls.length
  if (mode === 'other session') {
    const other = await coordinator.openManagedDocument('b')
    expect(other.view.events[0]).toMatchObject(originalEvent)
    expect(decodes.mock.calls.length).toBeGreaterThan(preOpen)
    return
  }
  const path = join(root, 'a.jsonl')
  const original = await readFile(path)
  const end = original.indexOf(10)
  const header = JSON.parse(original.subarray(0, end).toString('utf8')) as { journal: JournalMetadata }
  if (mode === 'replaced input') {
    const originalBatchId = JSON.parse(original.subarray(end + 1).toString('utf8')).batchId as string
    const revised = encodeFactBatch(originalBatchId, header.journal.legacyPrefixDigest, [
      {...originalEvent, text: 'after!', seq: 0},
    ])
    const sameLength = Buffer.concat([original.subarray(0, end + 1), revised.bytes])
    expect(sameLength.length).toBe(original.length)
    expect(sameLength).not.toEqual(original)
    await writeFile(path, sameLength)
    const document = await coordinator.openManagedDocument('a')
    expect(document.view.events[0]).toMatchObject({text: 'after!'})
    expect(decodes.mock.calls.length).toBeGreaterThan(preOpen)
  } else {
    const replacement = Buffer.from(original.toString('utf8').replace('"text":"before"', '"text":"broken"'))
    expect(replacement.length).toBe(original.length)
    expect(replacement).not.toEqual(original)
    await writeFile(path, replacement)
    await expect(coordinator.openManagedDocument('a')).rejects.toThrow()
    expect(await readFile(path)).toEqual(replacement)
  }
}))

it('does not turn an ordinary public snapshot into writable preparation', async () => withHistory(async ({ coordinator }) => {
  const snapshot = (await coordinator.snapshot!('a', { prepareHistoryPages: true })).session
  expect(Reflect.set(snapshot.events[0]!, 'text', 'outside edit')).toBe(true)
  const preOpen = decodes.mock.calls.length
  const document = await coordinator.openManagedDocument('a')
  expect(document.view.events[0]).toMatchObject(originalEvent)
  expect(decodes.mock.calls.length).toBeGreaterThan(preOpen)
}))

it('leaves an older valid unframed history on the established snapshot path', async () => withHistory(async ({ root, coordinator }) => {
  const path = join(root, 'legacy.jsonl')
  const source = ['{"sessionId":"legacy","createdAt":"2026-01-01T00:00:00Z","formatVersion":1}',
    '{"type":"user/message","text":"legacy history"}', ''].join('\n')
  await writeFile(path, source)
  expect(await coordinator.readHistoryPage!('legacy', tail)).toBeUndefined()
  const history = (await coordinator.snapshot!('legacy', { prepareHistoryPages: true })).session
  expect(history.events).toContainEqual(expect.objectContaining({ type:'user/message', text:'legacy history' }))
  expect(await readFile(path, 'utf8')).toBe(source)
}))

it.each([16_384, 16_385])('decodes a %s-record history exactly once and keeps the public tail', async count => withHistory(async ({ root, coordinator }) => {
  const journal: JournalMetadata = { version: 1, legacyBodyBytes: 0, legacyEventCount: 0,
    legacyPrefixDigest: legacyPrefixDigest(0, Buffer.alloc(0)), separatorBytes: 0 }
  let prefix = journal.legacyPrefixDigest
  const parts = [Buffer.from(JSON.stringify({ sessionId:'bulk',createdAt:'2026-01-01T00:00:00Z',formatVersion:14,journal }) + '\n')]
  for (let start = 0; start < count; start += 200) {
    const events = Array.from({length: Math.min(200, count - start)}, (_, index) => ({
      type:'plan/mode' as const, mode:'on' as const, seq: start + index,
    }))
    const frame = encodeFactBatch('bulk-' + start, prefix, events)
    parts.push(Buffer.from(frame.bytes))
    prefix = factPrefixDigest(prefix, frame.key.batchDigest)
  }
  const original = Buffer.concat(parts)
  expect(original.length).toBeLessThan(8 * 1024 * 1024)
  const path = join(root, 'bulk.jsonl')
  await writeFile(path, original)
  decodes.mockClear()
  let fallback: SessionView | undefined
  const page = await coordinator.readHistoryPage!('bulk', tail, session => { fallback = session })
  expect(decodes).toHaveBeenCalledTimes(1)
  if (count === 16_384) {
    expect(page).toMatchObject({headSeq: count,startSeq: count-5,events: expect.arrayContaining([expect.objectContaining({seq:count-1})])})
    expect(fallback).toBeUndefined()
  } else {
    expect(page).toBeUndefined()
    expect(fallback?.events.length).toBe(count)
    expect(fallback?.events.at(-1)).toMatchObject({seq:count-1,mode:'on'})
  }
  expect(await readFile(path)).toEqual(original)
}))

it('keeps delegated decoding on the ordinary writer route', async () => withHistory(async ({ coordinator }) => {
  const original = JSON.parse
  const delegated = vi.spyOn(JSON,'parse').mockImplementation((text,reviver) => original(text,reviver))
  try {
    expect((await coordinator.readHistoryPage!('a', tail))?.events[0]).toMatchObject(originalEvent)
  } finally { delegated.mockRestore() }
  const preOpen = decodes.mock.calls.length
  const document = await coordinator.openManagedDocument('a')
  expect(document.view.events[0]).toMatchObject(originalEvent)
  expect(decodes.mock.calls.length).toBeGreaterThan(preOpen)
}))

it('expires speculative decoded history before later writable preparation', async () => withHistory(async ({ coordinator }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    expect(await coordinator.readHistoryPage!('a', tail)).toBeDefined()
    const preOpen = decodes.mock.calls.length
    await vi.advanceTimersByTimeAsync(PREPARED_HISTORY_LIFETIME_MS + 1)
    vi.useRealTimers()
    const document = await coordinator.openManagedDocument('a')
    expect(document.view.events[0]).toMatchObject(originalEvent)
    expect(decodes.mock.calls.length).toBeGreaterThan(preOpen)
  } finally { vi.useRealTimers() }
}))

it('clears a prepared graph and rejects a delayed handoff across coordinator close', async () => withHistory(async ({ backend, coordinator }) => {
  const reader = originalColdArchiveHistoryReader(backend)!
  const late = await reader.readFullForHistoryPage!('b')
  const retain = late?.retainDecoded
  if (!retain) throw Error('Expected original prepared history')
  await coordinator.readHistoryPage!('a', tail)
  const preOpen = decodes.mock.calls.length
  await coordinator.close()
  expect(retain).toThrow('ARCHIVE_READ_UNAVAILABLE')
  const afterClose = createSessionCoordinator(backend)
  try {
    const document = await afterClose.openManagedDocument('a')
    expect(document.view.events[0]).toMatchObject(originalEvent)
    expect(decodes.mock.calls.length).toBeGreaterThan(preOpen)
  } finally { await afterClose.close() }
}))
