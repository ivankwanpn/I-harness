import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { createScheduleFoldSink } from '@i-harness/schedule'
import type { SessionEvent } from '@i-harness/core-session'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { prepareOriginalManagedRuntime } from '../src/host-managed-execution.ts'
import { createSessionService } from '../src/service.ts'
import { controlledModel } from './controlled-model.ts'

const measured = vi.hoisted(() => ({ reads: 0 }))
vi.mock('@i-harness/schedule/driver', async load => {
  const actual = await load<typeof import('@i-harness/schedule/driver')>()
  return { ...actual, createScheduleDriver(options: Parameters<typeof actual.createScheduleDriver>[0]) {
    const original = options.original
    if (!original) return actual.createScheduleDriver(options)
    return actual.createScheduleDriver({ ...options, original(id) { measured.reads++; return original(id) } })
  } }
})

it('rearms the owned driver only for committed schedule changes, keeping independent fact readiness cheap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-schedule-ready-work-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true }, originalExecutionFoldFactory: createScheduleFoldSink }, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator, contextWindow: 32_000, maxOutputTokens: 128,
    model: controlledModel(async function* () { yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' } }),
    managedRuntime: { systemPrompt: 'system', tools: [], originalSchedule: true },
  })
  try {
    await coordinator.create({ sessionId: 'main' })
    await service.submit('main', 'normal foreground turn', new AbortController().signal)
    const runtime = (await prepareOriginalManagedRuntime(service, 'main'))!
    const commit = async (event: Extract<SessionEvent, { type: 'plan/mode' | 'schedule/change' }>) => {
      const action = runtime.execution.owner.beginAction()
      try { expect((await action.facts.metadata.admit(event)).kind).toBe('committed') }
      finally { action.finish() }
      await turn()
    }
    const initialReads = measured.reads
    expect(initialReads).toBeGreaterThan(0)
    await commit({ type: 'plan/mode', mode: 'on' })
    expect(measured.reads).toBe(initialReads)
    const id = 'schedule-1'
    await commit({ type: 'schedule/change', version: 1, operation: 'create', schedule: { id, kind: 'after', prompt: 'fixture', afterSeconds: 30, scheduledAt: new Date(Date.now() + 30_000).toISOString() } })
    expect(measured.reads).toBe(initialReads + 2)
    expect(service.inspectActivity!('main').active).toBe(true)
    await commit({ type: 'plan/mode', mode: 'off' })
    expect(measured.reads).toBe(initialReads + 2)
    await commit({ type: 'schedule/change', version: 1, operation: 'delete', id })
    expect(measured.reads).toBe(initialReads + 4)
    expect(service.inspectActivity!('main').active).toBe(false)
  } finally { try { await service.close() } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}, 30_000)
