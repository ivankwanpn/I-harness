import { FactRecoveryRequiredError } from '@i-harness/core-session'
import type { EncodedFactBatch } from '@i-harness/core-session'
import type { HeldFactOwner, IssuingFactOwner } from './coordinator/fact-types.ts'

export type NativeJournalCleanup = Readonly<{ settle(): Promise<void>; hasDebt(): boolean }>
type JournalCleanupFactory = (id: string, held: HeldFactOwner) => NativeJournalCleanup

type NativeRequest = { id: string; owner: IssuingFactOwner }
const originals = new WeakMap<object, { check(): void; cleanup?: JournalCleanupFactory; requests: WeakMap<EncodedFactBatch, NativeRequest> }>()

/** Constructor-private scheduling observation. It grants neither issue nor ACK. */
export function createOriginalNativePrewriteOwner() {
  const requests = new WeakMap<EncodedFactBatch, NativeRequest>()
  const result = Object.freeze({
    enter(id: string, owner: IssuingFactOwner, batch: EncodedFactBatch) {
      if (this !== result || requests.has(batch)) throw new TypeError('Invalid native prewrite request')
      const request = { id, owner }
      requests.set(batch, request)
      return () => { if (requests.get(batch) === request) requests.delete(batch) }
    },
    associate(backend: object, assertOriginal: () => void, cleanup?: JournalCleanupFactory) {
      if (this !== result || originals.has(backend)) throw new TypeError('Invalid native prewrite constructor')
      const descriptors = Object.getOwnPropertyDescriptors(backend)
      const check = () => {
        for (const key of Reflect.ownKeys(descriptors)) {
          const before = Reflect.get(descriptors, key) as PropertyDescriptor, now = Object.getOwnPropertyDescriptor(backend, key)
          if (!now || !('value' in now) || now.value !== before.value) throw new TypeError('Changed native writer backend')
        }
        assertOriginal()
      }
      check(); originals.set(backend, { check, requests, cleanup })
    },
  })
  return result
}

export function canJoinOriginalNativePrewrite(backend: object, id: string, owner: IssuingFactOwner, batch: EncodedFactBatch): boolean {
  const original = originals.get(backend)
  if (!original) return false
  original.check()
  const request = original.requests.get(batch)
  return !!request && request.id === id && request.owner === owner
}

/** Scheduling eligibility only; it supplies no session/readiness authority. */
export function hasOriginalNativeWriter(backend: object): boolean {
  const original=originals.get(backend)
  if(!original)return false
  try{original.check();return true}catch{return false}
}

/** Enrollment verifies the original backend; retained disposal never re-enters public methods. */
export function retainOriginalNativeJournalCleanup(backend: object, id: string, held: HeldFactOwner): NativeJournalCleanup | undefined {
  const original = originals.get(backend)
  if (!original?.cleanup) return undefined
  original.check()
  return original.cleanup(id, held)
}
export function retainManagedJournalCleanup(scopes: Map<object, NativeJournalCleanup>, backend: object, id: string, held: HeldFactOwner) {
  if (scopes.has(held.owner)) return
  const cleanup = retainOriginalNativeJournalCleanup(backend, id, held)
  if (cleanup) scopes.set(held.owner, cleanup)
}
export function settleManagedJournalCleanup(scopes: ReadonlyMap<object, NativeJournalCleanup> | undefined): Promise<void> | undefined {
  let work: NativeJournalCleanup[]
  try {
    if (!scopes?.size) return
    work = [...scopes.values()].filter(scope => scope.hasDebt())
    if (!work.length) return
  } catch (cause) {
    // Existing await callers continue receiving failures as rejected promises.
    return Promise.reject(cause)
  }
  const flights = work.map(scope => {
    try { return scope.settle() }
    catch (cause) { return Promise.reject(cause) }
  })
  return Promise.allSettled(flights).then(results => {
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw Object.assign(new FactRecoveryRequiredError(), { cause: new AggregateError(errors, 'Original journal cleanup unresolved') })
  })
}
