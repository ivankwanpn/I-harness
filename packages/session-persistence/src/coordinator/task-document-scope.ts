import { assertHeldWithArtifactGuard } from './artifact-path-association.ts'
import { types } from 'node:util'
import { captureHeldOwnershipClaim, type Ownership } from './ownership.ts'
import type { HeldTaskDocumentScope } from './task-document-types.ts'

const scopes = new WeakSet<object>()

/** Identity check for a backend. Currentness is checked by assertActive. */
export function isHeldTaskDocumentScope(value: unknown): value is HeldTaskDocumentScope {
  return typeof value === 'object' && value !== null && scopes.has(value)
}

/**
 * Internal staging point for the future acquired Documents operation owner.
 * Its trusted original admission must check readiness, its document lease and
 * revocation. This function neither acquires nor authenticates that lease.
 */
export function issueHeldTaskDocumentScope(
  owner: Ownership,
  parentSessionId: string,
  claim: Awaited<ReturnType<Ownership['pinOwnership']>>,
  admission: { assertActive(): void },
): HeldTaskDocumentScope {
  const held = captureHeldOwnershipClaim(owner, parentSessionId, claim)
  if (typeof admission !== 'object' || admission === null || types.isProxy(admission)) throw new TypeError('Invalid operation admission')
  const descriptor = Object.getOwnPropertyDescriptor(admission, 'assertActive')
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) throw new TypeError('Invalid operation admission assertion')
  const original = descriptor.value
  const check = () => {
    const current = Object.getOwnPropertyDescriptor(admission, 'assertActive')
    if (!current || !('value' in current) || current.value !== original) throw new TypeError('Changed operation admission assertion')
    assertHeldWithArtifactGuard(() => held.assertHeld(), original, admission)
  }
  check()
  const scope = Object.freeze({ parentSessionId, key: `task-${parentSessionId}`, assertActive() {
    if (this !== scope) throw new TypeError('Invalid task document scope receiver')
    check()
  } })
  scopes.add(scope)
  return scope as HeldTaskDocumentScope
}
