import { beforeEach, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ paths: new Map<string, string>(), held: new Map<string, object>(), acquired: [] as string[], faultKey: '', failing: true, failOnce: false, consumed: false, releases: 0 }))
vi.mock('../../fs-lock/src/artifact-path.ts', async load => {
  const actual = await load<typeof import('../../fs-lock/src/artifact-path.ts')>()
  return { ...actual, createArtifactPathOwner: () => ({ capture: (path: string) => ({ kind: 'ready', key: path.toLowerCase(), assertCurrent() { if (native.failOnce) { native.failOnce = false; throw Error('canonical namespace changed after acquisition') } } }), settleResources() {} }) }
})
vi.mock('../../fs-lock/src/index.ts', async () => { const { createHash } = await import('node:crypto'), { join } = await import('node:path'); return {
  lockPathFor(root: string, id: string) { const path = join(root, '.i-harness-locks', createHash('sha256').update(id).digest('hex').slice(0, 24) + '.lock'); native.paths.set(path, id); return path },
  async acquireSessionLock({ lockPath }: { lockPath: string }) {
    const key = native.paths.get(lockPath)!; if (native.held.has(key)) throw Error('busy')
    const identity = {}; native.held.set(key, identity); native.acquired.push(key); let held = true
    if (key === native.faultKey) native.failOnce = true
    return { get held() { return held }, async release() {
      if (key === native.faultKey) { native.releases++; if (native.failing) { if (native.consumed) { held = false; native.held.delete(key) }; throw undefined } }
      if (held) { expect(native.held.get(key)).toBe(identity); held = false; native.held.delete(key) }
    } }
  },
} })
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { coldLegacyFixture } from '../../context-output/test/fixtures/cold-selected-legacy.ts'
import * as bindings from '../../session-persistence/src/coordinator/binding-observation.ts'
import { inspectColdSelectedTarget, beginColdSelectedFinalization } from '../../session-persistence/src/selected-source-owner.ts'
beforeEach(() => { native.paths.clear(); native.held.clear(); native.acquired = []; native.faultKey = ''; native.failing = true; native.failOnce = false; native.consumed = false; native.releases = 0 })

it.each([false, true])('retains the actual cold target across unreturned canonical F0 binding acquisition cleanup, consumed=%s', async consumed => {
  let producers = 0
  const original = bindings.createBindingObservations
  const injection = vi.spyOn(bindings, 'createBindingObservations').mockImplementation((...args) => {
    const owner = original(...args), make = owner.createColdFinalizationFactory
    owner.createColdFinalizationFactory = bootstrap => make(bootstrap, { begin() { producers++; throw Error('Producer must not run before F0 acquisition') } }); return owner
  })
  const f = await coldLegacyFixture(true); injection.mockRestore()
  try {
    const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
    const key = 'desktop-session-project-' + createHash('sha256').update('target').digest('hex')
    native.faultKey = 'artifact-ownership:' + join(f.root, key + '.doc.jsonl').toLowerCase(); native.consumed = consumed
    const attempt = beginColdSelectedFinalization(f.coordinator, target.target)
    await expect(attempt.use()).rejects.toThrow(); expect(native.acquired).toContain(native.faultKey); expect(producers).toBe(0)
    const cleanup = await attempt.close().then(() => ({ failed: false }), error => ({ failed: true, error }))
    await f.coordinator.closeManagedDocument('target').catch(() => {})
    expect(f.coordinator.ownerOf('target')).toBe(true); expect(cleanup.failed).toBe(true)
    const acquisitions = [...native.acquired], releases = native.releases
    native.failing = false
    if (consumed) {
      await expect(attempt.retryClose()).rejects.toThrow(); expect(native.releases).toBe(releases); expect(f.coordinator.ownerOf('target')).toBe(true)
    } else {
      await attempt.retryClose(); await f.coordinator.closeManagedDocument('target'); expect(f.coordinator.ownerOf('target')).toBe(false)
    }
    expect(native.acquired).toEqual(acquisitions); expect(producers).toBe(0)
  } finally { injection.mockRestore(); native.failing = false; await f.coordinator.close().catch(() => {}); await f.service.close() }
})
