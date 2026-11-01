import type { WaitDrainReservation, WaitDrainService } from './native-wait-bridge.ts'

/** One channel's original prelaunch credit, renewed only after acknowledged retirement. */
export function createChannelWaitCredit(client: Pick<WaitDrainService, 'reserve'>, initial: WaitDrainReservation) {
  let state: 'unused' | 'active' | 'renewal-failed' | 'fenced' = 'unused'
  let current: WaitDrainReservation | undefined = initial
  let fenced = false, renewalFailure: unknown
  return {
    reserve(): WaitDrainReservation {
      if (state !== 'unused' || fenced || !current) throw new Error('channel wait credit unavailable')
      const original = current
      state = 'active'
      let released = false, acknowledged = false
      return {
        unregister(registration) { return original.unregister(registration) },
        rejoin() { original.rejoin() },
        release() {
          if (released) return
          if (!acknowledged) {
            original.release()
            acknowledged = true; current = undefined
          }
          if (fenced) { state = 'fenced'; released = true; return }
          if (state === 'renewal-failed') throw renewalFailure
          try { current = client.reserve(); state = 'unused'; released = true }
          catch (error) { renewalFailure = error; state = 'renewal-failed'; throw error }
        },
      }
    },
    /** A failed renewal has already acknowledged the old original release,
     * but has no replacement credit. Permit only that retained release wrapper
     * to finish during cleanup; ordinary active/unused capacity stays live for
     * observations acknowledging already-issued I/O. */
    retireFailedRenewal() {
      if (state === 'renewal-failed') { fenced = true; state = 'fenced' }
    },
    fence() {
      fenced = true
      if (state === 'unused' && current) { current.release(); current = undefined; state = 'fenced' }
      else if (state === 'renewal-failed') state = 'fenced'
    },
  }
}
