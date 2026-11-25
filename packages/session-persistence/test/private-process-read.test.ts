import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import type { ProcessReadObservation } from '../src/coordinator/process-read-owner.ts'
import { acquireManagedExecution } from '../src/execution-internal.ts'

const coordinators: ReturnType<typeof composeJsonlTaskTransitionCoordinator>[] = []
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close()
})

const options = { documentKeys: ['process-roles', 'unwritten'] }

async function fixture(backendOptions?: Parameters<typeof createJsonlBackend>[1]) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'private-process-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root, backendOptions), { lock: { enabled: true } }, taskDocumentStorageContract)
  coordinators.push(coordinator)
  await coordinator.create({ sessionId: 'source' })
  await coordinator.append('source', [{ type: 'user/message', text: 'original question' }])
  await coordinator.putDocument('process-roles', { title: 'original task' })
  const execution = await acquireManagedExecution(coordinator, 'source')
  expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
  return { coordinator, execution, root }
}

it('reads the private held archive and exact committed suffixes without installing a Session view', async () => {
  const { coordinator, execution } = await fixture()
  let escaped: ProcessReadObservation | undefined
  const privateRead = await coordinator.withProcessReadObservation!('source', options, async observation => {
    escaped = observation
    expect(observation.initial.session.events).toEqual([{ type: 'user/message', seq: 0, text: 'original question' }])
    expect(observation.initial.highWater).toBe(1)
    expect(observation.initial.documents.get('process-roles')).toEqual({ kind: 'present', value: { title: 'original task' } })
    expect(observation.initial.documents.get('unwritten')).toEqual({ kind: 'absent' })
    expect(Object.isFrozen(observation.initial.session.events[0])).toBe(true)
    expect(await observation.check()).toEqual({ kind: 'unchanged', highWater: 1 })
    const action = execution.owner.beginAction()
    try {
      expect((await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
      expect(await observation.check()).toEqual({ kind: 'suffix', from: 1, to: 2, events: [{ type: 'plan/mode', seq: 1, mode: 'on' }] })
      expect((await action.facts.metadata.admit({ type: 'plan/mode', mode: 'off' })).kind).toBe('committed')
    } finally { action.finish() }
    return observation.initial.session.events
  }, async (initial, observation, last) => {
    expect(last).toEqual({ kind: 'suffix', from: 2, to: 3, events: [{ type: 'plan/mode', seq: 2, mode: 'off' }] })
    observation.assertCurrent()
    return [...initial, { type: 'plan/mode', seq: 1, mode: 'on' }, ...(last.kind === 'suffix' ? last.events : [])]
  })
  expect(() => escaped!.assertCurrent()).toThrow()
  expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
  const ready = await coordinator.openManagedDocument('source')
  expect(ready).toBe(execution.owner)
  expect(Object.hasOwn(ready, 'view')).toBe(true)
  expect(await coordinator.withProcessReadObservation!('source', options,
    async observation => observation.initial.session.events, async (events, observation) => {
      observation.assertCurrent()
      return events
    })).toEqual(privateRead)
})

it('fences and retires a private observation after an observed auxiliary document changes', async () => {
  const { coordinator, execution } = await fixture()
  let published = false
  await expect(coordinator.withProcessReadObservation!('source', options, async observation => {
    await coordinator.putDocument('process-roles', { title: 'changed task' })
    await expect(observation.check()).rejects.toThrow()
    return 'stale'
  }, async value => { published = true; return value })).rejects.toThrow()
  expect(published).toBe(false)
  expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
  expect(await coordinator.withProcessReadObservation!('source', options,
    async observation => observation.initial.documents.get('process-roles'), async value => value))
    .toEqual({ kind: 'present', value: { title: 'changed task' } })
})

it('a closed private owner cannot publish after a replacement with the same committed prefix', async () => {
  const { coordinator, execution } = await fixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let published = false
  const reading = coordinator.withProcessReadObservation!('source', options, async observation => {
    entered.resolve()
    await release.promise
    observation.assertCurrent()
    return 'stale'
  }, async value => { published = true; return value })
  const refused = expect(reading).rejects.toThrow()
  try {
    await Promise.race([entered.promise, reading.then(() => { throw new Error('Private read completed without its work callback') })])
    await execution.close()
    const replacement = await acquireManagedExecution(coordinator, 'source')
    expect(replacement.owner).not.toBe(execution.owner)
    expect(await coordinator.withProcessReadObservation!('source', options,
      async observation => observation.initial.highWater, async value => value)).toBe(1)
    expect(Object.hasOwn(replacement.owner, 'view')).toBe(false)
  } finally { release.resolve(); await refused }
  expect(published).toBe(false)
})

it('does not expose an unacknowledged native append through Process', async () => {
  let withholdAck = false
  const { coordinator, execution } = await fixture({
    wrapOwnedBatch: append => async (...args) => {
      const outcome = await append(...args)
      return withholdAck && outcome.kind === 'committed' ? { kind: 'unknown', key: args[3].key } : outcome
    },
  })
  const action = execution.owner.beginAction()
  const captured = action.captureMetadata!({ type: 'plan/mode', mode: 'on' })
  try {
    withholdAck = true
    expect(await captured.admit()).toMatchObject({ kind: 'unknown' })
    let entered = false
    await expect(coordinator.withProcessReadObservation!('source', options,
      async () => { entered = true }, async value => value)).rejects.toThrow()
    expect(entered).toBe(false)
    withholdAck = false
    expect(await captured.reconcile()).toMatchObject({ kind: 'committed', seqs: [1] })
  } finally { withholdAck = false; action.finish() }
  expect(await coordinator.withProcessReadObservation!('source', options,
    async observation => observation.initial.session.events.at(-1), async value => value))
    .toEqual({ type: 'plan/mode', seq: 1, mode: 'on' })
  expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
})

it('refuses a torn private archive without repairing or otherwise changing its bytes', async () => {
  const { coordinator, execution, root } = await fixture()
  const path = join(root, 'source.jsonl')
  const original = await readFile(path)
  const tail = Buffer.from([0x7b, 0x22, 0xe9])
  await appendFile(path, tail)
  try {
    let entered = false
    await expect(coordinator.withProcessReadObservation!('source', options,
      async () => { entered = true }, async value => value)).rejects.toThrow()
    expect(entered).toBe(false)
    expect(await readFile(path)).toEqual(Buffer.concat([original, tail]))
    expect(Object.hasOwn(execution.owner, 'view')).toBe(false)
  } finally { await writeFile(path, original) }
})
