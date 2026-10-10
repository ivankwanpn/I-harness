import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createCodeRetrievalTools } from '@i-harness/code-retrieval'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { createNativeContextRuntime } from '../src/context-runtime.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation() })

it.each([
  { sourceIds: ['workspace'], force: false }, { sourceIds: [], force: false },
  { sourceIds: ['workspace'], force: true }, { sourceIds: [], force: true },
])('refuses foreign index management for subset $sourceIds and force=$force', async ({ sourceIds, force }) => {
  const base = resolve('build/shared-index-authorization'); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'fixture-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'repo'), outside = join(root, 'outside'); await mkdir(workspace); await mkdir(outside)
  await writeFile(join(workspace, 'main.ts'), 'export const admitted = true\n')
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions'))); cleanup.push(() => coordinator.close())
  for (const sessionId of ['allowed', 'unavailable']) await coordinator.create({ sessionId })
  let release!: () => void, entered!: () => void, unavailableScopeChecks = 0
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  let hold = true
  let sessions: ReturnType<typeof createSessionService>
  const runtime = await createNativeContextRuntime({ workspace, storageRoot: join(root, 'native-context'), coordinator, codeConfig: { enabled: true },
    projectFor: async actor => {
      if (actor === 'allowed' && hold) { entered(); await gate }
      if (actor === 'unavailable') unavailableScopeChecks++
      const roots = actor === 'unavailable' ? [outside] : [workspace]
      return { projectId: actor, scope: { id: actor, name: actor, roots, primaryRoot: roots[0]! } }
    },
    registerJob: (access, job) => sessions.liveAssembly(access.sessionId)!.registerBackgroundJob!({ id: job.jobId, kind: 'code-context', label: 'Index sources', cancel: job.cancel }),
  }); cleanup.push(() => runtime.close())
  sessions = createSessionService({ workspace, coordinator, modelPolicy: 'test-mock', sandbox: 'read-only', approveAll: true, additionalTools: createCodeRetrievalTools(runtime.codeRetrieval) })
  cleanup.push(() => sessions.close())
  const allowed = await sessions.assemblyFor('allowed'), unavailable = await sessions.assemblyFor('unavailable')
  const { jobId } = await runtime.codeRetrieval.startIndex({ sessionId: 'allowed' }); await started
  let settled = false
  const joining = runtime.codeRetrieval.startIndex({ sessionId: 'unavailable' }, { sourceIds, force }).then(result => { settled = true; return { result } }, error => { settled = true; return { error } })
  try {
    // Observe admission/control before freeing A. A force regression otherwise
    // waits for A's real held IO and could strand fixture cleanup.
    await vi.waitFor(() => expect(settled || unavailableScopeChecks > 0 || runtime.codeRetrieval.status().state === 'stopping').toBe(true))
    hold = false; release()
    const outcome = await joining
    expect(outcome).toHaveProperty('error')
    expect((outcome as { error: Error }).error.message).toMatch(/unavailable|unauthorized/i)
    expect(unavailableScopeChecks).toBeGreaterThan(0)
    const listed = await unavailable.tools.execute({ name: 'job_list', args: {} })
    expect((listed.output as { jobs: { id: string }[] }).jobs.some(job => job.id === jobId)).toBe(false)
    await expect(unavailable.tools.execute({ name: 'job_kill', args: { job_id: jobId } })).rejects.toThrow(/unknown job/i)
  } finally { hold = false; release(); await runtime.codeRetrieval.wait(jobId) }
  expect(runtime.codeRetrieval.status().lastJob).toMatchObject({ jobId, outcome: 'completed' })
  expect((await allowed.tools.execute({ name: 'job_list', args: {} })).output).toMatchObject({ jobs: [expect.objectContaining({ id: jobId, status: 'completed' })] })
}, 15000)
