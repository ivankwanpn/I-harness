import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecService, type ExecServiceOptions } from '../src/index.ts'

it('tees ordered native bytes before collector loss without changing exit or process authority', async () => {
  let consumed!: () => void
  const drained = new Promise<void>(resolve => { consumed = resolve })
  let launches = 0, seenBytes = 0, complete = '', observed = 0
  const actual = createHash('sha256'), expected = createHash('sha256')
  const ordinals: number[] = []
  const backend: TransportExecutionBackend = {
    async probe() { return { id: 'frame-source', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) { return { policy, async rollback() {}, async commit(check) {
      check(); launches++
      const root = Promise.resolve({ exitCode: 7 }), lease = createExecutionLease({ receipt: { executionId: 'frame-source-1', backendId: 'frame-source', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' }, rootExited: root, waitTreeEmpty: async () => {}, settleIo: () => drained, releaseResources: async () => {}, terminate: async () => {} })
      return { pid: 123, receipt: lease.receipt, rootExited: lease.rootExited, get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
        io: { async write() {}, async endInput() {}, output: (async function* () {
          try { for (let frame = 0; frame < 32; frame++) { const bytes = Buffer.alloc(65536, frame % 2 ? 98 : 97); expected.update(bytes); yield { channel: frame % 2 ? 'stderr' as const : 'stdout' as const, data: bytes } } }
          finally { consumed() }
        })() } }
    } } },
  }
  const options: ExecServiceOptions = { spill: { maxOutputBytes: 16, maxSpillBytes: 32 }, execution: { defaultOwner: { sessionId: 'source-owner' }, selectBackend: () => backend, validateAuthority() {},
    resolvePolicy: (owner: { sessionId: string }) => compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'frame-source', workspaceRoot: resolve('.') } }) },
    resultRetention: { begin() { return { sourceId: 'frame-source-1', async write(part: { frame: number; offset: number; end: boolean; bytes: Uint8Array }) { seenBytes += part.bytes.length; actual.update(part.bytes); if (part.offset === 0) ordinals.push(part.frame) }, complete(value: string) { complete = value }, async settle() { return { kind: 'ready', dependency: { kind: 'exec-frames', sourceId: 'frame-source-1', retention: { kind: 'unavailable', reason: 'storage-refused' } } } } } }, observe() { observed++ } } }
  const exec = createExecService(options)
  try {
    const result = await exec.run({ argv: ['controlled-native-frame-source'] })
    expect(result.exitCode).toBe(7); expect(result.timedOut).toBe(false)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16)
    expect(seenBytes).toBe(2_097_152)
    expect(actual.digest('hex')).toBe(expected.digest('hex'))
    expect(ordinals).toEqual(Array.from({ length: 32 }, (_, index) => index))
    expect({ launches, complete, observed }).toEqual({ launches: 1, complete: 'complete', observed: 1 })
  } finally { await exec.dispose() }
})
