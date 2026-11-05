import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createExecFrameCapture } from '../../output-retention/src/index.ts'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { createExecService, type BackgroundJobView } from '../src/index.ts'

it('recovers the same real1MiB background artifact after losing its original finish receipt', async () => {
  const base = resolve(import.meta.dirname, '../../../build/exec-retention-recovery')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'original-')), owner = { sessionId: 'original-native-owner' }
  const storage = createContextOutputService({ root, workspaceId: 'fixture', config: { enabled: false, maxDiskBytes: 8_388_608 } })
  let release!: () => void, drained!: () => void
  const gate = new Promise<void>(done => { release = done }), ioDone = new Promise<void>(done => { drained = done })
  let launches = 0, opens = 0, writes = 0, finishes = 0, observers = 0, active = true
  let committedRef: ManagedArtifactRef | undefined
  const operationId = randomUUID()
  const backend: TransportExecutionBackend = {
    async probe() { return { id: 'real-store-fixture', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) { return { policy, async rollback() {}, async commit(check) {
      check(); launches++
      const lease = createExecutionLease({ receipt: { executionId: 'original-native', backendId: 'real-store-fixture', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' },
        rootExited: gate.then(() => ({ exitCode: 0 })), waitTreeEmpty: () => gate, settleIo: () => ioDone, releaseResources: async () => {}, terminate: async () => { release() } })
      return { pid: 123, receipt: lease.receipt, rootExited: lease.rootExited, get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
        io: { async write() {}, async endInput() {}, output: (async function* () {
          try { yield { channel: 'stdout' as const, data: Buffer.alloc(1_048_576, 120) }; await gate; yield { channel: 'stderr' as const, data: Buffer.from('marker') } }
          finally { drained() }
        })() } }
    } } },
  }
  const exec = createExecService({ execution: { defaultOwner: owner, selectBackend: () => backend, validateAuthority() {},
    resolvePolicy: executionOwner => compileExecutionPolicy({ mode: 'danger-full-access', owner: executionOwner, authority: { kind: 'unbound', revision: 'fixture', workspaceRoot: root } }) },
    resultRetention: {
      begin({ sourceId }) {
        const scope = storage.registerResultScope({ operationId, sessionId: owner.sessionId, callId: 'original-native' }, () => active)
        return createExecFrameCapture({ sourceId, async openArtifact() {
          opens++
          const sink = await storage.beginResult(scope, 'exec-frames-v1')
          return { ...sink, async write(bytes) { writes++; await sink.write(bytes) }, async finish(completeness) {
            finishes++
            const result = await sink.finish(completeness)
            if (finishes === 1) {
              if (result.kind !== 'committed') throw new Error('Fixture must lose a genuinely committed receipt')
              committedRef = result.ref
              return { kind: 'recovery-required' as const, operationId }
            }
            return result
          } }
        } })
      },
      async settle(capture) { return capture.settle() },
      async observe(capture) { observers++; return capture.settle() },
    },
  })
  let cold: ReturnType<typeof createContextOutputService> | undefined
  try {
    const { jobId } = await exec.runBackground({ argv: ['controlled-native-transport'] })
    const terminal = new Promise<BackgroundJobView>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Original completion did not arrive')), 20_000)
      const stop = exec.subscribeJob(jobId, value => { if (value.status !== 'running') { clearTimeout(timer); stop(); done(value) } })
    })
    release()
    const first = await terminal, originalWrites = writes
    expect(first).toMatchObject({ status: 'completed', exitCode: 0, retentionFailure: 'recovery-required' })
    expect(first.retained).toBeUndefined()
    expect({ launches, opens, finishes, observers }).toEqual({ launches: 1, opens: 1, finishes: 1, observers: 0 })
    expect(committedRef?.codec).toBe('exec-frames-v1')
    // A passive read retries the same pending capture; the actual store returns
    // its original immutable receipt without a new begin/write/process. Reads are
    // refused once the service is disposed, so observe it while still live.
    exec.getOutput(jobId)
    await expect.poll(() => exec.getOutput(jobId).retained, { timeout: 10_000 }).toMatchObject({ sourceId: 'process:execution-1', retention: { kind: 'artifact', ref: committedRef } })
    await exec.dispose()
    expect({ launches, opens, writes, finishes }).toEqual({ launches: 1, opens: 1, writes: originalWrites, finishes: 2 })
    cold = createContextOutputService({ root, workspaceId: 'fixture', config: { enabled: false, maxDiskBytes: 8_388_608 } })
    const chunks: Buffer[] = []; let offset = 0
    for (;;) {
      const page = await cold.readResult({ sessionId: owner.sessionId }, { ref: committedRef!, offset })
      chunks.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
      if (page.eof) break
      offset = page.nextOffset!
    }
    const encoded = Buffer.concat(chunks)
    expect(createHash('sha256').update(encoded).digest('hex')).toBe(committedRef!.contentDigest)
    expect(encoded.subarray(0, 9).toString()).toBe('IHEXEC01\n')
    const stdout = createHash('sha256'), stderr: Buffer[] = []; let stdoutBytes = 0
    for (const line of encoded.subarray(9).toString().split('\n').filter(Boolean)) {
      const frame = JSON.parse(line), bytes = Buffer.from(frame.data, 'base64')
      if (frame.channel === 'stdout') { stdout.update(bytes); stdoutBytes += bytes.length }
      else { expect(frame.channel).toBe('stderr'); stderr.push(bytes) }
    }
    expect(stdoutBytes).toBe(1_048_576)
    expect(stdout.digest('hex')).toBe(createHash('sha256').update(Buffer.alloc(1_048_576, 120)).digest('hex'))
    expect(Buffer.concat(stderr).toString()).toBe('marker')
    expect(launches).toBe(1)
  } finally {
    release(); await exec.dispose(); active = false
    await cold?.close(); await storage.close(); await rm(root, { recursive: true, force: true })
  }
})
