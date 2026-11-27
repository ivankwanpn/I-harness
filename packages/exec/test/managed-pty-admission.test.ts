import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import type { ExecTransportRequest } from '../src/index.ts'
import { createExecutionSupervisor } from '../src/execution-supervisor.ts'
import { createExecServiceWithReservation, readOriginalPtyTransport } from '../src/service.ts'

it('joins the original failed PTY cleanup before retrying and retires the admission guard after commit', async () => {
  const entering = Promise.withResolvers<void>(), unblocked = Promise.withResolvers<void>()
  let preparations = 0, spawned = 0, rollbacks = 0, allowRollback = false, current = true
  const authority = { kind: 'unbound' as const, revision: 'fixture', workspaceRoot: resolve('.') }
  const owner = Object.freeze({ sessionId: 'pty-owner' })
  const token = Object.freeze({})
  const backend: TransportExecutionBackend = {
    async probe() {
      return { id: 'pty', availability: 'available', assurance: 'unverified', features: {
        writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: true, retainedTree: true,
      } }
    },
    async prepare(spec, policy) {
      if (++preparations === 1) {
        entering.resolve()
        await unblocked.promise
      }
      return {
        policy,
        async rollback() {
          rollbacks++
          if (!allowRollback) throw Error('original PTY rollback blocked')
        },
        async commit(check) {
          check()
          const finish = Promise.withResolvers<void>()
          const lease = createExecutionLease({
            receipt: { executionId: 'native-' + ++spawned, backendId: 'pty', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' },
            rootExited: finish.promise.then(() => ({ exitCode: 0 })),
            waitTreeEmpty: () => finish.promise, async settleIo() {}, async releaseResources() {},
            async terminate() { finish.resolve() },
          })
          return {
            ...lease, get settled() { return lease.settled }, pid: 123,
            io: { async write() {}, async endInput() {}, output: (async function* () {})() },
          }
        },
      }
    },
  }
  const supervisor = createExecutionSupervisor()
  const pair = createExecServiceWithReservation({ execution: {
    supervisor, defaultOwner: owner, selectBackend: () => backend,
    resolvePolicy(caller, requested) {
      if (caller.sessionId !== owner.sessionId || requested?.authoritySnapshot !== token) throw Error('test authority unavailable')
      return compileExecutionPolicy({ mode: 'danger-full-access', owner: caller, authority })
    },
    validateAuthority() {},
  } })
  const pty = readOriginalPtyTransport(pair)
  const request: ExecTransportRequest = {
    transport: 'pty', lifetime: 'retain-tree', argumentEncoding: 'crt', argv: ['fixture'],
    sandbox: { mode: 'danger-full-access', workspaceRoot: authority.workspaceRoot, authoritySnapshot: token },
  }
  const assertCurrent = () => { if (!current) throw Error('original terminal invocation expired') }
  expect(() => readOriginalPtyTransport({ ...pair })).toThrow('Original Exec construction pair required')
  await expect(pty.launch({ ...request, sandbox: undefined }, assertCurrent)).rejects.toThrow('Original PTY admission policy required')
  const mistaken = pty.launch(request, assertCurrent)
  void mistaken.catch(() => {})
  try {
    await entering.promise
    current = false
    unblocked.resolve()
    await expect(mistaken).rejects.toThrow(/cleanup failed/)
    expect(spawned).toBe(0)
    expect(rollbacks).toBe(1)
    expect(pty.hasPendingCleanup()).toBe(true)

    current = true
    await expect(pty.launch(request, assertCurrent)).rejects.toThrow('Original PTY admission cleanup is incomplete')
    expect(preparations).toBe(1)
    expect(rollbacks).toBe(2)
    allowRollback = true
    const admitted = await pty.launch(request, assertCurrent)
    expect(rollbacks).toBe(3)
    expect(pty.hasPendingCleanup()).toBe(false)
    expect(preparations).toBe(2)
    expect(spawned).toBe(1)

    current = false
    await supervisor.reconcile(owner.sessionId, () => {})
    expect(supervisor.list()).toEqual([admitted])
    expect(await pair.service.cancelExecution(admitted.id, 'cancelled')).toMatchObject({ kind: 'settled', resourcesReleased: true })
    expect(supervisor.list()).toEqual([])
  } finally {
    allowRollback = true
    unblocked.resolve()
    await pair.service.dispose()
  }
})
