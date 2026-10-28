import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, resultExecution } from '@i-harness/core-tools'
import { createSession } from '@i-harness/core-session'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createMockClient } from '@i-harness/llm-mock'
import { nativeFixture } from '../../exec/test/native-fixture.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createRoleRegistry } from '../src/roles.ts'
import { createTaskRegistry } from '../src/task-protocol.ts'
import { createSubagentTools } from '../src/tools.ts'

it('actual registered job output/list/wait and kill tools keep observation/control success for failed and canceled jobs', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx), session = createSession(), f = nativeFixture({ liveTree: true })
  const jobs = createJobRegistry()
  const failed = jobs.registerJob('root', 'subagent', 'failed'); jobs.updateJob(failed.id, { status: 'error', output: 'original failure' })
  const canceled = jobs.registerJob('root', 'subagent', 'canceled'); jobs.updateJob(canceled.id, { status: 'killed', output: 'original cancellation' })
  for (const tool of createSubagentTools({ table: createAgentTable(), jobs, roles: createRoleRegistry(), tasks: createTaskRegistry(), agents: createAgentRegistry(), parentRegistry: registry,
    parentSession: session, parentCtx: ctx, parentModel: createMockClient([]), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused fixture' }), exec: f.exec })) registry.register(tool)
  async function invoke(name: string, args: object) {
    const call = await registry.prepare({ name, args })
    const output = await registry.dispatch(call); await registry.finalize(call, output)
    expect(resultExecution(call)).toEqual({ outcome: 'succeeded', dispatch: 'dispatched' })
    return output
  }
  try {
    expect(await invoke('job_output', { job_id: failed.id, wait: true })).toMatchObject({ status: 'error', text: expect.stringContaining('original failure') })
    expect(await invoke('job_output', { job_id: canceled.id, wait: true })).toMatchObject({ status: 'killed', text: expect.stringContaining('original cancellation') })
    expect(await invoke('job_list', {})).toMatchObject({ jobs: [expect.objectContaining({ status: 'error' }), expect.objectContaining({ status: 'killed' })] })
    const { jobId } = await f.exec.runBackground({ argv: ['fixture'] })
    expect(await invoke('job_kill', { job_id: jobId })).toEqual({ outcome: 'cancellation-requested' })
    expect(await invoke('job_output', { job_id: jobId, wait: true })).toMatchObject({ status: 'killed' })
    expect(f.counts()).toEqual({ launches: 1, terminations: 1, releases: 1 })
  } finally { f.finish(); await f.exec.dispose() }
})

it('routes an explicitly selected shell job to the genuine native service despite a child id collision', async () => {
  const { registerExec } = await import('@i-harness/exec')
  const { createJobKillTool } = await import('../src/tools/cancel.ts')
  const exec = registerExec(createContext())
  const submitted = await exec.runBackground({ argv: [process.execPath, '-e', 'setTimeout(()=>{}, 5000)'] })
  let childCancelled = false
  const tool = createJobKillTool({ exec, jobs: { kill: () => { childCancelled = true; return 'cancellation-requested' } } } as never)
  try {
    const result = await tool.execute({ job_id: submitted.jobId, backend: 'shell', instance_id: submitted.nativeJob.instanceId }, {} as never)
    expect(result).toEqual({ outcome: 'cancellation-requested' })
    expect(childCancelled).toBe(false)
  } finally { await exec.dispose() }
})