import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ContextBindingMetadata } from '@i-harness/core-session'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createExecutorExecutionCache } from '../src/durable-session.ts'
import { createManagedExecutionRuntime } from '../src/managed-assembly.ts'
import { controlledModel } from './controlled-model.ts'

const journal = vi.hoisted(() => ({
  gate: undefined as undefined | { entered(): void; resume: Promise<void> },
}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts', async load => {
  const real = await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
  return { ...real, createFactJournalBackend(...args: Parameters<typeof real.createFactJournalBackend>) {
    const backend = real.createFactJournalBackend(...args)
    return { ...backend, async appendOwnedBatch(...args: Parameters<typeof backend.appendOwnedBatch>) {
      const result = await backend.appendOwnedBatch(...args)
      const gate = journal.gate
      if (gate && result.kind === 'committed') {
        journal.gate = undefined
        gate.entered()
        await gate.resume
        return { kind: 'unknown' as const, key: args[3].key }
      }
      return result
    } }
  } }
})

it('observes the original Task binding during a live append and refuses the same write if its receipt becomes uncertain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-model-binding-read-'))
  const backend = createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' })
  const cache = createExecutorExecutionCache({ coordinator }), { execution } = await cache.get('parent')
  const model = controlledModel(async function* () { yield { type: 'end' } })
  const metadata: ContextBindingMetadata = { version: 1, providerId: 'fixture', modelId: 'parent-model', protocol: 'openai-responses',
    contextWindow: 12_000, maxOutputTokens: 600, identityCoverage: 'complete' }
  let retireDuringRead = false
  const runtime = createManagedExecutionRuntime({ execution, model, systemPrompt: 'original', tools: [],
    contextWindow: 12_000, maxOutputTokens: 600, contextMetadata() {
      if (retireDuringRead) execution.revokeNewWork()
      return metadata
    } })
  const action = execution.owner.beginAction()
  const title = action.captureMetadata!({ type: 'session/title', title: 'Concurrent parent append', source: 'user', messageSeqs: [] })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  journal.gate = { entered: entered.resolve, resume: release.promise }
  const append = title.admit()
  try {
    await entered.promise
    expect(() => runtime.selectedModelBinding()).toThrow('Original issued write needs reconciliation')
    const observed = runtime.committedTaskModelBinding()
    expect(observed.model).toBe(model)
    expect(observed).toMatchObject({ contextWindow: 12_000, maxOutputTokens: 600, contextMetadata: metadata })
    expect(() => ({ ...runtime }).committedTaskModelBinding()).toThrow('Original open managed runtime required')

    release.resolve()
    expect((await append).kind).toBe('unknown')
    expect(() => runtime.committedTaskModelBinding()).toThrow(expect.objectContaining({ code: 'FACT_RECOVERY_REQUIRED' }))
    expect((await title.reconcile()).kind).toBe('committed')
    expect(runtime.committedTaskModelBinding()).toEqual(runtime.selectedModelBinding())

    retireDuringRead = true
    expect(() => runtime.committedTaskModelBinding()).toThrow(expect.objectContaining({ code: 'FACT_CLOSED' }))
    expect(() => runtime.selectedModelBinding()).toThrow(expect.objectContaining({ code: 'FACT_CLOSED' }))
  } finally {
    journal.gate = undefined
    release.resolve()
    const result = await append.catch(() => undefined)
    if (result?.kind === 'unknown') await title.reconcile().catch(() => {})
    action.finish()
    await runtime.close()
    await cache.closeAll()
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
