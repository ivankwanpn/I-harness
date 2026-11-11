import { expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ losePageReply: false, lost: 0, measuring: false, writes: 0, syncs: 0, bodies: 0 }))
vi.mock('node:fs/promises', async load => {
  const fs = await load<typeof import('node:fs/promises')>()
  return {
    ...fs,
    async link(...args: Parameters<typeof fs.link>) {
      if (io.measuring) io.writes++
      await fs.link(...args)
      if (io.losePageReply && String(args[1]).replaceAll('\\', '/').endsWith('/pages/0-0.json')) {
        io.losePageReply = false; io.lost++
        throw Error('Original page link acknowledgment lost')
      }
    },
    async open(...args: Parameters<typeof fs.open>) {
      const path = String(args[0])
      if (io.measuring) {
        if (args[1] !== 'r') io.writes++
        if (/[\\/]blobs[\\/]/.test(path)) io.bodies++
      }
      const handle = await fs.open(...args), sync = handle.sync.bind(handle)
      handle.sync = async () => { if (io.measuring) io.syncs++; await sync() }
      return handle
    },
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      if (io.measuring) io.writes++
      return fs.writeFile(...args)
    },
    async unlink(...args: Parameters<typeof fs.unlink>) {
      if (io.measuring) io.writes++
      return fs.unlink(...args)
    },
  }
})

import { readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { legacyFixture } from './legacy-fork-fixture.ts'
import { coldLegacyFixture } from './fixtures/cold-selected-legacy.ts'
import { acquireColdSelectedQualification, acquireSelectedMetadata } from '../src/service.ts'
import { inspectColdSelectedTarget, useColdSelectedTarget } from '../../session-persistence/src/selected-source-owner.ts'
import { ContextStore } from '../src/store.ts'
import { pendingPath } from '../src/artifact/io.ts'
import { physicalBytes } from '../src/artifact/quota.ts'

function measure() { io.writes = io.syncs = io.bodies = 0; io.measuring = true }
function assertReadOnly() { io.measuring = false; expect([io.writes, io.syncs, io.bodies]).toEqual([0, 0, 0]) }

it('recovers the original lost page reply and reads its retained pending sibling through ordinary and cold metadata EOF', async () => {
  const f = await legacyFixture()
  try {
    io.lost = 0; io.losePageReply = true
    let recovered = false
    expect((await f.run(false, undefined, undefined, false, async original => {
      expect(io.lost).toBe(1)
      expect(await f.service().confirmLegacyForkTransfer(original, f.phase(), () => true, f.facts())).toEqual({ kind: 'confirmed' })
      recovered = true
    })).kind).toBe('blocked')
    expect(recovered).toBe(true)
    expect((await f.run()).kind).toBe('ready')
    const store = new ContextStore(f.root, 'workspace'), namespace = join(store.directory, 'legacy-fork-v1')
    const [operation] = await readdir(namespace), path = join(namespace, operation!, 'pages', '0-0.json')
    const final = await readFile(path), pending = pendingPath(path, final), retained = await readFile(pending)
    expect(retained).toEqual(final)
    const total = await physicalBytes(store.directory)
    for (const cold of [false, true]) {
      if (cold) await f.reopen()
      const observation = await f.observation()
      measure()
      const selected = await acquireSelectedMetadata(f.service(), observation)
      try {
        const rows = []
        for await (const row of selected.reader.legacy()) rows.push(row)
        expect(rows.map(row => row.ref.id)).toEqual([f.visible.id])
        selected.assertCurrent()
      } finally { await selected.close() }
      assertReadOnly()
      expect(await readFile(pending)).toEqual(retained)
      expect(await physicalBytes(store.directory)).toBe(total)
    }
  } finally { io.measuring = false; io.losePageReply = false; await f.close() }
// Two actual bootstrap attempts, original recovery, and a complete cold reopen.
}, 30_000)

it.each(['control', 'page'] as const)('refuses a corrupt pending prefix, foreign name and missing final for an original %s', async kind => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const store = new ContextStore(f.root, 'workspace'), namespace = join(store.directory, 'legacy-fork-v1')
    const [operation] = await readdir(namespace), directory = join(namespace, operation!)
    const path = kind === 'control' ? join(directory, 'plan.json') : join(directory, 'pages', '0-0.json')
    const original = await readFile(path), pending = pendingPath(path, original)
    for (const fault of ['prefix', 'name', 'final'] as const) {
      const candidate = fault === 'name' ? path + '.foreign.pending' : pending
      const bytes = fault === 'prefix' ? Buffer.from('foreign bytes') : original.subarray(0, Math.min(7, original.length))
      await writeFile(candidate, bytes)
      if (fault === 'final') await unlink(path)
      const observation = await f.observation()
      measure()
      await expect(acquireSelectedMetadata(f.service(), observation)).rejects.toThrow()
      assertReadOnly()
      expect(await readFile(candidate)).toEqual(bytes)
      if (fault === 'final') {
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(path, original)
      } else expect(await readFile(path)).toEqual(original)
      await unlink(candidate)
    }
  } finally { io.measuring = false; await f.close() }
}, 15_000)

it('qualifies a genuine cold V2 target with exact control and page pending prefixes without creating a writer or index', async () => {
  const f = await coldLegacyFixture()
  try {
    const paths = ['binding.json', 'plan.json', 'applied.json'].map(name => join(f.directory, name))
    paths.push(...(await readdir(join(f.directory, 'pages'))).map(name => join(f.directory, 'pages', name)))
    const retained = new Map<string, Buffer>()
    for (const path of paths) {
      const final = await readFile(path), pending = pendingPath(path, final), prefix = final.subarray(0, Math.min(7, final.length))
      await writeFile(pending, prefix); retained.set(pending, prefix)
    }
    const store = new ContextStore(f.root, 'w'), total = await physicalBytes(store.directory)
    const target = await inspectColdSelectedTarget(f.coordinator, f.route)
    if (target.kind !== 'qualification-required') throw Error('Original cold target required')
    let selected!: ReturnType<typeof acquireColdSelectedQualification>
    await useColdSelectedTarget(f.coordinator, target.target, async cold => {
      selected = acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId)
      measure()
      await selected.qualify(); selected.sealWhileActive()
    })
    await selected.settle(); selected.assertSettledCurrent(); await selected.close()
    assertReadOnly()
    for (const [path, prefix] of retained) expect(await readFile(path)).toEqual(prefix)
    expect(await physicalBytes(store.directory)).toBe(total)
  } finally { io.measuring = false; await f.close() }
}, 15_000)
