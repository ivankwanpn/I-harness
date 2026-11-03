import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { registerExec, type NativeJobIdentity } from '@i-harness/exec'
import { bashAvailable, registerShell, resolveShell } from '../src/index.ts'

for (const name of ['bash', 'pwsh', 'shell'] as const) {
  const dialect = name === 'shell' ? resolveShell().name : name
  for (const background of [true, false]) {
    it.skipIf(dialect === 'bash' && !bashAvailable())(`registered ${name} preserves original identity through ${background ? 'background submission' : 'foreground promotion'}`, async () => {
      const ctx = createContext(), registry = createToolRegistry(ctx), exec = registerExec(ctx)
      const selected = resolveShell()
      registerShell(ctx, registry, { backgroundAfterMs: 0, agentShell: () => ({ id: 'native-selected', label: 'selected', command: selected.argv[0]!, dialect: selected.name === 'bash' ? 'posix' : 'powershell' }) })
      try {
        const call = await registry.prepare({ name, args: { command: dialect === 'bash' ? 'printf native-job; sleep 30' : "Write-Output 'native-job'; Start-Sleep -Seconds 30", background } })
        const output = await registry.dispatch(call)
        await registry.finalize(call, output)
        const value = output as { job_id: string; native_job: NativeJobIdentity; promoted?: true }
        expect(value.native_job).toMatchObject({ version: 1, jobId: value.job_id, ownerSessionId: expect.any(String), sourceId: expect.stringMatching(/^process:/) })
        expect(value.native_job.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(value.native_job).toBe(exec.getJobView(value.job_id).nativeJob)
        expect(value.native_job).toBe(exec.listJobViews()[0]!.nativeJob)
        expect(value.promoted).toBe(background ? undefined : true)
        // Standalone identity is available even without durable retention.
        expect(exec.getJobView(value.job_id).retained).toBeUndefined()
        await exec.killJob(value.job_id)
      } finally { await exec.dispose() }
    }, 15000)
  }
}
