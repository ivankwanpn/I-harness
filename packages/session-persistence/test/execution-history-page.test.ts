import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { encodeFactBatch, factPrefixDigest, readFactJournal, type JournalMetadata } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireManagedExecution } from '../src/execution-internal.ts'

const probe = vi.hoisted(() => ({
  beforeClose: undefined as (() => Promise<void>) | undefined,
  afterColdWindow: undefined as ((found: boolean) => Promise<void>) | undefined,
}))
vi.mock('../src/execution-internal.ts', async load => {
  const original = await load<typeof import('../src/execution-internal.ts')>()
  return {
    ...original,
    associateExecutionDependencies(backend: object, open: Parameters<typeof original.associateExecutionDependencies>[1]) {
      original.associateExecutionDependencies(backend, (...args) => {
        const scope = open(...args)
        return Object.freeze({
          assertCurrent: scope.assertCurrent.bind(scope),
          readEvent: scope.readEvent.bind(scope),
          ...(scope.readEvents ? { readEvents: scope.readEvents.bind(scope) } : {}),
          async close() {
            const gate = probe.beforeClose
            probe.beforeClose = undefined
            await gate?.()
            await scope.close()
          },
        })
      })
    },
  }
})
vi.mock('../src/archive-read-internal.ts', async load => {
  const original = await load<typeof import('../src/archive-read-internal.ts')>()
  return {
    ...original,
    associateColdArchiveHistoryReader(backend: object, reader: import('../src/archive-read-internal.ts').ColdArchiveHistoryReader) {
      original.associateColdArchiveHistoryReader(backend, {
        readFull: reader.readFull.bind(reader),
        async readWindow(...args) {
          const gate = probe.afterColdWindow
          probe.afterColdWindow = undefined
          const records = await reader.readWindow(...args)
          await gate?.(records !== undefined)
          return records
        },
      })
    },
  }
})

const coordinators: ReturnType<typeof composeJsonlTaskTransitionCoordinator>[] = []
afterEach(async () => {
  probe.beforeClose = undefined
  probe.afterColdWindow = undefined
  for (const coordinator of coordinators.splice(0)) await coordinator.close()
})

const latestPage = { afterSeq: 0, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 40 }

async function fixture(options?: Parameters<typeof createJsonlBackend>[1]) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'execution-history-'))
  const backend = createJsonlBackend(root, options)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  coordinators.push(coordinator)
  await coordinator.create({ sessionId: 'owner' })
  await coordinator.append('owner', [
    { type: 'turn/start' },
    { type: 'user/message', text: 'original question' },
    { type: 'assistant/message', text: 'original reply' },
    { type: 'turn/end' },
  ])
  return { coordinator, root }
}

it('reads a bounded page from an attached execution without installing a complete view', async () => {
  const { coordinator } = await fixture()
  const pageOptions = { afterSeq: 0, beforeSeq: 3, limit: 1, includeTurns: true }
  expect(await coordinator.readHistoryPage!('missing', pageOptions)).toBeUndefined()
  expect(await coordinator.readHistoryPage!('owner', pageOptions)).toBeUndefined()
  const execution = await acquireManagedExecution(coordinator, 'owner')
  const page = await coordinator.readHistoryPage!('owner', pageOptions)
  expect(page).toMatchObject({
    startSeq: 2, nextSeq: 3, headSeq: 4,
    events: [{ type: 'assistant/message', seq: 2, text: 'original reply' }],
    turns: [{ startSeq: 0, endSeq: 3 }],
  })
  expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
})

it('enrolls only a history snapshot and requalifies after the cold journal grows', async () => {
  const { coordinator } = await fixture()
  const inside = { afterSeq: 0, beforeSeq: 3, limit: 1, includeTurns: true }
  await coordinator.snapshot!('owner')
  expect(await coordinator.readHistoryPage!('owner', inside)).toBeUndefined()

  await coordinator.snapshot!('owner', { prepareHistoryPages: true })
  const cold = await coordinator.readHistoryPage!('owner', inside)
  expect(cold).toMatchObject({ startSeq: 2, nextSeq: 3, headSeq: 4,
    events: [{ type: 'assistant/message', seq: 2, text: 'original reply' }],
    turns: [{ startSeq: 0, endSeq: 3 }],
  })
  expect(await coordinator.hasManagedDocument!('owner')).toBe(false)

  await coordinator.append('owner', [{ type: 'plan/mode', mode: 'on' }])
  expect(await coordinator.readHistoryPage!('owner', latestPage)).toBeUndefined()
  await coordinator.snapshot!('owner', { prepareHistoryPages: true })
  expect(await coordinator.readHistoryPage!('owner', latestPage)).toMatchObject({ headSeq: 5,
    events: expect.arrayContaining([{ type: 'plan/mode', seq: 4, mode: 'on' }]),
  })

  await acquireManagedExecution(coordinator, 'owner')
  expect(await coordinator.readHistoryPage!('owner', inside)).toEqual({ ...cold, headSeq: 5 })
})

it('keeps recent cold sessions and evicts the least recently used proof on the third enrollment', async () => {
  const { coordinator, root } = await fixture()
  const path = join(root, 'owner.jsonl')
  const original = await readFile(path)
  const newline = original.indexOf(10)
  const header = JSON.parse(original.subarray(0, newline).toString('utf8')) as { formatVersion: number; journal: JournalMetadata }
  let { prefixDigest, eventCount } = readFactJournal(original.subarray(newline + 1), header.journal, header.formatVersion).prefix
  const frames: Uint8Array[] = []
  const text = 'long reply '.repeat(42)
  for (let i = 0; i < 100; i++) {
    const events = Array.from({ length: 94 }, (_, offset) => ({
      type: 'assistant/message' as const, seq: eventCount + offset, text,
    }))
    const frame = encodeFactBatch(`many-events-${i}`, prefixDigest, events)
    frames.push(frame.bytes)
    prefixDigest = factPrefixDigest(prefixDigest, frame.key.batchDigest)
    eventCount += events.length
  }
  await appendFile(path, Buffer.concat(frames))
  for (const sessionId of ['small', 'third']) {
    await coordinator.create({ sessionId })
    await coordinator.append(sessionId, [{ type: 'user/message', text: sessionId }])
  }
  const tail = { afterSeq: 0, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 1 }
  await coordinator.snapshot!('owner', { prepareHistoryPages: true })
  await coordinator.snapshot!('small', { prepareHistoryPages: true })
  expect(await coordinator.readHistoryPage!('small', tail)).toMatchObject({
    headSeq: 1, events: [{ type: 'user/message', text: 'small' }],
  })
  const longPage = await coordinator.readHistoryPage!('owner', tail)
  expect(longPage).toMatchObject({ headSeq: eventCount, events: [{ seq: eventCount - 1, text }] })
  await coordinator.snapshot!('third', { prepareHistoryPages: true })
  expect(await coordinator.readHistoryPage!('small', tail)).toBeUndefined()
  expect(await coordinator.readHistoryPage!('owner', tail)).toEqual(longPage)
  expect(await coordinator.readHistoryPage!('third', tail)).toMatchObject({
    headSeq: 1, events: [{ type: 'user/message', text: 'third' }],
  })
  await coordinator.close()
  await expect(coordinator.readHistoryPage!('owner', tail)).rejects.toThrow()
  await expect(coordinator.readHistoryPage!('third', tail)).rejects.toThrow()
})

it('does not let an older failed window discard a newly qualified proof or a different session', async () => {
  const { coordinator } = await fixture()
  await coordinator.create({ sessionId: 'sibling' })
  await coordinator.append('sibling', [{ type: 'user/message', text: 'sibling' }])
  await coordinator.snapshot!('owner', { prepareHistoryPages: true })
  await coordinator.snapshot!('sibling', { prepareHistoryPages: true })
  await coordinator.append('owner', [{ type: 'plan/mode', mode: 'on' }])
  const entered = Promise.withResolvers<boolean>(), release = Promise.withResolvers<void>()
  probe.afterColdWindow = async found => { entered.resolve(found); await release.promise }
  const stale = coordinator.readHistoryPage!('owner', latestPage)
  try {
    const observed = await Promise.race([entered.promise, stale.then(() => 'read completed without original window')])
    expect(observed).toBe(false)
    await coordinator.snapshot!('owner', { prepareHistoryPages: true })
  } finally {
    release.resolve()
    await stale
  }
  expect(await stale).toBeUndefined()
  expect(await coordinator.readHistoryPage!('owner', latestPage)).toMatchObject({ headSeq: 5 })
  expect(await coordinator.readHistoryPage!('sibling', latestPage)).toMatchObject({ headSeq: 1 })
})

it('lets repaired cold history replace a snapshot with an unresolved image address', async () => {
  const { coordinator, root } = await fixture()
  const path = join(root, 'owner.jsonl')
  const original = await readFile(path)
  const newline = original.indexOf(10)
  const header = JSON.parse(original.subarray(0, newline).toString('utf8')) as { formatVersion: number; journal: JournalMetadata }
  const { prefix } = readFactJournal(original.subarray(newline + 1), header.journal, header.formatVersion)
  const frame = encodeFactBatch('unresolved-image-fixture', prefix.prefixDigest,
    [{ type: 'user/message', seq: prefix.eventCount, text: 'old image reference', imageInputId: 'missing' }])
  await appendFile(path, frame.bytes)
  expect((await coordinator.snapshot!('owner', { prepareHistoryPages: true })).session.events).toHaveLength(5)

  await writeFile(path, original)
  const page = { afterSeq: 4, limit: 1 }
  expect(await coordinator.readHistoryPage!('owner', page)).toBeUndefined()
  expect((await coordinator.snapshot!('owner', { prepareHistoryPages: true })).session.events).toHaveLength(4)
})

it('loads image proof from the original admission that precedes the page', async () => {
  const { coordinator } = await fixture()
  const execution = await acquireManagedExecution(coordinator, 'owner')
  const action = execution.owner.beginAction()
  const image = { mediaType: 'image/png' as const, dataBase64: 'AQID' }
  let messageSeq: number
  try {
    const admitted = await action.facts.inputs.admit({
      type: 'agent/input/admitted', version: 1, inputId: 'photo', text: 'inspect it',
      delivery: 'queue', intent: 'user', images: [image],
    })
    const started = await action.facts.inputs.start(
      { type: 'agent/input/promoted', version: 1, inputId: 'photo' },
      { type: 'user/message', text: 'inspect it', input: { inputId: 'photo', intent: 'user' }, imageInputId: 'photo' },
    )
    expect(admitted.kind).toBe('committed')
    if (started.kind !== 'committed') throw Error('Original input promotion did not commit')
    messageSeq = started.seqs.at(-1)!
    const page = await coordinator.readHistoryPage!('owner', { afterSeq: messageSeq, limit: 1 })
    expect(page?.events).toMatchObject([{ type: 'user/message', seq: messageSeq, imageInputId: 'photo' }])
    expect([...page!.images]).toEqual([[messageSeq, [image]]])
    expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
  } finally {
    action.finish()
  }
  await coordinator.releaseOwnership('owner')
  expect(await coordinator.hasManagedDocument!('owner')).toBe(false)
  await coordinator.snapshot!('owner', { prepareHistoryPages: true })
  const cold = await coordinator.readHistoryPage!('owner', { afterSeq: messageSeq, limit: 1 })
  expect(cold?.events).toMatchObject([{ type: 'user/message', seq: messageSeq, imageInputId: 'photo' }])
  expect([...cold!.images]).toEqual([[messageSeq, [image]]])
})

it('keeps a page on the committed prefix while the writer prepares its next ACK', async () => {
  const { coordinator } = await fixture()
  const execution = await acquireManagedExecution(coordinator, 'owner')
  const action = execution.owner.beginAction()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  probe.beforeClose = async () => { entered.resolve(); await release.promise }
  const writing = action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })
  try {
    await entered.promise
    const page = await coordinator.readHistoryPage!('owner', latestPage)
    expect(page?.headSeq).toBe(4)
    expect(page?.events.at(-1)).toMatchObject({ type: 'turn/end', seq: 3 })
    expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
    release.resolve()
    expect(await writing).toMatchObject({ kind: 'committed', seqs: [4] })
    const next = await coordinator.readHistoryPage!('owner', latestPage)
    expect(next?.headSeq).toBe(5)
    expect(next?.events.at(-1)).toMatchObject({ type: 'plan/mode', seq: 4 })
  } finally {
    release.resolve()
    await writing
    action.finish()
  }
})

it('refuses history while an issued outcome is unknown and reads it after exact reconciliation', async () => {
  let withholdAck = false
  const { coordinator } = await fixture({
    wrapOwnedBatch: append => async (...args) => {
      const outcome = await append(...args)
      if (withholdAck && outcome.kind === 'committed') return { kind: 'unknown', key: args[3].key }
      return outcome
    },
  })
  const execution = await acquireManagedExecution(coordinator, 'owner')
  const action = execution.owner.beginAction()
  const captured = action.captureMetadata!({ type: 'plan/mode', mode: 'on' })
  try {
    withholdAck = true
    expect(await captured.admit()).toMatchObject({ kind: 'unknown' })
    await expect(coordinator.readHistoryPage!('owner', latestPage)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    withholdAck = false
    expect(await captured.reconcile()).toMatchObject({ kind: 'committed', seqs: [4] })
    const page = await coordinator.readHistoryPage!('owner', latestPage)
    expect(page?.events.filter(event => event.type === 'plan/mode')).toMatchObject([{ seq: 4, mode: 'on' }])
    expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
  } finally {
    withholdAck = false
    action.finish()
  }
})
