import type { EncodedFactBatch } from '@i-harness/core-session'
import type { IssuingFactOwner } from './coordinator/fact-types.ts'

type NativeRequest = { id: string; owner: IssuingFactOwner }
const originals = new WeakMap<object, { check(): void; requests: WeakMap<EncodedFactBatch, NativeRequest> }>()

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
    associate(backend: object, assertOriginal: () => void) {
      if (this !== result || originals.has(backend)) throw new TypeError('Invalid native prewrite constructor')
      const descriptors = Object.getOwnPropertyDescriptors(backend)
      const check = () => {
        for (const key of Reflect.ownKeys(descriptors)) {
          const before = Reflect.get(descriptors, key) as PropertyDescriptor, now = Object.getOwnPropertyDescriptor(backend, key)
          if (!now || !('value' in now) || now.value !== before.value) throw new TypeError('Changed native writer backend')
        }
        assertOriginal()
      }
      check(); originals.set(backend, { check, requests })
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
