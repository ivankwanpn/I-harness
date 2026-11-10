import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, unlink } from 'node:fs/promises'
import { fixture, type Fixture } from './helpers/instruction-fixture.ts'
import type { InstructionSnapshot } from '../src/index.ts'

let f: Fixture
beforeEach(async () => { f = await fixture() })
afterEach(async () => { await f.cleanup() })

it('classifies only a genuine snapshot invalidated by the same healthy source owner', async () => {
  const path = await f.write('AGENTS.md', 'original current instructions'), service = f.service()
  const snapshot = await service.prepare([]), updates = f.observation.updates
  expect(service.canReobserve!(snapshot)).toBe(false)
  service.invalidate([path])
  expect(service.canReobserve!(snapshot)).toBe(true)
  expect(service.canReobserve!({ ...snapshot })).toBe(false)
  let getter = false
  const forged = Object.defineProperty({}, 'complete', { get() { getter = true; throw Error('Foreign snapshot getter') } })
  expect(service.canReobserve!(forged as InstructionSnapshot)).toBe(false)
  expect(getter).toBe(false)
  expect(f.observation.updates).toBe(updates)
  const foreign = f.service(), foreignSnapshot = await foreign.prepare([])
  expect(service.canReobserve!(foreignSnapshot)).toBe(false)
  const current = await service.prepare([])
  expect(service.canReobserve!(current)).toBe(false)
  await service.close()
  expect(service.canReobserve!(snapshot)).toBe(false)
})

it('refuses backend unavailability and a recovered but different observation health epoch', async () => {
  const path = await f.write('AGENTS.md', 'original instructions'), service = f.service()
  const snapshot = await service.prepare([])
  f.observation.emit([path], 'availability', [], false)
  expect(service.canReobserve!(snapshot)).toBe(false)
  f.observation.emit([], 'reset', [], true)
  service.invalidate([path])
  expect(service.canReobserve!(snapshot)).toBe(false)
  const recovered = await service.prepare([])
  service.invalidate([path])
  expect(service.canReobserve!(recovered)).toBe(true)
})

it('refuses a candidate mapping invalidation even when backend availability remains true', async () => {
  const path = await f.write('AGENTS.md', 'original instructions'), service = f.service()
  const snapshot = await service.prepare([])
  f.observation.state = { ...f.observation.state, revision: f.observation.state.revision + 1, mappingPaths: [path] }
  f.observation.listener!({ ...f.observation.state, kind: 'changed', paths: [path] })
  expect(service.canReobserve!(snapshot)).toBe(false)
})

it('refuses a real failed source read after the known invalidation is reobserved', async () => {
  const path = await f.write('AGENTS.md', 'original instructions'), service = f.service()
  const snapshot = await service.prepare([])
  await unlink(path); await mkdir(path)
  service.invalidate([path])
  expect(service.canReobserve!(snapshot)).toBe(true)
  const failed = await service.prepare([])
  expect(failed.complete).toBe(false)
  expect(service.canReobserve!(snapshot)).toBe(false)
  expect(service.canReobserve!(failed)).toBe(false)
})
