import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecService, type ExecutionSupervisor } from '../src/index.ts'
import { createExecFrameCapture } from '../../output-retention/src/index.ts'

function foreground(exitCode: number, rejectObserver: boolean, unknownStorage = false) {
  const owner = { sessionId: 'foreground-retention' }
  const policy = compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'foreground', workspaceRoot: resolve('.') } })
  let launches = 0, observations = 0
  const root = { exitCode }
  const handle = {
    pid: 123, receipt: { executionId: 'foreground-retention', backendId: 'controlled', policyFingerprint: policy.fingerprint, owner, assurance: 'unverified' as const },
    io: { async write() {}, async endInput() {}, output: (async function* () { yield { channel: 'stdout' as const, data: Buffer.from('original') } })() },
    rootExited: Promise.resolve(root),
    settled: Promise.resolve({ kind: 'settled' as const, root, treeEmpty: true as const, ioSettled: true as const, resourcesReleased: true as const }),
    async cancel() { throw new Error('Unexpected cancel') }, async release() { throw new Error('Unexpected release') },
  }
  const supervisor: ExecutionSupervisor = {
    async launch() { launches++; return { id: 'foreground-retention', policy, handle } }, list: () => [],
    async cancel() { throw new Error('Unexpected cancellation') }, async reconcile() {}, async closeOwner() {}, async dispose() {},
  }
  const backend: TransportExecutionBackend = { async probe() { throw new Error('Unused probe') }, async prepare() { throw new Error('Unused prepare') } }
  const exec = createExecService({ execution: { supervisor, defaultOwner: owner, resolvePolicy: () => policy, validateAuthority() {}, selectBackend: () => backend },
    resultRetention: {
      begin({ sourceId }) { return createExecFrameCapture({ sourceId, openArtifact: async () => ({
        async write() {}, async reconcileWrite() { return 'ready' as const },
        async finish() { return unknownStorage ? { kind: 'recovery-required' as const, operationId: 'original-foreground' }
          : { kind: 'refused' as const, reason: 'storage-refused' as const, observedEncodedBytes: 0 } },
        async reconcile() { throw new Error('Unused reconciliation') },
      }) }) },
      async settle(capture) { return capture.settle() },
      async observe(capture) {
        observations++
        if (rejectObserver) throw new Error('CONTROLLED_FOREGROUND_OBSERVER_REJECTION')
        return capture.settle()
      },
    },
  })
  return { exec, releaseRetention() { unknownStorage = false }, counts: () => ({ launches, observations }) }
}

it.each([0, 7])('reports observation recovery without rewriting the original native exit %s or leaking rejection', async exitCode => {
  const { exec, counts } = foreground(exitCode, true)
  try {
    const result = await exec.run({ argv: ['controlled-foreground'] })
    expect(result).toMatchObject({ stdout: 'original', stderr: '', exitCode, timedOut: false, retentionFailure: 'recovery-required' })
    await new Promise<void>(done => setImmediate(done))
    expect(counts()).toEqual({ launches: 1, observations: 1 })
  } finally { await exec.dispose() }
})

it('reports a known result retention refusal separately from a successful native command', async () => {
  const { exec, counts } = foreground(0, false)
  try {
    const result = await exec.run({ argv: ['controlled-foreground'] })
    expect(result).toMatchObject({ stdout: 'original', exitCode: 0, timedOut: false, retentionFailure: 'unavailable' })
    expect(counts()).toEqual({ launches: 1, observations: 1 })
  } finally { await exec.dispose() }
})

it('keeps an uncertain foreground capture available through failed close and original recovery', async () => {
  const { exec, counts, releaseRetention } = foreground(0, false, true)
  try {
    const result = await exec.run({ argv: ['controlled-foreground'] })
    expect(result).toMatchObject({ stdout: 'original', exitCode: 0, retentionFailure: 'recovery-required' })
    await expect(exec.dispose()).rejects.toMatchObject({ code: 'ARTIFACT_RECOVERY_REQUIRED' })
    releaseRetention()
    await expect(exec.dispose()).resolves.toBeUndefined()
    expect(counts()).toEqual({ launches: 1, observations: 1 })
  } finally { releaseRetention(); await exec.dispose() }
})
