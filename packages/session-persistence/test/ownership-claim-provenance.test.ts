import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnership, captureHeldOwnershipClaim } from '../src/coordinator/ownership.ts'

it('captures only the original live claim of the exact lock-enabled owner and session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-claim-'))
  const owner = createOwnership({ lockRoot: root }, { lock: { enabled: true } })
  const foreign = createOwnership({ lockRoot: root }, { lock: { enabled: true } })
  const disabled = createOwnership({ lockRoot: root })
  const claim = await owner.pinOwnership('parent')
  const noop = await disabled.pinOwnership('parent')
  try {
    const captured = captureHeldOwnershipClaim(owner, 'parent', claim)
    expect(Object.isFrozen(captured)).toBe(true)
    captured.assertHeld()
    for (const [o, id, c] of [[foreign, 'parent', claim], [owner, 'other', claim], [owner, 'parent', { ...claim }], [owner, 'parent', new Proxy(claim, {})], [disabled, 'parent', noop]] as const) {
      expect(() => captureHeldOwnershipClaim(o, id, c)).toThrow()
    }
    const original = claim.assertHeld
    claim.assertHeld = () => {}
    expect(() => captured.assertHeld()).toThrow()
    expect(() => captureHeldOwnershipClaim(owner, 'parent', claim)).toThrow()
    claim.assertHeld = original
    captured.assertHeld()
    expect(() => captured.assertHeld.call({})).toThrow()
    const release = claim.release
    claim.release = async () => {}
    expect(() => captured.assertHeld()).toThrow()
    claim.release = release
    Object.defineProperty(claim, 'assertHeld', { configurable: true, get: () => original })
    expect(() => captured.assertHeld()).toThrow()
    Object.defineProperty(claim, 'assertHeld', { configurable: true, writable: true, value: original })
    await claim.release()
    expect(() => captured.assertHeld()).toThrow()
    expect(() => captureHeldOwnershipClaim(owner, 'parent', claim)).toThrow()
  } finally {
    await claim.release()
    await noop.release()
    await rm(root, { recursive: true, force: true })
  }
})
