import * as archive from '@i-harness/core-session/internal/archive'
import * as validation from '../../core-session/src/conversation/validation.ts'
import { committedFactSeqs, encodeFactBatch, factPrefixDigest, legacyPrefixDigest, readFactJournal, type JournalMetadata, type SessionEvent, type SessionView } from '@i-harness/core-session'
import { originalColdArchiveHistoryReader } from '@i-harness/session-persistence/internal/archive-read'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend } from '../src/index.ts'
import { PREPARED_HISTORY_LIFETIME_MS } from '../src/backend/process-read.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts'

const barrier = vi.hoisted(() => ({
  afterSealedPage: undefined as (() => Promise<void>) | undefined,
  beforeRestore: undefined as (() => Promise<void>) | undefined,
  readOrdinals: undefined as ((ordinals: readonly number[]) => void) | undefined,
  beforePending: undefined as (() => void) | undefined,
}))

vi.mock('../../core-session/src/inbox-view.ts', async load => {
  const original = await load<typeof import('../../core-session/src/inbox-view.ts')>()
  return {
    ...original,
    readInbox(...args: Parameters<typeof original.readInbox>) {
      const inbox = original.readInbox(...args)
      return { ...inbox, pending() { barrier.beforePending?.(); return inbox.pending() } }
    },
  }
})

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
        async readWindow(id, evidence, ordinals) {
          barrier.readOrdinals?.([...ordinals])
          return reader.readWindow(id, evidence, ordinals)
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
  return { ...original, createArchiveJournalHistoryDecoder: vi.fn(original.createArchiveJournalHistoryDecoder), replayOriginalArchiveFrames: vi.fn(original.replayOriginalArchiveFrames) }
})

vi.mock('../../core-session/src/conversation/validation.ts', async load => {
  const original = await load<typeof import('../../core-session/src/conversation/validation.ts')>()
  return { ...original, createConversationValidationScan: vi.fn(original.createConversationValidationScan), validateDecoderOwnedConversationHistory: vi.fn(original.validateDecoderOwnedConversationHistory) }
})

const decodes = vi.mocked(archive.createArchiveJournalHistoryDecoder)
const replays = vi.mocked(archive.replayOriginalArchiveFrames)
const nativeValidations = vi.mocked(validation.validateDecoderOwnedConversationHistory)
const validationScans = vi.mocked(validation.createConversationValidationScan)
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

const admitted = (inputId: string, text: string): SessionEvent => ({type:'agent/input/admitted',version:1,inputId,text,delivery:'queue',intent:'user'})
async function appendRawEvents(root: string, events: readonly SessionEvent[]) {
  const path = join(root, 'a.jsonl'), bytes = await readFile(path), end = bytes.indexOf(10)
  const header = JSON.parse(bytes.subarray(0, end).toString('utf8')) as { formatVersion: number; journal: JournalMetadata; sessionId: string }
  const { prefix } = readFactJournal(bytes.subarray(end + 1), header.journal, header.formatVersion, header)
  const frame = encodeFactBatch('pending-fixture-' + prefix.eventCount, prefix.prefixDigest,
    events.map((event, index) => ({ ...event, seq: prefix.eventCount + index })))
  await appendFile(path, frame.bytes)
}

it.each(['history first', 'pending first'] as const)('shares one initial native decode when %s', async order => withHistory(async ({ coordinator, root }) => {
  await appendRawEvents(root, [admitted('keep', 'pending'), admitted('done', 'completed'),
    {type:'agent/input/promoted',version:1,inputId:'done'}, admitted('cancelled','cancelled'),
    {type:'agent/input/cancelled',version:1,inputId:'cancelled'}])
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  barrier.afterSealedPage = async () => { entered.resolve(); await release.promise }
  const history = () => coordinator.readHistoryPage!('a', tail)
  const pending = () => coordinator.readPendingInputs!('a')
  decodes.mockClear()
  let requests: readonly Promise<unknown>[] = []
  try {
    let page, state
    if (order === 'history first') {
      page = history()
      requests = [page]
      await entered.promise
      state = pending()
    } else {
      state = pending()
      requests = [state]
      await entered.promise
      page = history()
    }
    requests = [page, state]
    await nextTurn()
    release.resolve()
    expect(await page).toMatchObject({ headSeq: 6 })
    const item = {inputId:'keep',text:'pending',intent:'user',delivery:'queue',admittedSeq:1}
    expect(await state).toEqual([item])
    expect(decodes).toHaveBeenCalledTimes(1)

    const observed: Array<readonly number[]> = []
    barrier.readOrdinals = ordinals => observed.push(ordinals)
    expect(await pending()).toEqual([item])
    expect(observed).toEqual([[1]])
    expect(decodes).toHaveBeenCalledTimes(1)
    expect(coordinator.ownerOf('a')).toBe(false)
  } finally {
    barrier.afterSealedPage = undefined
    barrier.readOrdinals = undefined
    release.resolve()
    await Promise.allSettled(requests)
  }
}))

it('does not fold or require the pending inbox when only opening a history page', async () => withHistory(async ({ coordinator, root }) => {
  await appendRawEvents(root, [admitted('keep', 'pending')])
  const unrelatedFailure = Error('A history page must not depend on a pending fold')
  barrier.beforePending = () => { throw unrelatedFailure }
  try {
    decodes.mockClear()
    expect(await coordinator.readHistoryPage!('a', tail)).toMatchObject({headSeq:2})
    expect(decodes).toHaveBeenCalledTimes(1)
    await expect(coordinator.readPendingInputs!('a')).rejects.toBe(unrelatedFailure)
    expect(decodes).toHaveBeenCalledTimes(2)
  } finally { barrier.beforePending = undefined }
}))

it('seals even an empty cached inbox and requalifies after the committed journal changes', async () => withHistory(async ({ coordinator, root }) => {
  expect(await coordinator.readHistoryPage!('a', tail)).toMatchObject({ headSeq: 1 })
  const observed: Array<readonly number[]> = []
  barrier.readOrdinals = ordinals => observed.push(ordinals)
  try {
    decodes.mockClear()
    expect(await coordinator.readPendingInputs!('a')).toEqual([])
    expect(observed).toEqual([])
    expect(decodes).toHaveBeenCalledTimes(1)
    decodes.mockClear()
    expect(await coordinator.readPendingInputs!('a')).toEqual([])
    expect(observed).toEqual([[]])
    expect(decodes).not.toHaveBeenCalled()
    await appendRawEvents(root, [admitted('fresh', 'newly queued')])
    expect(await coordinator.readPendingInputs!('a')).toEqual([
      {inputId:'fresh',text:'newly queued',intent:'user',delivery:'queue',admittedSeq:1},
    ])
    expect(observed).toEqual([[], []])
    expect(decodes).toHaveBeenCalledTimes(1)
  } finally { barrier.readOrdinals = undefined }
}))

it('requalifies cached pending records after a valid same-size overwrite', async () => withHistory(async ({ coordinator, root }) => {
  await appendRawEvents(root, [admitted('keep', 'before')])
  expect(await coordinator.readHistoryPage!('a', tail)).toMatchObject({headSeq:2})
  expect(await coordinator.readPendingInputs!('a')).toEqual([{inputId:'keep',text:'before',intent:'user',delivery:'queue',admittedSeq:1}])
  const path = join(root, 'a.jsonl'), source = await readFile(path)
  const last = source.lastIndexOf(10, source.length - 2) + 1
  const frame = JSON.parse(source.subarray(last).toString('utf8')) as { batchId: string; previousPrefixDigest: string }
  const rewritten = Buffer.concat([source.subarray(0, last), encodeFactBatch(frame.batchId, frame.previousPrefixDigest, [
    {...admitted('keep', 'after!'), seq:1},
  ]).bytes])
  expect(rewritten.length).toBe(source.length)
  expect(rewritten).not.toEqual(source)
  await writeFile(path, rewritten)
  decodes.mockClear()
  expect(await coordinator.readPendingInputs!('a')).toEqual([{inputId:'keep',text:'after!',intent:'user',delivery:'queue',admittedSeq:1}])
  expect(decodes).toHaveBeenCalledTimes(1)
}))

it('derives pending from the same decoded ignorable history while detaching the mutable public fallback', async () => withHistory(async ({ coordinator, root }) => {
  await appendRawEvents(root, [admitted('still-pending', 'original pending'),
    {type:'test/ignorable',ignorable:true} as unknown as SessionEvent])
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  barrier.afterSealedPage = async () => { entered.resolve(); await release.promise }
  let fallback: SessionView | undefined
  decodes.mockClear()
  const page = coordinator.readHistoryPage!('a', tail, session => {
    fallback = session
    const admission = session.events.find(event => event.type === 'agent/input/admitted')!
    expect(Reflect.set(admission, 'text', 'mutated external snapshot')).toBe(true)
  })
  try {
    await entered.promise
    const pending = coordinator.readPendingInputs!('a')
    await nextTurn()
    release.resolve()
    expect(await page).toBeUndefined()
    expect(fallback?.events).toHaveLength(2)
    expect(await pending).toEqual([{inputId:'still-pending',text:'original pending',intent:'user',delivery:'queue',admittedSeq:1}])
    expect(decodes).toHaveBeenCalledTimes(1)
  } finally { barrier.afterSealedPage = undefined; release.resolve(); await page }
}))

it('preserves every pending input past the compact ordinal limit', async () => withHistory(async ({ coordinator, root }) => {
  await appendRawEvents(root, Array.from({length:257}, (_, index) => admitted('input-' + index, 'queued ' + index)))
  await coordinator.readHistoryPage!('a', tail)
  decodes.mockClear()
  const captured: Array<readonly number[]> = []
  barrier.readOrdinals = ordinals => captured.push(ordinals)
  try {
    const items = await coordinator.readPendingInputs!('a')
    expect(items).toHaveLength(257)
    expect(items.at(-1)).toMatchObject({inputId:'input-256',admittedSeq:257})
    expect(captured).toEqual([])
    expect(decodes).toHaveBeenCalledTimes(1)
  } finally { barrier.readOrdinals = undefined }
}))

it('joins restoring managed input state without materializing a Session and tracks committed consumption', async () => withHistory(async ({ coordinator, root }) => {
  await appendRawEvents(root, [admitted('to-promote', 'promote me'), admitted('to-cancel', 'cancel me')])
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  barrier.beforeRestore = async () => { entered.resolve(); await release.promise }
  const attaching = acquireManagedExecution(coordinator, 'a')
  void attaching.catch(() => {})
  let reading: ReturnType<NonNullable<typeof coordinator.readPendingInputs>> | undefined
  try {
    await entered.promise
    reading = coordinator.readPendingInputs!('a')
    void reading.catch(() => {})
    await nextTurn()
    release.resolve()
    const [execution, pending] = await Promise.all([attaching, reading])
    expect(pending).toEqual([
      { inputId: 'to-promote', text: 'promote me', intent: 'user', delivery: 'queue', admittedSeq: 1 },
      { inputId: 'to-cancel', text: 'cancel me', intent: 'user', delivery: 'queue', admittedSeq: 2 },
    ])
    expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
    const action = execution.owner.beginAction()
    try {
      committedFactSeqs(await action.facts.inputs.start(
        { type: 'agent/input/promoted', version: 1, inputId: 'to-promote' },
        { type: 'user/message', text: 'promote me', input: { inputId: 'to-promote', intent: 'user' } },
      ))
      expect(await coordinator.readPendingInputs!('a')).toEqual([pending[1]])
      committedFactSeqs(await action.facts.inputs.cancel({ type: 'agent/input/cancelled', version: 1, inputId: 'to-cancel' }))
      expect(await coordinator.readPendingInputs!('a')).toEqual([])
      committedFactSeqs(await action.facts.agent.lifecycle({ type: 'turn/end' }))
      expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
    } finally { action.finish() }
  } finally {
    barrier.beforeRestore = undefined
    release.resolve()
    await Promise.allSettled([attaching, ...(reading ? [reading] : [])])
  }
}))

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

it.each(['held-writer-decode','retained-cold-page'] as const)('keeps a single original relational validation on the %s path', async mode => withHistory(async ({ coordinator }) => {
  if (mode === 'retained-cold-page') expect(await coordinator.readHistoryPage!('a', tail)).toBeDefined()
  decodes.mockClear()
  validationScans.mockClear()
  const execution = await acquireManagedExecution(coordinator,'a')
  expect(decodes).toHaveBeenCalledTimes(mode === 'held-writer-decode' ? 1 : 0)
  expect(validationScans).toHaveBeenCalledTimes(mode === 'held-writer-decode' ? 0 : 1)
  const action = execution.owner.beginAction()
  try {
    committedFactSeqs(await action.facts.metadata.admit({type:'plan/mode',mode:'on'}))
  } finally { action.finish() }
  expect(await coordinator.readHistoryPage!('a', tail)).toMatchObject({
    headSeq:2, events:[originalEvent,{type:'plan/mode',mode:'on'}],
  })
  await execution.close()
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

async function afterDecodedPreparationExpires(work: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try { await work(); await vi.advanceTimersByTimeAsync(PREPARED_HISTORY_LIFETIME_MS + 1) }
  finally { vi.useRealTimers() }
}

it('replays both page LRU entries after decoded preparation expires and still validates every history', async () => withHistory(async ({coordinator, root}) => {
  await afterDecodedPreparationExpires(async () => {
    for (const id of ['a','b']) expect(await coordinator.readHistoryPage!(id,tail)).toMatchObject({headSeq:1})
  })
  decodes.mockClear(); replays.mockClear(); nativeValidations.mockClear(); validationScans.mockClear()
  for (const id of ['a','b']) {
    const file = join(root,id+'.jsonl'), before = await readFile(file)
    const writer = await acquireManagedExecution(coordinator,id)
    expect(writer.observe().eventCount).toBe(1)
    expect(Object.hasOwn(writer.owner,'view')).toBe(false)
    expect(await readFile(file)).toEqual(before)
  }
  expect(decodes).not.toHaveBeenCalled()
  expect(replays).toHaveBeenCalledTimes(2)
  expect(nativeValidations).toHaveBeenCalledTimes(2)
  expect(validationScans).not.toHaveBeenCalled()
}))

it('does not reuse an ordinary snapshot witness for the writer even if it prepared a page cache entry', async () => withHistory(async ({coordinator}) => {
  await coordinator.snapshot!('a',{prepareHistoryPages:true})
  decodes.mockClear(); replays.mockClear()
  const writer = await acquireManagedExecution(coordinator,'a')
  expect(writer.observe().eventCount).toBe(1)
  expect(replays).not.toHaveBeenCalled()
  expect(decodes).toHaveBeenCalledTimes(1)
}))

it('uses the ordinary writer verification for an evicted page and for changed raw bytes', async () => withHistory(async ({coordinator, root}) => {
  await coordinator.create({sessionId:'c'}); await coordinator.append('c',[originalEvent]); await coordinator.releaseOwnership('c')
  await afterDecodedPreparationExpires(async () => {
    for (const id of ['a','b','c']) expect(await coordinator.readHistoryPage!(id,tail)).toBeDefined()
  })
  const path = join(root,'b.jsonl'), original = await readFile(path), end = original.indexOf(10)
  const header = JSON.parse(original.subarray(0,end).toString('utf8')) as {journal:JournalMetadata}
  const first = JSON.parse(original.subarray(end+1).toString('utf8')) as {batchId:string}
  const event = {...originalEvent,text:'after!',seq:0}
  const changed = Buffer.concat([original.subarray(0,end+1),encodeFactBatch(first.batchId,header.journal.legacyPrefixDigest,[event]).bytes])
  expect(changed.length).toBe(original.length)
  await writeFile(path,changed)
  decodes.mockClear(); replays.mockClear()
  const evicted = await acquireManagedExecution(coordinator,'a')
  expect(evicted.observe().eventCount).toBe(1)
  expect(replays).not.toHaveBeenCalled()
  const writer = await acquireManagedExecution(coordinator,'b')
  expect(writer.observe().eventCount).toBe(1)
  expect((await coordinator.readHistoryPage!('b',tail))?.events).toEqual([event])
  expect(replays).toHaveBeenCalledTimes(1)
  expect(replays.mock.results[0]?.value).toBeUndefined()
  expect(decodes).toHaveBeenCalledTimes(2)
}))

it('declines replay after a same-length header-only change even though the body is still exact', async () => withHistory(async ({coordinator, root}) => {
  await afterDecodedPreparationExpires(async () => { expect(await coordinator.readHistoryPage!('a',tail)).toBeDefined() })
  const path = join(root,'a.jsonl'), original = await readFile(path), end = original.indexOf(10)
  const line = original.subarray(0,end+1).toString('utf8')
  const header = line.replace(/"createdAt":"\d{4}/,'"createdAt":"2001')
  expect(header).not.toBe(line)
  expect(Buffer.byteLength(header)).toBe(end+1)
  await writeFile(path,Buffer.concat([Buffer.from(header),original.subarray(end+1)]))
  decodes.mockClear(); replays.mockClear()
  const writer = await acquireManagedExecution(coordinator,'a')
  expect(writer.observe().eventCount).toBe(1)
  expect((await coordinator.profile('a')).meta.createdAt).toMatch(/^2001-/)
  expect(replays).not.toHaveBeenCalled()
  expect(decodes).toHaveBeenCalledTimes(1)
}))

it('keeps the original torn-tail recovery after a verified page is already cached', async () => withHistory(async ({coordinator, root}) => {
  await afterDecodedPreparationExpires(async () => { expect(await coordinator.readHistoryPage!('a',tail)).toBeDefined() })
  const path = join(root,'a.jsonl'), original = await readFile(path)
  await appendFile(path,'{"unfinished":')
  replays.mockClear()
  const writer = await acquireManagedExecution(coordinator,'a')
  expect(writer.observe().eventCount).toBe(1)
  expect(await readFile(path)).toEqual(original)
  expect(replays).not.toHaveBeenCalled()
}))

it('preserves the original refusal for a corrupt complete frame behind cached framing', async () => withHistory(async ({coordinator, root}) => {
  await afterDecodedPreparationExpires(async () => { expect(await coordinator.readHistoryPage!('a',tail)).toBeDefined() })
  const path = join(root,'a.jsonl'), original = await readFile(path)
  const changed = Buffer.from(original.toString('utf8').replace('"text":"before"','"text":"broken"'))
  expect(changed.length).toBe(original.length)
  expect(changed).not.toEqual(original)
  await writeFile(path,changed)
  decodes.mockClear(); replays.mockClear()
  await expect(acquireManagedExecution(coordinator,'a')).rejects.toThrow('TASK_TRANSITION_FAILED')
  expect(replays).toHaveBeenCalledTimes(1)
  expect(replays.mock.results[0]?.value).toBeUndefined()
  expect(decodes).toHaveBeenCalledTimes(1)
  expect(await readFile(path)).toEqual(changed)
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
