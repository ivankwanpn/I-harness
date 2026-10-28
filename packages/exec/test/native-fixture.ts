import { resolve } from 'node:path'
import { createExecutionLease, type RootExit, type TerminationObservation, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecService, type ExecServiceOptions } from '../src/index.ts'

/** Deterministic native boundary; capture, supervisor, lease and cleanup are real. */
export function nativeFixture(options: {
  root?: RootExit; observation?: TerminationObservation | 'unsupported'; liveTree?: boolean; holdOutput?: boolean;
  text?: string; resultRetention?: ExecServiceOptions['resultRetention'];
  supervisor?: import('../src/index.ts').ExecutionSupervisor; canAccessOwner?: () => boolean;
} = {}) {
  let launches = 0, terminations = 0, releases = 0
  const launched = Promise.withResolvers<void>(), outputStarted = Promise.withResolvers<void>(), outputEnd = Promise.withResolvers<void>(), tree = Promise.withResolvers<void>()
  if (!options.holdOutput) outputEnd.resolve()
  const root = options.root ?? { exitCode: 0 }
  if (!options.liveTree) tree.resolve()
  const backend: TransportExecutionBackend = {
    async probe() { return { id: 'native-fixture', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) { return { policy, async rollback() {}, async commit(validate) {
      validate(); launches++
      const lease = createExecutionLease({ receipt: { executionId: 'native-original', backendId: 'native-fixture', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' },
        rootExited: Promise.resolve(root), waitTreeEmpty: () => tree.promise,
        async settleIo() {}, async releaseResources() { releases++ },
        async terminate() { terminations++; tree.resolve() },
      })
      launched.resolve()
      return { ...lease, get settled() { return lease.settled }, pid: 1,
        terminationObservation: options.observation === 'unsupported' ? undefined : options.observation ? () => options.observation as TerminationObservation : lease.terminationObservation,
        io: { async write() {}, async endInput() {}, output: (async function* () { outputStarted.resolve(); yield { channel: 'stdout' as const, data: Buffer.from(options.text ?? 'original\r\n') }; await outputEnd.promise })() },
      }
    } } },
  }
  const exec = createExecService({ resultRetention: options.resultRetention, execution: {
    defaultOwner: { sessionId: 'native-outcomes' }, supervisor: options.supervisor, canAccessOwner: options.canAccessOwner, selectBackend: () => backend, validateAuthority() {},
    resolvePolicy: owner => compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'native-fixture', workspaceRoot: resolve('.') } }),
  } })
  return { exec, launched: launched.promise, outputStarted: outputStarted.promise, finish: () => { tree.resolve(); outputEnd.resolve() }, counts: () => ({ launches, terminations, releases }) }
}
