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
export function captureChildInstructionContext(lease: ChildInstructionContext, revoke: () => void, retainCleanup?: (cleanup: Pick<ChildInstructionContext, 'retire' | 'close'>) => void): ChildInstructionContext {
  if (!lease || typeof lease !== 'object') throw new TypeError('Invalid returned child instruction lease')
  const errors: unknown[] = []
  const method = <T extends (...args: any[]) => any>(name: string): T => {
    for (let owner: object | null = lease; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name)
      if (descriptor) { if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value.bind(lease) as T; break }
    }
    throw new TypeError(`Invalid child instruction ${name} capability`)
  }
  const obtain = <T extends (...args: any[]) => any>(name: string): T | undefined => {
    try { return method<T>(name) } catch (error) { errors.push(error); return undefined }
  }
  let close: ChildInstructionContext['close'] | undefined, settle: ChildInstructionContext['settleOriginals'] | undefined, retire: ChildInstructionContext['retire'] | undefined
  let retired = false, settled = false, closed = false, flight: Promise<void> | undefined, settlement: Promise<void> | undefined
  const settleOnce = () => {
    // A malformed returned lease is never executable. Its usable original
    // close still owns cleanup when no valid separate settlement was returned.
    if (!settle) return Promise.resolve()
    if (settled) return Promise.resolve()
    if (settlement) return settlement
    const pending = Promise.resolve().then(settle).then(() => { settled = true })
    settlement = pending; void pending.catch(() => { if (settlement === pending) settlement = undefined }); return pending
  }
  const cleanup = Object.freeze({
    retire() { revoke(); if (!retired && retire) { retire(); retired = true } },
    close() {
      if (closed) return Promise.resolve()
      if (flight) return flight
      const pending = (async () => { await settleOnce(); if (!close) throw new TypeError('Original returned instruction close unavailable'); await close(); closed = true })()
      flight = pending; void pending.catch(() => { if (flight === pending) flight = undefined }); return pending
    },
  })
  // Publish the owner before later descriptor validation can reject. Obtain
  // remaining valid originals even when one descriptor is malformed.
  retainCleanup?.(cleanup)
  close = obtain<ChildInstructionContext['close']>('close')
  settle = obtain<ChildInstructionContext['settleOriginals']>('settleOriginals')
  retire = obtain<ChildInstructionContext['retire']>('retire')
  const descriptor = Object.getOwnPropertyDescriptor(lease, 'requestContext')
  if (!descriptor || !('value' in descriptor) || !descriptor.value) errors.push(new TypeError('Invalid child instruction request context'))
  if (errors.length) throw errors[0]
  return Object.freeze({ requestContext: descriptor!.value as SessionRequestContext, ...cleanup, settleOriginals: settleOnce })
}
