import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, resultExecution } from '@i-harness/core-tools'
import { createSession } from '@i-harness/core-session'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createMockClient } from '@i-harness/llm-mock'
import { nativeFixture } from '../../exec/test/native-fixture.ts'
import { createScopedExec } from '../../session-executor/src/scoped-exec.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createRoleRegistry } from '../src/roles.ts'
import { createTaskRegistry } from '../src/task-protocol.ts'
import { createSubagentTools } from '../src/tools.ts'

function fixture(legacy = false) {
  const ctx = createContext(), registry = createToolRegistry(ctx), session = createSession(), native = nativeFixture({ liveTree: true })
  const exec = createScopedExec(native.exec, process.cwd(), () => undefined), jobs = createJobRegistry()
  if (legacy) delete (exec as { supportsNativeJobKill?: true }).supportsNativeJobKill
  for (const tool of createSubagentTools({ table: createAgentTable(), jobs, roles: createRoleRegistry(), tasks: createTaskRegistry(), agents: createAgentRegistry(), parentRegistry: registry,
    parentSession: session, parentCtx: ctx, parentModel: createMockClient([]), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), exec })) registry.register(tool)
  async function invoke(args: object) {
    const call = await registry.prepare({ name: 'job_kill', args })
    const output = await registry.dispatch(call); await registry.finalize(call, output)
    return { output, execution: resultExecution(call) }
  }
  return { native, exec, jobs, invoke, async dispose() { native.finish(); await native.exec.dispose() } }
}

it('registered shell kill accepts the real scoped factory and leaves the same-id child running', async () => {
  const f = fixture()
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['fixture'] })
    f.jobs.registerJob('root', 'subagent', 'collision', jobId)
    const result = await f.invoke({ job_id: jobId, backend: 'shell', job_instance_id: nativeJob!.instanceId, source_id: nativeJob!.sourceId })
    expect(result).toEqual({ output: { outcome: 'cancellation-requested' }, execution: { outcome: 'succeeded', dispatch: 'dispatched' } })
    expect(f.jobs.read(jobId).status).toBe('running')
    expect(f.exec.getJobView!(jobId).status).toBe('killed')
    expect(f.native.counts()).toEqual({ launches: 1, terminations: 1, releases: 1 })
  } finally { await f.dispose() }
})

it.each([
  { backend: 'shell', job_instance_id: 'stale' },
  { backend: 'shell', job_instance_id: 'CURRENT', source_id: 'stale' },
  { backend: 'shell' }, { backend: 'shell', instance_id: 'obsolete' },
  { backend: 'child', job_instance_id: 'CURRENT' },
  { backend: 'workflow', source_id: 'stale' }, { job_instance_id: 'CURRENT' },
  { backend: 'other' }, { backend: 'shell', job_instance_id: '' },
  { backend: 'shell', job_instance_id: 'CURRENT', extra: true },
])('registered selected kill rejects malformed/stale selection without native or child cancellation: %j', async selectors => {
  const f = fixture()
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['fixture'] })
    f.jobs.registerJob('root', 'subagent', 'collision', jobId)
    const args = { job_id: jobId, ...selectors, ...(selectors.job_instance_id === 'CURRENT' ? { job_instance_id: nativeJob!.instanceId } : {}) }
    await expect(f.invoke(args)).rejects.toThrow()
    expect(f.exec.getJobView!(jobId).status).toBe('running')
    expect(f.jobs.read(jobId).status).toBe('running')
    expect(f.native.counts().terminations).toBe(0)
  } finally { await f.dispose() }
})

it('selected shell refuses a structural legacy service that has no checked capability', async () => {
  const f = fixture(true)
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['fixture'] })
    await expect(f.invoke({ job_id: jobId, backend: 'shell', job_instance_id: nativeJob!.instanceId })).rejects.toThrow()
    expect(f.native.counts().terminations).toBe(0)
  } finally { await f.dispose() }
})

it.each([undefined, 'child'] as const)('keeps original child routing for backend %s and does not cancel a same-id native job', async backend => {
  const f = fixture()
  try {
    const { jobId } = await f.exec.runBackground({ argv: ['fixture'] })
    f.jobs.registerJob('root', 'subagent', 'collision', jobId)
    expect((await f.invoke({ job_id: jobId, ...(backend ? { backend } : {}) })).output).toEqual({ outcome: 'cancellation-requested' })
    expect(f.jobs.read(jobId).status).toBe('killed')
    expect(f.exec.getJobView!(jobId).status).toBe('running')
    expect(f.native.counts().terminations).toBe(0)
  } finally { await f.dispose() }
})


it('an old genuine instance cannot cancel the replacement service with the same owner and short id', async () => {
  const old = nativeFixture({ liveTree: true }), current = fixture()
  try {
    const a = await old.exec.runBackground({ argv: ['fixture'] })
    const b = await current.exec.runBackground({ argv: ['fixture'] })
    expect(a.jobId).toBe(b.jobId)
    expect(a.nativeJob.ownerSessionId).toBe(b.nativeJob!.ownerSessionId)
    expect(a.nativeJob.instanceId).not.toBe(b.nativeJob!.instanceId)
    current.jobs.registerJob('root', 'subagent', 'collision', b.jobId)
    await expect(current.invoke({ job_id: b.jobId, backend: 'shell', job_instance_id: a.nativeJob.instanceId, source_id: a.nativeJob.sourceId })).rejects.toThrow('stale-instance')
    expect(current.exec.getJobView!(b.jobId).status).toBe('running')
    expect(current.jobs.read(b.jobId).status).toBe('running')
    expect(current.native.counts().terminations).toBe(0)
    expect(old.counts().terminations).toBe(0)
  } finally { old.finish(); await old.exec.dispose(); await current.dispose() }
})
