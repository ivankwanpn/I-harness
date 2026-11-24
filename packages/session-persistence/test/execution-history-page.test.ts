import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireManagedExecution } from '../src/execution-internal.ts'

const probe = vi.hoisted(() => ({
  beforeClose: undefined as (() => Promise<void>) | undefined,
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

const coordinators: ReturnType<typeof composeJsonlTaskTransitionCoordinator>[] = []
afterEach(async () => {
  probe.beforeClose = undefined
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
  return { coordinator }
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

it('loads image proof from the original admission that precedes the page', async () => {
  const { coordinator } = await fixture()
  const execution = await acquireManagedExecution(coordinator, 'owner')
  const action = execution.owner.beginAction()
  const image = { mediaType: 'image/png' as const, dataBase64: 'AQID' }
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
    const messageSeq = started.seqs.at(-1)!
    const page = await coordinator.readHistoryPage!('owner', { afterSeq: messageSeq, limit: 1 })
    expect(page?.events).toMatchObject([{ type: 'user/message', seq: messageSeq, imageInputId: 'photo' }])
    expect([...page!.images]).toEqual([[messageSeq, [image]]])
    expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
  } finally {
    action.finish()
  }
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
