import { Win32Error } from './errors.ts'

/** Ownership of a one-shot native registration. The adapter owns its trampoline. */
export interface RegisteredWaitAdapter<T> {
  register(callback: () => void): T
  unregister(registration: T): Promise<number>
  release(): void
}

export function createRegisteredWait<T>(adapter: RegisteredWaitAdapter<T>): {
  signalled: Promise<void>
  close(): Promise<void>
} {
  let notify!: () => void
  const signalled = new Promise<void>(resolve => { notify = resolve })
  let retired = false
  const registration = adapter.register(() => {
    if (!retired) notify()
  })
  let pending: Promise<void> | undefined
  let acknowledged = false
  let released = false
  return {
    signalled,
    close() {
      if (released) return Promise.resolve()
      if (pending !== undefined) return pending
      retired = true
      const attempt = (async () => {
        if (!acknowledged) {
          const code = await adapter.unregister(registration)
          if (code !== 0) throw new Win32Error('UnregisterWaitEx', code)
          acknowledged = true
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
