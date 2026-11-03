import { expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, resultExecution } from '@i-harness/core-tools'
import { SandboxUnavailableError } from '@i-harness/sandbox'
import type { ExecService } from '@i-harness/exec'
import { createShellTools, type ShellToolDeps } from '../src/index.ts'
import { nativeFixture } from '../../exec/test/native-fixture.ts'

const binding = { id: 'fixture', label: 'controlled Bash', command: 'fixture', dialect: 'posix' as const }
function registry(deps: Partial<ShellToolDeps> & Pick<ShellToolDeps, 'exec'>) {
  const tools = createToolRegistry(createContext())
  for (const tool of createShellTools({ agentShell: () => binding, wslShell: binding, ...deps })) tools.register(tool)
  return tools
}
async function invoke(tools: ReturnType<typeof registry>, name: string, args: object = { command: 'fixture' }) {
  const prepared = await tools.prepare({ name, args })
  const output = await tools.dispatch(prepared)
  await tools.finalize(prepared, output)
  return { output, prepared, execution: resultExecution(prepared) }
}

it.each(['shell', 'bash', 'pwsh'])('declares original %s native nonzero and null outcome before presentation', async name => {
  for (const [exitCode, outcome] of [[7, 'failed'], [null, 'unknown'], [0, 'succeeded']] as const) {
    const f = nativeFixture({ root: { exitCode } })
    try {
      const result = await invoke(registry({ exec: f.exec }), name)
      expect(result.execution).toEqual({ outcome, dispatch: 'dispatched' })
      expect(result.output).toEqual({ stdout: 'original\n', stderr: '', exitCode: exitCode ?? -1 })
    } finally { await f.exec.dispose() }
  }
})

it('custom ExecService output fields cannot mint host identity or native success', async () => {
  const f = nativeFixture(), value = { stdout: 'program', stderr: '', exitCode: 0, timedOut: false, status: 'failed', outcome: 'succeeded' }
  const exec = { ...f.exec, run: async () => value } as ExecService
  try { expect((await invoke(registry({ exec }), 'shell')).execution).toEqual({ outcome: 'unknown', dispatch: 'dispatched' }) }
  finally { await f.exec.dispose() }
})

it.each(['binding', 'validation', 'policy', 'backend'] as const)('declares original %s refusal failed without changing its body', async kind => {
  const f = nativeFixture()
  const exec = kind === 'backend' ? { ...f.exec, run: async () => { throw new SandboxUnavailableError('read-only', 'controlled no backend') } } as ExecService : f.exec
  const tools = registry({ exec,
    agentShell: () => { if (kind === 'binding') throw new Error('binding refused'); return { ...binding, validate() { if (kind === 'validation') throw new Error('validation refused') } } },
    ...(kind === 'policy' ? { sandboxPolicy: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) } : {}),
  })
  try {
    const result = await invoke(tools, 'shell', { command: 'fixture', ...(kind === 'policy' ? { sandbox_permissions: 'danger-full-access', justification: 'fixture refusal' } : {}) })
    expect(result.execution).toEqual({ outcome: 'failed', dispatch: 'dispatched' })
    expect(result.output).toMatchObject({ stdout: '', stderr: expect.any(String), exitCode: -1 })
    expect(f.counts().launches).toBe(0)
  } finally { await f.exec.dispose() }
})

it.each([false, true])('successful background handoff (promotion=%s) keeps startup success after original job fails', async promotion => {
  const f = nativeFixture({ liveTree: true, root: { exitCode: 9 } })
  const tools = registry({ exec: f.exec, ...(promotion ? { backgroundAfterMs: 5 } : {}) })
  try {
    const startup = await invoke(tools, 'shell', { command: 'fixture', ...(!promotion ? { background: true } : {}) })
    const jobId = (startup.output as { job_id: string }).job_id
    expect(jobId).toBeTypeOf('string')
    f.finish()
    await vi.waitFor(() => expect(f.exec.getOutput(jobId)).toMatchObject({ exitCode: 9 }))
    tools.register({ name: 'observe', description: '', inputSchema: {}, execute: async () => f.exec.getOutput(jobId) })
    expect((await invoke(tools, 'observe', {})).execution.outcome).toBe('succeeded')
    expect(resultExecution(startup.prepared).outcome).toBe('succeeded')
  } finally { f.finish(); await f.exec.dispose() }
})
