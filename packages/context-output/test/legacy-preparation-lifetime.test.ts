import { expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextStore } from '../src/store.ts'
import { legacyFixture } from './legacy-fork-fixture.ts'

async function removeFixture(root: string | undefined) {
  if (!root) return
  const parent = resolve(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT ?? tmpdir())
  if (dirname(resolve(root)) !== parent || !basename(root).startsWith('ih-l1-')) throw Error('Unsafe fixture cleanup')
  await rm(root, { recursive: true, force: true })
}

it('joins all genuine overlapping preparation jobs before reporting a failure and retiring their original lifetime', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const failure = Error('original producer refused'), original = ContextStore.prototype.put
  const stores = new Set<ContextStore>()
  let root: string | undefined, settled = false
  const put = vi.spyOn(ContextStore.prototype, 'put').mockImplementation(async function(this: ContextStore, ...args) {
    stores.add(this); root = dirname(dirname(this.directory))
    const callId = args[2].ref.callId
    if (callId === 'VISIBLE-1') throw failure
    if (callId === 'VISIBLE-2') { entered.resolve(); await release.promise }
    return original.apply(this, args)
  })
  const pending = legacyFixture({ distinct: 4, concurrentPrepare: true })
  void pending.then(() => { settled = true }, () => { settled = true })
  try {
    await entered.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    expect([...stores].some(store => !store.lifetimeSettled())).toBe(true)
    release.resolve()
    await expect(pending).rejects.toMatchObject({ message: 'Original concurrent fixture preparation failed', errors: expect.arrayContaining([failure]) })
    expect([...stores].every(store => store.lifetimeSettled())).toBe(true)
  } finally {
    release.resolve(); await pending.catch(() => undefined); put.mockRestore()
    await removeFixture(root)
  }
}, 30000)

it('joins later grant batches after an actual grant response is lost before closing the original lifetime', async () => {
  const failure = Error('original grant response lost'), original = ContextStore.prototype.addOwners
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let store: ContextStore | undefined, ids: string[] = [], calls = 0
  let batchStarted = false, settled = false
  const grant = vi.spyOn(ContextStore.prototype, 'addOwners').mockImplementation(async function(this: ContextStore, ...args) {
    store = this
    if (args[2].length === 100) { batchStarted = true; ids = [...args[2]] }
    else if (batchStarted) { entered.resolve(); await release.promise; ids.push(...args[2]) }
    await original.apply(this, args)
    if (args[2].length === 100) { calls++; throw failure }
  })
  const pending = legacyFixture({ distinct: 102, concurrentPrepare: true })
  void pending.then(() => { settled = true }, () => { settled = true })
  try {
    await entered.promise
    expect(settled).toBe(false); expect(store!.lifetimeSettled()).toBe(false)
    release.resolve()
    await expect(pending).rejects.toMatchObject({ message: 'Original concurrent fixture preparation failed', errors: expect.arrayContaining([failure]) })
    expect(calls).toBe(1); expect(ids).toHaveLength(101)
    expect(store!.lifetimeSettled()).toBe(true)
    expect(ids.map(id => store!.get(id)?.callId)).toEqual(Array.from({ length: 101 }, (_, i) => `VISIBLE-${i + 1}`))
    expect(ids.every(id => store!.owns(id, 'source'))).toBe(true)
  } finally { release.resolve(); await pending.catch(() => undefined); grant.mockRestore(); await removeFixture(store ? dirname(dirname(store.directory)) : undefined) }
}, 30000)

it('prepares more than 100 real references through ordered public grant batches within the existing limit', async () => {
  const original = ContextStore.prototype.addOwners, batches: string[][] = []
  const grant = vi.spyOn(ContextStore.prototype, 'addOwners').mockImplementation(function(this: ContextStore, ...args) {
    batches.push([...args[2]])
    return original.apply(this, args)
  })
  let f: Awaited<ReturnType<typeof legacyFixture>> | undefined
  try {
    f = await legacyFixture({ distinct: 102, concurrentPrepare: true })
    expect(batches.every(batch => batch.length <= 100)).toBe(true)
    expect(batches.slice(3).map(batch => batch.length)).toEqual([100, 1])
    expect(batches.slice(3).flat()).toEqual(f.selectedRefs.slice(1).map(ref => ref.id))
    expect(f.selectedRefs).toHaveLength(102)
  } finally { grant.mockRestore(); if (f) { await f.close(); await removeFixture(f.root) } }
}, 30000)
