import { expect, it } from 'vitest'
import type { ExecCommand, ExecResult, ExecService } from '@i-harness/exec'
import { createWorkflowJobStore, runWorkflowIn } from '../src/runner.ts'
import type { WorkflowDefinition } from '../src/definition.ts'

const definition = (): WorkflowDefinition => ({ name: 'chatty', description: 'chatty', steps: [{ name: 'one', command: 'echo hi' }] })
const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0, timedOut: false }
const service = (run: (command: ExecCommand) => Promise<ExecResult>) => ({ run }) as unknown as ExecService

it('caps a workflow job stdout and says the output was truncated (A-07)', async () => {
  const jobs = createWorkflowJobStore(), exec = service(async () => ({ ...ok, stdout: 'x'.repeat(1_500_000) }))
  const handle = runWorkflowIn(definition(), {}, exec, jobs)
  expect((await handle.join()).kind).toBe('loop-finished')
  const view = jobs.view(handle.jobId)
  expect(view.stdout.length).toBeLessThan(1_100_000)
  expect(view.stdout).toContain('workflow output truncated')
})

it('caps a failed step stderr', async () => {
  const jobs = createWorkflowJobStore(), exec = service(async () => ({ ...ok, exitCode: 1, stderr: 'e'.repeat(1_500_000) }))
  const handle = runWorkflowIn(definition(), {}, exec, jobs)
  await handle.join()
  const view = jobs.view(handle.jobId)
  expect(view.stderr.length).toBeLessThan(1_100_000)
  expect(view.stderr).toContain('workflow output truncated')
})

it('leaves output below the cap untouched', async () => {
  const jobs = createWorkflowJobStore(), exec = service(async () => ({ ...ok, stdout: 'small output' }))
  const handle = runWorkflowIn(definition(), {}, exec, jobs)
  await handle.join()
  const view = jobs.view(handle.jobId)
  expect(view.stdout).toContain('small output')
  expect(view.stdout).not.toContain('truncated')
})
