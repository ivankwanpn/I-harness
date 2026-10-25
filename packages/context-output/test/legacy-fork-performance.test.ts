import { expect, it, vi } from 'vitest'
import { probe, observeFs, observeHash, observeSql } from './helpers/legacy-performance-probe.ts'
vi.mock('node:fs/promises', async original => observeFs(await original<typeof import('node:fs/promises')>()))
vi.mock('node:crypto', async original => {
  const native = await original<typeof import('node:crypto')>()
  return { ...native, createHash: observeHash(native.createHash) }
})
vi.mock('../src/legacy/observed-read.ts', async original => {
  const native = await original<typeof import('../src/legacy/observed-read.ts')>()
  return { ...native, loadPlan(...args: Parameters<typeof native.loadPlan>) {
    probe.transition('final-proof')
    return native.loadPlan(...args)
  } }
})
vi.mock('../src/legacy/fork-pages.ts', async original => {
  const native = await original<typeof import('../src/legacy/fork-pages.ts')>()
  return { ...native, walkPages(...args: Parameters<typeof native.walkPages>) {
    const originalWalk = native.walkPages(...args), next = originalWalk.next.bind(originalWalk)
    let started = false
    originalWalk.next = (...input: Parameters<typeof next>) => { if (!started) { started = true; probe.add('graphWalks') } return next(...input) }
    return originalWalk
  } }
})
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { ContextStore } from '../src/store.ts'
import { createWorkspaceMutationOwner, type WorkspaceMutationTurn } from '../src/workspace-mutation.ts'
import { physicalBytes } from '../src/artifact/quota.ts'
import { legacyFixture } from './legacy-fork-fixture.ts'

const evidence = process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!
const nativeExec = DatabaseSync.prototype.exec
vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) { const result = nativeExec.call(this, sql); observeSql(sql); return result })
const openStore = ContextStore.prototype.open
vi.spyOn(ContextStore.prototype, 'open').mockImplementation(function(this: ContextStore, ...args) { return probe.phase('startup', () => openStore.apply(this, args)) })
const confirm = ContextStore.prototype.confirmLegacyIndex
vi.spyOn(ContextStore.prototype, 'confirmLegacyIndex').mockImplementation(function(this: ContextStore, ...args) { probe.transition('funding'); return confirm.apply(this, args) })
const merge = ContextStore.prototype.mergeLegacyOwner
vi.spyOn(ContextStore.prototype, 'mergeLegacyOwner').mockImplementation(function(this: ContextStore, ...args) { probe.transition('owner-application'); return merge.apply(this, args) })
const body = ContextStore.prototype.verifyBody
vi.spyOn(ContextStore.prototype, 'verifyBody').mockImplementation(function(this: ContextStore, ...args) { return probe.phase('body-verification', () => body.apply(this, args)) })
const prune = ContextStore.prototype.prune
vi.spyOn(ContextStore.prototype, 'prune').mockImplementation(function(this: ContextStore, ...args) { return probe.phase('expiry-sweep', () => prune.apply(this, args)) })
// The private method is observed only in this test; no product API is added.
const internal = ContextStore.prototype as unknown as { admitLegacyIndex(turn: WorkspaceMutationTurn, quota: number, growth: number): Promise<void> }
const admission = internal.admitLegacyIndex
vi.spyOn(internal, 'admitLegacyIndex').mockImplementation(function(this: ContextStore, ...args) { return probe.phase('index-admission', () => admission.apply(this, args)) })

async function receipt(name: string, extra: Record<string, unknown> = {}) {
  const measured = probe.snapshot(); probe.enabled = false
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, `${name}.json`), JSON.stringify({ name, ...extra, ...measured }, null, 2))
  console.info('Actual legacy I/O:', JSON.stringify({ name, ...extra, ...measured, spans: measured.spans.filter(span => !['body-verification', 'index-admission', 'expiry-sweep'].includes(span.phase)), segments: undefined }))
}

it('uses one actual physical snapshot for an index admission predicate and SQLite ceiling', async () => {
  await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence, 'admission-')), owner = createWorkspaceMutationOwner({ root, workspaceId: 'workspace' })
  const store = new ContextStore(root, 'workspace', owner)
  await store.acquireLifetime(); await owner.mutate(turn => store.open(turn, 8 * 1024 * 1024))
  const total = await physicalBytes(store.directory), index = (await stat(join(store.directory, 'index.sqlite'))).size
  const quota = total + index + 32768 + 12345
  probe.reset()
  try {
    await probe.run('admission-control', 'index-admission', () => owner.mutate(turn => store.resetLegacyIndex(turn, 'probe', quota)))
    expect.soft(probe.total('inventories', 'admission-control')).toBe(1)
    expect(probe.ceilings).toEqual([Math.floor((quota - total - 32768) / 4096)])
    expect(probe.total('lstat')).toBeGreaterThan(0)
    expect(probe.activeIO).toBe(0)
  } finally { await receipt('single-admission', { total, index, quota }); await store.close(); await owner.close() }
})

it('refuses journal headroom shortage, invalid budgets and overflow before index growth, then admits a raised budget', async () => {
  await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence, 'headroom-')), owner = createWorkspaceMutationOwner({ root, workspaceId: 'workspace' })
  const store = new ContextStore(root, 'workspace', owner)
  await store.acquireLifetime(); await owner.mutate(turn => store.open(turn, 8 * 1024 * 1024))
  const total = await physicalBytes(store.directory), index = (await stat(join(store.directory, 'index.sqlite'))).size
  probe.reset()
  try {
    await probe.run('refusal-controls', 'index-admission', async () => {
      await expect(owner.mutate(turn => internal.admitLegacyIndex.call(store, turn, total + index + 32768 - 1, 0))).rejects.toMatchObject({ code: 'ARTIFACT_QUOTA' })
      await expect(owner.mutate(turn => internal.admitLegacyIndex.call(store, turn, NaN, 0))).rejects.toThrow('Invalid artifact quota')
      await expect(owner.mutate(turn => internal.admitLegacyIndex.call(store, turn, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))).rejects.toThrow('Invalid artifact quota')
      await expect(owner.mutate(turn => internal.admitLegacyIndex.call(store, turn, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - index - 32768))).rejects.toMatchObject({ code: 'ARTIFACT_QUOTA' })
    })
    expect(probe.ceilings).toEqual([])
    expect(await physicalBytes(store.directory)).toBe(total)
    await probe.run('raised-budget', 'index-admission', () => owner.mutate(turn => store.resetLegacyIndex(turn, 'raised', total + index + 32768 + 65536)))
    expect(probe.ceilings).toHaveLength(1)
    expect(probe.activeIO).toBe(0)
  } finally { await receipt('headroom-refusals', { total, index }); await store.close(); await owner.close() }
})

it.each([
  { name: 'actual11', distinct: 11, observations: 1 },
  { name: 'actual31', distinct: 31, observations: 1 },
  { name: 'actual101', distinct: 101, observations: 1 },
  { name: 'repeated101', distinct: 1, observations: 101 },
])('records original I/O and resources for $name without substituting inventory or native work', async ({ name, distinct, observations }) => {
  probe.reset()
  let f: Awaited<ReturnType<typeof legacyFixture>>
  try { f = await probe.run('fixture-setup', 'capture-and-grant', () => legacyFixture({ distinct, observations, summary: true })) }
  catch (failure) { await receipt(name, { distinct, observations: distinct * observations, setupFailed: true }); throw failure }
  let assertionMs = 0
  try {
    const outcome = await probe.run('transfer-owner', 'owner-total', () => { probe.transition('graph-publication'); return f.run() })
    const assertStart = performance.now()
    await probe.run('assertions', 'canonical-checks', async () => {
      expect(outcome.kind).toBe('ready')
      const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
      const plans = join(directory, 'legacy-fork-v1'), operation = (await readdir(plans))[0]!
      const plan = JSON.parse(await readFile(join(plans, operation, 'plan.json'), 'utf8'))
      expect(plan).toMatchObject({ observationCount: distinct * observations, distinctRefCount: distinct })
      for (const ref of f.selectedRefs) expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source', 'target'])
      expect(probe.total('inventories', 'transfer-owner')).toBeGreaterThan(0)
      expect(probe.total('body.readBytes', 'transfer-owner')).toBeGreaterThan(0)
      expect(probe.total('bodyHashBytes', 'transfer-owner')).toBeGreaterThan(0)
      expect(probe.total('bodyHashBytes', 'transfer-owner')).toBe(probe.total('body.readBytes', 'transfer-owner'))
      expect(probe.total('sqlitePageAdmissions', 'transfer-owner')).toBeGreaterThan(0)
      expect(probe.activeIO).toBe(0); expect(probe.activeHandles).toBe(0)
    })
    assertionMs = performance.now() - assertStart
    await probe.run('startup-reopen', 'close-and-recreate', () => f.reopen())
    await probe.run('startup-reopen', 'startup-and-read', () => f.service().read({ sessionId: 'creator' }, { refId: f.visible.id }))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Math.ceil(Math.max(f.hidden.expiresAt, f.future.expiresAt, ...f.selectedRefs.map(ref => ref.expiresAt))) + 1)
    try {
      const triggered = await probe.run('expiry-trigger', 'capture', () => f.service().capture({ sessionId: 'creator', callId: 'after-expiry', label: 'after-expiry', text: 'actual expiry trigger', complete: true }))
      const expiryAssertionsStart = performance.now()
      await probe.run('assertions', 'expiry-effects', async () => {
        expect(triggered).toBeDefined()
        const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
        for (const ref of f.selectedRefs) await expect(stat(join(directory, 'blobs', ref.id + '.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      })
      assertionMs += performance.now() - expiryAssertionsStart
    } finally { clock.mockRestore() }
  } finally {
    try { await probe.run('teardown', 'close', () => f.close()) }
    finally { await receipt(name, { distinct, observations: distinct * observations, assertionMs }) }
  }
}, 120000)
