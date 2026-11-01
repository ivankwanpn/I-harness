import type { ProcessSpec } from '@i-harness/sandbox'
import type { AclSandboxChild, AclSandboxChildResult } from './index.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { createChannelWaitCredit } from './channel-wait-credit.ts'
import { createPipeChildNative } from './pipe-child-native.ts'
import { createWin32OutputPipe, win32PipeApi } from './win32-overlapped-read.ts'
import { registerWin32WaitWithReservation } from './win32-wait.ts'
import type { WaitDrainReservation } from './native-wait-bridge.ts'
import { WaitBridgeStartupFailure, type WaitDrainBridgeClient } from './native-wait-bridge-owner.ts'

export type PipeChildInput = Readonly<{command: string; args: readonly string[]; cwd: string; argumentEncoding?: ProcessSpec['argumentEncoding']}>
export interface PipeChildOwner { start(): Promise<AclSandboxChild>; joinCleanup(): Promise<void>; pending(): boolean }
type Credit = ReturnType<typeof createChannelWaitCredit>
type Pipe = ReturnType<typeof createWin32OutputPipe>
type Observer = ReturnType<typeof registerWin32WaitWithReservation>
type Native = ReturnType<typeof createPipeChildNative>
type Original = {api: Win32Bindings; token: NativePtr; logonSid: string; assertLaunchCurrent(): void; acquireWaitClient(): Promise<WaitDrainBridgeClient>}
/** Test injection replaces original boundaries, never the ownership protocol. */
type Boundaries = { native(): Native; pipe(sid: string, credit: Credit, index: number): Pipe; observe(handle: NativePtr, reservation: WaitDrainReservation): Observer }

export function createPipeChildOwner(input: PipeChildInput, original: Original, injected?: Boundaries): PipeChildOwner {
  const boundaries: Boundaries = injected ?? {
    native: () => createPipeChildNative(original.api, original.token, input, () => original.assertLaunchCurrent()),
    pipe: (sid, credit) => createWin32OutputPipe(sid, win32PipeApi(credit)),
    observe: (handle, reservation) => registerWin32WaitWithReservation(handle, reservation),
  }
  let start: Promise<AclSandboxChild> | undefined, whole: Promise<AclSandboxChildResult> | undefined
  let cleanupFlight: Promise<void> | undefined, recoveryFlight: Promise<void> | undefined
  let client: WaitDrainBridgeClient | undefined, startupDebt: WaitBridgeStartupFailure | undefined
  const unused: WaitDrainReservation[] = [], credits: Credit[] = [], pipes: Pipe[] = []
  const initializations: Promise<void>[] = [], reads: Promise<Buffer>[] = []
  let native: Native | undefined, observer: Observer | undefined, root: Promise<void> | undefined
  let exited = false, cleaned = false, primary: {error: unknown} | undefined
  let recoveryErrors: unknown[] = []
  const independentFailures: unknown[] = []
  let notifyFailure!: () => void
  const failureNotice = new Promise<void>(resolve => { notifyFailure = resolve })
  let stdout: Buffer | undefined, stderr: Buffer | undefined, code: number | undefined
  // Every branch has an immediate rejection observer. Failure starts recovery
  // synchronously at that boundary, before any allSettled join can block.
  function watched<T>(promise: Promise<T>): Promise<T> { void promise.catch(beginFailure); return promise }
  function beginFailure(error: unknown) {
    if (!independentFailures.some(value => Object.is(value, error))) independentFailures.push(error)
    primary ??= {error}
    notifyFailure()
    if (recoveryFlight) return
    const actions: Promise<unknown>[] = []
    const invoke = (action: () => unknown) => { try { actions.push(Promise.resolve(action())) } catch (e) { actions.push(Promise.reject(e)) } }
    // Termination is a request, never an exit acknowledgment.
    if (native && (native.phase() === 'created' || native.phase() === 'unknown') && !exited) invoke(() => native!.terminate())
    // Pipe cancellation stops new submissions. Preserve normal channel credit
    // until original pending I/O can be observed and its observer retired.
    // Only an already-acknowledged failed renewal has no capacity to preserve.
    for (const credit of credits.slice(1)) invoke(() => credit.retireFailedRenewal())
    for (const pipe of pipes) invoke(() => pipe.cancel())
    recoveryFlight = Promise.allSettled(actions).then(results => { recoveryErrors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []) })
  }
  function installRoot() {
    observer = boundaries.observe(native!.process(), credits[0]!.reserve())
    const current = observer
    // Separate signal evidence from status and unregister. A failed status read
    // never erases the already acknowledged root exit.
    root = watched(current.signalled.then(() => { exited = true; code = native!.exitCode() }))
    return current.setup
  }
  async function cleanup() {
    const failures: unknown[] = []
    const attempt = async (action: () => unknown) => { try { await action() } catch (e) { failures.push(e) } }
    if (primary && !recoveryFlight) beginFailure(primary.error)
    if (recoveryFlight) await recoveryFlight
    if (recoveryErrors.length) {
      // Do not join a root/I/O whose cancellation request was refused. Retain
      // the original failed actions for an explicit cleanup retry.
      const previous = recoveryErrors; recoveryErrors = []
      if (native && native.phase() === 'created' && !exited) await attempt(() => native!.terminate())
      for (const credit of credits.slice(1)) await attempt(() => credit.retireFailedRenewal())
      for (const pipe of pipes) await attempt(() => pipe.cancel())
      if (failures.length) { recoveryErrors = failures; throw new AggregateError([...previous, ...failures], 'rollback requests remain incomplete') }
    }
    await Promise.allSettled(initializations)
    await Promise.allSettled(reads)
    if (native?.phase() === 'unknown') throw new Error('process issue outcome unknown; original storage pinned')
    if (native && (native.phase() === 'created' || native.phase() === 'unknown')) {
      if (root) await root.catch(() => {})
      if (!exited) {
        // The failed original observer must retire before any replacement on
        // the same original process. Unknown retirement pins it here.
        if (observer) { await observer.close(); observer = undefined }
        // The root's original capacity is renewed only after retirement ACK.
        // A failed renewal refuses here with the same retained child debt.
        await watched(installRoot())
        await root
        if (!exited) throw new Error('original root exit remains unacknowledged')
      }
    }
    for (const credit of credits) await attempt(() => credit.fence())
    for (const pipe of pipes) await attempt(() => pipe.cleanup())
    if (observer) await attempt(async () => { await observer!.close(); observer = undefined })
    if (failures.length) throw new AggregateError(failures, 'pipe child retirement incomplete')
    if (native) { await native.closeLaunch(); native.cleanup() }
    while (unused.length) { unused[unused.length - 1]!.release(); unused.pop() }
    if (startupDebt) { await startupDebt.retryCleanup(); startupDebt = undefined }
    if (client) { await client.release(); client = undefined }
    cleaned = true
  }
  function retryCleanup(): Promise<void> {
    if (cleaned) return Promise.resolve()
    if (cleanupFlight) return cleanupFlight
    const attempt = cleanup(); cleanupFlight = attempt
    void attempt.finally(() => { if (cleanupFlight === attempt) cleanupFlight = undefined }).catch(() => {})
    return attempt
  }
  async function settle(): Promise<AclSandboxChildResult> {
    // A refused termination/cancellation must reach retained-debt cleanup,
    // even when the original root/read promises cannot yet complete.
    await Promise.race([Promise.allSettled([root!, ...reads]), failureNotice])
    try { await retryCleanup() } catch (e) {
      if (primary) throw new AggregateError([...independentFailures, e], 'pipe child failed with retained cleanup debt', {cause:primary.error})
      beginFailure(e); throw e
    }
    if (independentFailures.length > 1) throw new AggregateError(independentFailures, 'independent pipe child failures', {cause:primary?.error})
    if (primary) throw primary.error
    return {stdout:stdout!, stderr:stderr!, exitCode:code!}
  }
  const owner: PipeChildOwner = {
    start() {
      if (start) return start
      // Publish the flight before invoking acquisition or any native effect.
      start = Promise.resolve().then(async () => {
        try {
          try { client = await original.acquireWaitClient() } catch (e) { if (e instanceof WaitBridgeStartupFailure) startupDebt = e; throw e }
          await client.ready
          for (let i=0;i<3;i++) unused.push(client.reserve())
          while (unused.length) credits.push(createChannelWaitCredit(client, unused.shift()!))
          pipes.push(boundaries.pipe(original.logonSid, credits[1]!, 0))
          pipes.push(boundaries.pipe(original.logonSid, credits[2]!, 1))
          for (const pipe of pipes) initializations.push(watched(pipe.initialize()))
          await Promise.all(initializations)
          original.assertLaunchCurrent()
          native = boundaries.native()
          native.prepare(pipes[0]!.writer(), pipes[1]!.writer())
          native.issue()
          // Known-created state belongs to native before these fallible reads.
          const pid = native.pid()
          native.process(); native.thread()
          await native.closeLaunch()
          for (const pipe of pipes) await pipe.closeWriter()
          const setup = watched(installRoot())
          reads.push(watched(pipes[0]!.readAll().then(value => {stdout=value; return value})))
          reads.push(watched(pipes[1]!.readAll().then(value => {stderr=value; return value})))
          await setup
          if (primary) throw primary.error
          whole = settle(); void whole.catch(() => {})
          return Object.freeze({pid, wait: () => whole!})
        } catch (e) {
          beginFailure(e)
          // Attach root observation on the original known-created handle even
          // if field decoding or launch-side closes failed before publication.
          if (native?.phase() === 'created' && !observer) {
            try { await watched(installRoot()) } catch { /* same owner remains retryable */ }
          }
          void retryCleanup().catch(() => {})
          throw e
        }
      })
      void start.catch(() => {})
      return start
    },
    async joinCleanup() {
      if (start) await start.catch(() => {})
      if (whole) await whole.catch(() => {})
      await retryCleanup()
    },
    pending: () => !cleaned,
  }
  return owner
}
