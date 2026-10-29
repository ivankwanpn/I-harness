import type { FactOwner, SessionView } from '@i-harness/core-session'
import type { SessionRequestContext } from '@i-harness/core-agent'

export interface ChildInstructionContextInput {
  readonly session: SessionView
  readonly factOwner: FactOwner
  readonly lifetime: { available(): boolean }
}

/** Session lifetime ownership; caller retains its document and plugin context. */
export interface ChildInstructionContext {
  readonly requestContext: SessionRequestContext
  settleOriginals(): Promise<void>
  retire(): void
  close(): Promise<void>
}

export interface ChildInstructionContextFactory {
  (input: ChildInstructionContextInput): ChildInstructionContext
  /** Join only the exact source owner left by a failed construction. */
  settleFailed?(input: ChildInstructionContextInput): Promise<void>
}
export interface InitialChildSetup { retire(): void; close(): Promise<void> }

/** Retain the original lease methods and receiver without freezing the host. */
export function captureChildInstructionContext(lease: ChildInstructionContext, revoke: () => void): ChildInstructionContext {
  const method = <T extends (...args: any[]) => any>(name: string): T => {
    for (let owner: object | null = lease; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor) { if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value.bind(lease) as T; break }
    }
    throw new TypeError(`Invalid child instruction ${name} capability`)
  }
  const close = method<ChildInstructionContext['close']>('close'), settle = method<ChildInstructionContext['settleOriginals']>('settleOriginals'), retire = method<ChildInstructionContext['retire']>('retire')
  const descriptor = Object.getOwnPropertyDescriptor(lease, 'requestContext')
  if (!descriptor || !('value' in descriptor) || !descriptor.value) throw new TypeError('Invalid child instruction request context')
  let retired = false, settled = false, closed = false, flight: Promise<void> | undefined, settlement: Promise<void> | undefined
  const settleOnce = () => {
    if (settled) return Promise.resolve()
    if (settlement) return settlement
    const pending = settle().then(() => { settled = true })
    settlement = pending; void pending.catch(() => { if (settlement === pending) settlement = undefined }); return pending
  }
  return Object.freeze({ requestContext: descriptor.value as SessionRequestContext,
    retire() { if (!retired) { revoke(); retire(); retired = true } },
    settleOriginals: settleOnce,
    close() {
      if (closed) return Promise.resolve()
      if (flight) return flight
      const pending = (async () => { await settleOnce(); await close(); closed = true })()
      flight = pending; void pending.catch(() => { if (flight === pending) flight = undefined }); return pending
    },
  })
}
