import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'

function live(owner: { ownerOf(id: string): boolean; hasLiveOwnership?(id: string): boolean }, id: string) {
  return owner.hasLiveOwnership ? owner.hasLiveOwnership(id) : owner.ownerOf(id)
}
async function root() {
  const base = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (!base) throw new Error('Fresh native evidence root required')
  return mkdtemp(join(base, 'adoption-'))
}
it('distinguishes the original live adopter from a native observation pin', async () => {
  const dir = await root(), owner = createOwnership({ lockRoot: dir }, { lock: { enabled: true } })
  const pin = await owner.pinOwnership('session')
  try {
    expect(owner.ownerOf('session')).toBe(true)
    expect(live(owner, 'session')).toBe(false)
    await owner.ensureOwnership('session')
    expect(live(owner, 'session')).toBe(true)
    await owner.releaseOwnershipUnlocked('session')
    expect(live(owner, 'session')).toBe(false)
    expect(owner.ownerOf('session')).toBe(true)
    pin.assertHeld()
    await pin.release()
    expect(owner.ownerOf('session')).toBe(false)
  } finally { await owner.releaseOwnershipUnlocked('session'); await pin.release(); await rm(dir, { recursive: true, force: true }) }
})
it('forwards actual cold observation and persistent adoption independently', async () => {
  const dir = await root(), coordinator = createJsonlTaskTransitionCoordinator(dir, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'session' })
    await coordinator.releaseOwnership('session')
    await coordinator.withExistingSessionBindingObservation!({ sessionIds: ['session'] }, async () => {
      expect(coordinator.ownerOf('session')).toBe(true)
      expect(live(coordinator, 'session')).toBe(false)
    })
    expect(coordinator.ownerOf('session')).toBe(false)
    await coordinator.adoptOwnership('session')
    expect(live(coordinator, 'session')).toBe(true)
    await coordinator.withExistingSessionBindingObservation!({ sessionIds: ['session'] }, async () => { expect(live(coordinator, 'session')).toBe(true) })
    expect(live(coordinator, 'session')).toBe(true)
    await coordinator.releaseOwnership('session')
    expect(live(coordinator, 'session')).toBe(false)
  } finally { await coordinator.close(); await rm(dir, { recursive: true, force: true }) }
})
