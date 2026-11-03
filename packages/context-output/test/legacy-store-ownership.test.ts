import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createContextOutputService } from '../src/index.ts'
import { ContextStore } from '../src/store.ts'
import { SessionLockConflictError } from '@i-harness/fs-lock'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

async function childRead(root: string, refId: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./legacy-owner-child.ts', import.meta.url)), root, refId], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const watchdog = setTimeout(() => child.kill(), 10000)
  try {
    const code = await new Promise<number | null>((accept, reject) => { child.on('error', reject); child.on('close', accept) })
    expect(code, stderr).toBe(0)
    return JSON.parse(stdout.trim())
  } finally { clearTimeout(watchdog); if (child.exitCode === null) child.kill() }
}

it('enforces the actual OS lifetime across Node processes and releases for cold read/search', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-child-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const ref = await service.capture({ sessionId: 's', callId: 'c', label: 'saved', text: 'original needle', complete: true })
    if (!ref) throw Error('capture refused')
    const index = resolve(new ContextStore(root, 'w').directory, 'index.sqlite'), before = await readFile(index)
    expect(await childRead(root, ref.id)).toEqual({ error: 'SessionLockConflictError' })
    expect(await readFile(index)).toEqual(before)
    expect((await service.read({ sessionId: 's' }, { refId: ref.id })).text).toBe('original needle')
    await service.close()
    expect(await childRead(root, ref.id)).toEqual({ text: 'original needle', hits: [ref.id] })
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)

it('allows a managed-only second owner and a different root without opening another legacy index', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-independent-')), otherRoot = await mkdtemp(resolve(tmpdir(), 'legacy-other-root-'))
  const first = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const managed = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const other = createContextOutputService({ root: otherRoot, workspaceId: 'w', config: { enabled: true } })
  try {
    await first.capture({ sessionId: 's', callId: 'c', label: 'saved', text: 'original needle', complete: true })
    const open = vi.spyOn(ContextStore.prototype, 'open')
    try {
      const scope = managed.registerResultScope({ operationId: 'managed', sessionId: 's', callId: 'managed' }, () => true)
      const sink = await managed.beginResult(scope, 'text-utf8-v1')
      await sink.write(Buffer.from('managed bytes'))
      const saved = await sink.finish('complete')
      if (saved.kind !== 'committed') throw Error('managed fixture refused')
      expect((await managed.readResult({ sessionId: 's' }, { ref: saved.ref })).data).toEqual({ kind: 'text', text: 'managed bytes' })
      expect(open).not.toHaveBeenCalled()
    } finally { open.mockRestore() }
    expect(await other.capture({ sessionId: 's', callId: 'c', label: 'other root', text: 'other root', complete: true })).toBeDefined()
  } finally { await Promise.allSettled([first.close(), managed.close(), other.close()]); await rm(root, { recursive: true, force: true }); await rm(otherRoot, { recursive: true, force: true }) }
})

it('runs the real producer and legacy policy before entering either mutation lane', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-callbacks-'))
  let callback = async () => {}
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, authorize: async () => { await callback(); return true } })
  try {
    const scope = service.registerResultScope({ operationId: 'managed', sessionId: 's', callId: 'managed' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('callback managed bytes'))
    const saved = await sink.finish('complete')
    if (saved.kind !== 'committed') throw Error('managed fixture refused')
    let calls = 0
    const ref = await service.capture({ sessionId: 's', callId: 'legacy', label: 'saved', text: 'ignored', complete: true }, undefined, async () => {
      calls++
      expect((await service.readResult({ sessionId: 's' }, { ref: saved.ref })).data).toEqual({ kind: 'text', text: 'callback managed bytes' })
      await service.capture({ sessionId: 's', callId: 'nested', label: 'nested', text: 'nested producer result', complete: true })
      return { text: 'original needle', complete: true }
    })
    if (!ref) throw Error('capture refused')
    callback = async () => {
      expect((await service.readResult({ sessionId: 's' }, { ref: saved.ref })).data).toEqual({ kind: 'text', text: 'callback managed bytes' })
      const nested = service.registerResultScope({ operationId: 'policy-write', sessionId: 's', callId: 'policy-write' }, () => true)
      const nestedSink = await service.beginResult(nested, 'text-utf8-v1')
      await nestedSink.write(Buffer.from('policy produced bytes'))
      expect((await nestedSink.finish('complete')).kind).toBe('committed')
    }
    await service.grant({ sessionId: 'fork' }, [ref.id], 'target')
    expect((await service.read({ sessionId: 'target' }, { refId: ref.id })).text).toBe('original needle')
    expect(calls).toBe(1)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('rejects a competing legacy opener before changing the live index, then cold reopens', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-owner-'))
  const first = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const second = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const separate = createContextOutputService({ root, workspaceId: 'other', config: { enabled: true } })
  try {
    const ref = await first.capture({ sessionId: 's', callId: 'c', label: 'saved', text: 'original needle', complete: true })
    if (!ref) throw Error('capture refused')
    const index = resolve(new ContextStore(root, 'w').directory, 'index.sqlite')
    const before = await readFile(index)
    const conflict = await second.read({ sessionId: 's' }, { refId: ref.id }).then(() => undefined, error => error)
    expect.soft(conflict).toBeInstanceOf(SessionLockConflictError)
    expect.soft(await readFile(index)).toEqual(before)
    expect.soft((await first.read({ sessionId: 's' }, { refId: ref.id })).text).toBe('original needle')
    expect(await separate.capture({ sessionId: 's', callId: 'c', label: 'independent', text: 'independent', complete: true })).toBeDefined()
    await first.close()
    expect((await second.read({ sessionId: 's' }, { refId: ref.id })).text).toBe('original needle')
    expect((await second.search({ sessionId: 's' }, { query: 'needle' })).hits[0]?.ref.id).toBe(ref.id)
  } finally { await Promise.allSettled([first.close(), second.close(), separate.close()]); await rm(root, { recursive: true, force: true }) }
}, 15000)

it('serializes actual managed admission behind a held legacy mutation', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-quota-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  await service.capture({ sessionId: 's', callId: 'seed', label: 'seed', text: 'seed', complete: true })
  const inventory = new ContextStore(root, 'w'), budget = await inventory.diskBytes() + 196608 + 1000
  await service.configure({ maxDiskBytes: budget })
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const original = ContextStore.prototype.put
  const held = vi.spyOn(ContextStore.prototype, 'put').mockImplementation(async function(this: ContextStore, ...args) {
    entered.resolve(); await resume.promise; return original.apply(this, args)
  })
  let completed = false
  const capture = service.capture({ sessionId: 's', callId: 'legacy', label: 'saved', text: 'needle '.repeat(2000), complete: true })
  let managed: Promise<unknown> | undefined
  try {
    await entered.promise
    const scope = service.registerResultScope({ operationId: 'managed', sessionId: 's', callId: 'managed' }, () => true)
    managed = service.beginResult(scope, 'text-utf8-v1').then(sink => { completed = true; return sink }, error => { completed = true; return error })
    // The held store turn is a causal barrier; this delay only gives a broken
    // independent mutation queue an opportunity to expose its admission.
    await new Promise(settle => setTimeout(settle, 100))
    expect(completed).toBe(false)
    resume.resolve()
    expect(await capture).toBeDefined()
    expect(await managed).toBeInstanceOf(Error)
    expect((await managed as Error).message).toMatch(/quota/i)
    expect(await inventory.diskBytes()).toBeLessThanOrEqual(budget)
  } finally { resume.resolve(); held.mockRestore(); await capture; await managed; await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('joins an opening that finishes after the permanent close fence', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-opening-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const original = ContextStore.prototype.open
  const held = vi.spyOn(ContextStore.prototype, 'open').mockImplementation(async function(this: ContextStore, ...args) {
    await original.apply(this, args); entered.resolve(); await resume.promise
  })
  const capture = service.capture({ sessionId: 's', callId: 'late', label: 'saved', text: 'needle', complete: true }).catch(error => error)
  try {
    await entered.promise
    const closing = service.close()
    resume.resolve()
    await capture; await closing
    await expect(service.read({ sessionId: 's' }, { refId: 'late' })).rejects.toThrow(/closed/)
  } finally { resume.resolve(); held.mockRestore(); await service.close(); await rm(root, { recursive: true, force: true }) }
})
