import type { ResidentInboxActivation } from '@i-harness/subagent'

export interface ResidentActivationController {
  readonly ticket: ResidentInboxActivation
  activate(): void
  retire(): void
}

/** One original construction, one publication, no execution effects. */
export function createResidentActivation(available: () => boolean): ResidentActivationController {
  let state: 'pending' | 'active' | 'retired' = 'pending'
  let activating = false
  const waiters = new Set<(active: boolean) => void>()
  const current = () => state === 'active' && available() && state === 'active'
  const retire = () => {
    state = 'retired'
    for (const settle of [...waiters]) settle(false)
  }
  return { ticket: { current, wait(signal, pendingStop) {
    if (state !== 'pending') { const ready = !signal?.aborted && current(); return Promise.resolve(ready && !signal?.aborted) }
    if (signal?.aborted || pendingStop?.aborted) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      let settled = false
      const settle = (active: boolean) => {
        if (settled) return
        settled = true
        waiters.delete(settle)
        signal?.removeEventListener('abort', abort)
        pendingStop?.removeEventListener('abort', abort)
        const ready = active && current()
        resolve(ready && !signal?.aborted)
      }
      const abort = () => settle(false)
      waiters.add(settle)
      signal?.addEventListener('abort', abort, { once: true })
      pendingStop?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted || pendingStop?.aborted) settle(false)
    })
  } }, retire, activate() {
    if (state !== 'pending' || activating) return
    activating = true
    try {
      if (!available() || state !== 'pending') { retire(); return }
      state = 'active'
      for (const settle of [...waiters]) settle(true)
    } finally { activating = false }
  } }
}
