import { expect, it, vi } from 'vitest'
const checked = vi.hoisted(() => ({ proofs: 0 }))
vi.mock('../../fs-lock/src/win32-artifact-path.ts', async load => {
  const original = await load<typeof import('../../fs-lock/src/win32-artifact-path.ts')>()
  return { ...original, checkWin32ArtifactPaths: function(this: unknown, ...args: Parameters<typeof original.checkWin32ArtifactPaths>) {
    checked.proofs += args[0].length
    return Reflect.apply(original.checkWin32ArtifactPaths, this, args)
  } }
})
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createArtifactPathOwner } from '../../fs-lock/src/artifact-path.ts'
import { assertArtifactCurrent, createArtifactCurrentGuard } from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import { createGatewayForkHost } from '../src/fork-session.ts'

it('flushes original namespace proofs before a host callback and refuses its actual source revocation', async () => {
  const f = await createGatewayForkFixture()
  const directory = join(f.root, 'independent-proof')
  await mkdir(join(directory, 'child'), { recursive: true })
  const paths = createArtifactPathOwner(directory), proof = paths.capture(join(directory, 'child', 'value'))
  let armed = false, callbacks = 0, effects = 0
  const host = createGatewayForkHost({ workspace: f.workspace, coordinator: f.coordinator, projects: f.projects, nativeContext: f.runtime,
    assertAvailable() {
      if (!armed) return
      callbacks++
      expect(checked.proofs).toBeGreaterThan(0)
      f.coordinator.revokeManagedDocumentNewWork('source')
    },
  })
  try {
    await f.coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'original' }, { type: 'turn/end' }])
    const operation = await f.prepare('source', 'target', 'callback-revocation')
    await expect(host.withHandoff(operation, { kind: 'first' }, {}, async ({ guards }) => {
      checked.proofs = 0
      const combined = createArtifactCurrentGuard(() => {
        assertArtifactCurrent(proof)
        armed = true
        guards.assertCurrent()
        effects++
      })
      combined()
    })).rejects.toThrow()
    expect(callbacks).toBe(1)
    expect(effects).toBe(0)
    expect(await f.coordinator.list()).not.toContain('target')
  } finally { armed = false; paths.settleResources(); await f.close() }
}, 15000)

it('keeps host accessor counts and callback receiver unchanged at the actual currentness boundary', async () => {
  const f = await createGatewayForkFixture()
  let reads = 0, callbacks = 0
  const options = { workspace: f.workspace, coordinator: f.coordinator, projects: f.projects, nativeContext: f.runtime,
    get assertAvailable() {
      reads++
      return function(this: unknown) { expect(this).toBe(options); callbacks++ }
    },
  }
  const host = createGatewayForkHost(options)
  try {
    await f.coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'original' }, { type: 'turn/end' }])
    const operation = await f.prepare('source', 'target', 'callback-accessor')
    await host.withHandoff(operation, { kind: 'first' }, {}, async ({ guards }) => {
      reads = callbacks = 0
      guards.assertCurrent()
      expect([reads, callbacks]).toEqual([1, 1])
    })
  } finally { await f.close() }
}, 15000)
