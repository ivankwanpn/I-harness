import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const hooks = vi.hoisted(() => ({ body: undefined as undefined | (() => Promise<void> | void) }))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native, async writeFile(...args: Parameters<typeof native.writeFile>) {
    const result = await native.writeFile(...args)
    if (hooks.body && /[/\\]blobs[/\\]ctx_[a-f0-9]+\.txt$/.test(String(args[0]))) {
      const effect = hooks.body; hooks.body = undefined
      await effect()
    }
    return result
  } }
})
import { createContextOutputService } from '../src/index.ts'
import { ContextStore } from '../src/store.ts'
import { DatabaseSync } from 'node:sqlite'
import { LegacyIndexLifecycle, type IndexUse } from '../src/legacy/index-lifecycle.ts'

const roots: string[] = []
afterEach(async () => {
  hooks.body = undefined; vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-capture-admission-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-capture-admission-')); roots.push(root)
  const service = createContextOutputService({ root, workspaceId: 'workspace', config: { enabled: true, maxDiskBytes: 2 * 1024 * 1024 } })
  const capture = (callId: string, signal?: AbortSignal) => service.capture({ sessionId: 'source', callId, label: callId, text: `retained ${callId}`, complete: true }, signal)
  const first = await capture('first')
  if (!first) throw Error('Original capture refused')
  return { root, service, capture, first }
}

it('uses one capture allocation, final inventory and retained-index reopening inventory', async () => {
  const f = await fixture()
  const inventory = vi.spyOn(ContextStore.prototype, 'diskBytes')
  try {
    const ref = await f.capture('second')
    expect(ref).toBeDefined()
    expect(inventory).toHaveBeenCalledTimes(3)
    expect((await f.service.read({ sessionId: 'source' }, { refId: ref!.id })).text).toBe('retained second')
    expect((await f.service.read({ sessionId: 'source' }, { refId: f.first.id })).text).toBe('retained first')
  } finally { await f.service.close() }
}, 30000)

it('reuses qualified metadata only after its unchanged namespace witness and still qualifies the next handoff', async () => {
  const f = await fixture(), inventory = vi.spyOn(ContextStore.prototype, 'passiveInventory')
  try {
    expect((await f.service.read({ sessionId: 'source' }, { refId: f.first.id })).text).toBe('retained first')
    // The unchanged reacquisition verifies the namespace fingerprint directly;
    // the one full metadata inspection belongs to the subsequent handoff.
    expect(inventory).toHaveBeenCalledTimes(1)
  } finally { await f.service.close() }
}, 30000)

it('refuses unknown physical growth after admission before publishing and preserves the foreign bytes', async () => {
  const f = await fixture()
  const foreignBytes = Buffer.alloc(3 * 1024 * 1024, 7)
  let path = ''
  const put = ContextStore.prototype.put
  const store = vi.spyOn(ContextStore.prototype, 'put').mockImplementation(function(this: ContextStore, ...args) {
    path = join(this.directory, 'foreign-growth.bin')
    return put.apply(this, args)
  })
  try {
    hooks.body = () => writeFile(path, foreignBytes)
    await expect(f.capture('over-quota')).rejects.toThrow(/quota/)
    expect((await readFile(path)).equals(foreignBytes)).toBe(true)
    expect(f.service.status().results).toBe(1)
    await unlink(path)
    store.mockRestore()
    const ref = await f.capture('retry')
    expect(ref).toBeDefined()
    expect((await f.service.read({ sessionId: 'source' }, { refId: f.first.id })).text).toBe('retained first')
  } finally { await f.service.close() }
}, 30000)

it.each(['cancel', 'native-write', 'sqlite-write', 'inventory-read'] as const)('retires the same capture admission after %s failure and permits a fresh retry', async failure => {
  const f = await fixture(), controller = new AbortController(), injected = Error('injected original write failure')
  const exec = DatabaseSync.prototype.exec
  let armed = failure === 'sqlite-write'
  const sql = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, statement: string) {
    if (armed && statement === 'BEGIN IMMEDIATE') { armed = false; throw injected }
    return exec.call(this, statement)
  })
  const diskBytes = ContextStore.prototype.diskBytes
  let bodyWritten = false, readFailed = false
  const inventory = vi.spyOn(ContextStore.prototype, 'diskBytes').mockImplementation(function(this: ContextStore, ...args) {
    if (failure === 'inventory-read' && bodyWritten && !readFailed) { readFailed = true; return Promise.reject(injected) }
    return diskBytes.apply(this, args)
  })
  try {
    if (failure !== 'sqlite-write') hooks.body = () => { bodyWritten = true; if (failure === 'cancel') controller.abort(); else if (failure === 'native-write') throw injected }
    await expect(f.capture('failed', controller.signal)).rejects.toThrow()
    expect(f.service.status().results).toBe(1)
    sql.mockRestore(); inventory.mockRestore()
    const retry = await f.capture('failed')
    expect(retry).toBeDefined()
    expect((await f.service.read({ sessionId: 'source' }, { refId: retry!.id })).text).toBe('retained failed')
  } finally { await f.service.close() }
}, 30000)

it('rejects reuse of the original operation admission after its capture and writer turn have settled', async () => {
  const f = await fixture(), admitted = vi.spyOn(LegacyIndexLifecycle.prototype, 'admitCapture')
  try {
    expect(await f.capture('second')).toBeDefined()
    const token = await admitted.mock.results.at(-1)!.value
    let writes = 0
    expect(() => token.write({} as IndexUse, () => { writes++ })).toThrow('Stale capture index admission')
    expect(writes).toBe(0)
  } finally { await f.service.close() }
}, 30000)
