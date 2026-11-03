import { Win32Error } from './errors.ts'
import { WaitDrainTransportError, type WaitDrainReceipt } from './native-wait-bridge.ts'

/** Ownership of a one-shot native registration. The adapter owns its trampoline. */
export interface RegisteredWaitAdapter<T> {
  register(callback: () => void): T
  unregister(registration: T): Promise<number | WaitDrainReceipt>
  rejoin?(): void
  release(): void
}
export function createRegisteredWait<T>(adapter: RegisteredWaitAdapter<T>): { signalled: Promise<void>; close(): Promise<void> } {
  let notify!: () => void
  const signalled = new Promise<void>(resolve => { notify = resolve })
  let retired = false
  const registration = adapter.register(() => { if (!retired) notify() })
  let pending: Promise<void> | undefined
  let acknowledged = false, released = false, unknown = false
  let unknownFailure: unknown
  let code: number | undefined, receipt: WaitDrainReceipt | undefined, nativeFailure: Win32Error | undefined
  return {
    signalled,
    close() {
      if (released) return Promise.resolve()
      if (pending) { adapter.rejoin?.(); return pending }
      retired = true
      const attempt = (async () => {
        if (unknown) throw unknownFailure // Never resubmit a possibly consumed registration.
        if (!acknowledged && code === undefined) {
          let result: number | WaitDrainReceipt
          try { result = await adapter.unregister(registration) } catch (error) {
            if (!(error instanceof WaitDrainTransportError && error.outcome === 'not-dispatched')) { unknown = true; unknownFailure = error }
            throw error
          }
          code = typeof result === 'number' ? result : result.status
          receipt = typeof result === 'number' ? undefined : result
          if (!Number.isInteger(code) || code < 0 || code > 0xffffffff) {
            unknown = true; unknownFailure = new WaitDrainTransportError('unknown', 'invalid unregister status'); throw unknownFailure
          }
          if (code === 0) acknowledged = true // Retain native acknowledgment before transport handoff.
          else nativeFailure = new Win32Error('UnregisterWaitEx', code)
        }
        if (receipt) {
          try { await receipt.acknowledge() } catch (error) {
            if (nativeFailure) throw new AggregateError([nativeFailure, error], 'unregister failed and result handoff is incomplete', { cause: nativeFailure })
            throw error
          }
          receipt = undefined
        }
        if (!acknowledged) {
          const error = nativeFailure!
          code = undefined; nativeFailure = undefined // Known nonzero: a later explicit native retry is safe.
          throw error
        }
        adapter.release()
        released = true
      })()
      pending = attempt
      void attempt.finally(() => { if (pending === attempt) pending = undefined }).catch(() => {})
      return attempt
    },
  }
}
