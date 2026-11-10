import { afterEach, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({
  armed: false,
  refreshes: 0,
  held: false,
  staged: false,
  strictAfterRelease: false,
  writerAction: undefined as object | undefined,
  stage: undefined as undefined | (() => Promise<void>),
  refused: undefined as undefined | ((error: unknown) => void),
}))
vi.mock('../../core-agent/src/agent/generation-request-lease.ts', async load => {
  const original = await load<typeof import('../../core-agent/src/agent/generation-request-lease.ts')>()
  return { ...original, generationRequestLease(control: Parameters<typeof original.generationRequestLease>[0], refresh: Parameters<typeof original.generationRequestLease>[1]) {
    return original.generationRequestLease(control, async () => {
      const valid = await refresh()
      if (valid && (probe.armed || probe.staged)) probe.refreshes++
      if (valid && probe.armed && probe.refreshes === 2) {
        probe.armed = false
        await probe.stage!()
      }
      return valid
    })
  } }
})
vi.mock('@i-harness/core-session/internal/execution', async load => {
  const original = await load<typeof import('@i-harness/core-session/internal/execution')>()
  return { ...original, assertManagedActionCurrent(...args: Parameters<typeof original.assertManagedActionCurrent>) {
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 50
    try {
      const result = original.assertManagedActionCurrent(...args)
      if (probe.staged && !probe.held && args[1] !== probe.writerAction) probe.strictAfterRelease = true
      return result
    }
    catch (error) {
      if (probe.held && args[1] !== probe.writerAction) probe.refused?.(error)
      throw error
    } finally { Error.stackTraceLimit = limit }
  } }
})

import { mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeFactBatch } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createExecutorExecutionCache } from '../src/durable-session.ts'
import { createManagedExecutionRuntime } from '../src/managed-assembly.ts'
import { controlledModel } from './controlled-model.ts'
import { completeCheckpoint } from '../../compaction/test/fixtures/checkpoint.ts'

afterEach(() => {
  probe.armed = false; probe.refreshes = 0; probe.held = false
  probe.staged = false; probe.strictAfterRelease = false
  probe.writerAction = undefined; probe.stage = undefined; probe.refused = undefined
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-summary-physical-admission-'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const backend = createJsonlBackend(join(root, 'sessions'), {
    wrapOwnedBatch: original => async (...args) => {
      const held = decodeFactBatch(args[3].bytes).events.some(event => event.type === 'session/title' && event.title === 'HELD_STAGED_WRITER')
      if (held) { probe.held = true; probe.staged = true; entered.resolve(); await release.promise; probe.held = false }
      return original(...args)
    },
  })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'main' })
  const cache = createExecutorExecutionCache({ coordinator }), entry = await cache.get('main')
  const summarySent = Promise.withResolvers<void>()
  let summaries = 0
  const model = controlledModel(async function* () { yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' } })
  const summarizer = controlledModel(async function* () {
    if (probe.staged) {
      expect(probe.held).toBe(false)
      expect(probe.strictAfterRelease).toBe(true)
      expect(probe.refreshes).toBeGreaterThan(2)
    }
    summaries++; summarySent.resolve()
    yield { type: 'text/chunk', text: completeCheckpoint() }; yield { type: 'end' }
  })
  const runtime = createManagedExecutionRuntime({ execution: entry.execution, model, systemPrompt: 'system', tools: [], contextWindow: 100000, compact: { auto: false, summarizationModel: summarizer, minSummaryChars: 1 } })
  for (const [inputId, text] of [['first', 'Original work '.repeat(300)], ['second', 'Continue']] as const) {
    await entry.inputs.inbox.admit({ inputId, text, delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'summary-fixture' } })
    await runtime.lane.runAdmitted(inputId)
  }
  return { entry, runtime, entered, release, summarySent, summaries: () => summaries, async close() {
    probe.armed = false; release.resolve()
    await runtime.close(); await cache.closeAll(); await coordinator.close()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-summary-physical-admission-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  } }
}

it('refuses a physical summary when another original write stages after the last reservation refresh', async () => {
  const f = await fixture(), refused = Promise.withResolvers<unknown>()
  const writer = f.entry.execution.owner.beginAction()
  probe.writerAction = writer
  let writing: ReturnType<ReturnType<NonNullable<typeof writer.captureMetadata>>['admit']> | undefined
  let compacting: Promise<unknown> | undefined
  probe.refused = refused.resolve
  probe.stage = async () => {
    writing = writer.captureMetadata!({ type: 'session/title', title: 'HELD_STAGED_WRITER', source: 'user', messageSeqs: [] }).admit()
    void writing.catch(() => {})
    await f.entered.promise
  }
  probe.refreshes = 0; probe.armed = true
  try {
    compacting = f.runtime.agent.compact().then(result => ({ result }), error => ({ error }))
    const stage = await Promise.race([f.entered.promise.then(() => 'staged'), compacting.then(() => 'returned-before-stage')])
    expect(stage).toBe('staged')
    const decision = await Promise.race([
      refused.promise.then(error => ({ kind: 'refused', error })),
      f.summarySent.promise.then(() => ({ kind: 'sent' })),
      compacting.then(() => ({ kind: 'returned-without-guard' })),
    ])
    expect(decision).toMatchObject({ kind: 'refused', error: { code: 'FACT_RECOVERY_REQUIRED' } })
    if ('error' in decision) expect((decision.error as Error).stack).toContain('generation-action.ts')
    expect(f.summaries()).toBe(0)
    f.release.resolve(); await writing; await compacting
    expect(f.summaries()).toBe(1)
  } finally { f.release.resolve(); await writing?.catch(() => {}); await compacting; writer.finish(); await f.close() }
}, 30_000)

it('keeps normal current managed compaction able to issue one original physical summary', async () => {
  const f = await fixture()
  try {
    expect((await f.runtime.agent.compact()).publication).toBe('committed')
    expect(f.summaries()).toBe(1)
  } finally { await f.close() }
}, 30_000)
