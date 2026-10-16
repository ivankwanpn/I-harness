import type { OwnerToken } from '@i-harness/core-session'
import type { HeldFactOwner, IssuingFactOwner } from './fact-types.ts'
import type { Ownership } from './ownership.ts'

const contexts = new WeakSet<object>()
/** Backend validation only; constructors remain internal to this owner. */
export function isHeldFactOwner(value: unknown): value is HeldFactOwner {
  return typeof value === 'object' && value !== null && contexts.has(value)
}
export function heldFactOwner(owner: OwnerToken, ownership: Ownership, assertLive: () => void): HeldFactOwner {
  const context = Object.freeze({ owner: Object.freeze({ ...owner }), assertHeld() {
    assertLive()
    ownership.assertHeld(owner.sessionId)
  } })
  contexts.add(context)
  return context
}
export function issuingFactOwner(held: HeldFactOwner, beforeIssue: () => void): IssuingFactOwner {
  if (!isHeldFactOwner(held)) throw new TypeError('Invalid held fact owner scope')
  const context = Object.freeze({ ...held, beforeIssue })
  contexts.add(context)
  return context
}
