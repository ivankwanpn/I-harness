import { composeOriginalArtifactGuards, isArtifactCurrentGuard, withImmediateArtifactCurrentChecks } from './artifact-path-association.ts'
import type { JournalPrefix, OwnerToken } from '@i-harness/core-session'
import type { HeldFactOwner, IssuingFactOwner } from './fact-types.ts'
import type { Ownership } from './ownership.ts'
import {originalOwnershipArtifactGuard} from './ownership.ts'

const contexts = new WeakSet<object>()
const archivePrefixes = new WeakMap<HeldFactOwner, Readonly<JournalPrefix>>()
/** Backend validation only; constructors remain internal to this owner. */
export function isHeldFactOwner(value: unknown): value is HeldFactOwner {
  return typeof value === 'object' && value !== null && contexts.has(value)
}
export function heldFactOwner(owner: OwnerToken, ownership: Ownership, assertLive: () => void, archivePrefix?: Readonly<JournalPrefix>): HeldFactOwner {
  const originalOwnership = originalOwnershipArtifactGuard(ownership, owner.sessionId)
  const assertHeld = isArtifactCurrentGuard(assertLive) && originalOwnership
    ? composeOriginalArtifactGuards(assertLive, originalOwnership)
    : () => withImmediateArtifactCurrentChecks(() => { assertLive(); ownership.assertHeld(owner.sessionId) })
  const context = Object.freeze({ owner: Object.freeze({ ...owner }), assertHeld })
  contexts.add(context)
  if (archivePrefix) archivePrefixes.set(context, archivePrefix)
  return context
}

/** Only the exact initial writer carries the archive observation. It confers
 * no write authority and does not propagate to issuing children. */
export function readOriginalHeldArchivePrefix(held: HeldFactOwner): Readonly<JournalPrefix> | undefined {
  const prefix = archivePrefixes.get(held)
  if (prefix) held.assertHeld()
  return prefix
}

export function issuingFactOwner(held: HeldFactOwner, beforeIssue: () => void): IssuingFactOwner {
  if (!isHeldFactOwner(held)) throw new TypeError('Invalid held fact owner scope')
  const context = Object.freeze({ ...held, beforeIssue })
  contexts.add(context)
  return context
}
