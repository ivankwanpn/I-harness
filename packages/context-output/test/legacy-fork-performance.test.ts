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
    originalWalk.next = async (...input: Parameters<typeof next>) => {
      if (!started) { started = true; probe.add('graphWalks') }
      const result = await next(...input)
      if (!result.done) probe.add('graphRows')
      return result
    }
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
import { OwnerLedger } from '../src/legacy/owner-ledger.ts'

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
const authority = ContextStore.prototype as unknown as { validateLegacyAuthority(turn: WorkspaceMutationTurn): Promise<unknown> }
const validate = authority.validateLegacyAuthority
vi.spyOn(authority, 'validateLegacyAuthority').mockImplementation(function(this: ContextStore, ...args) {
  probe.add('wholeAuthorityPreflights')
  return validate.apply(this, args)
})
const revoke = ContextStore.prototype.revokeLegacyTargets
vi.spyOn(ContextStore.prototype, 'revokeLegacyTargets').mockImplementation(function(this: ContextStore, ...args) {
  return probe.phase('required-revocations', () => revoke.apply(this, args))
})

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
    expect(probe.total('wholeAuthorityPreflights', 'startup-reopen')).toBe(1)
    expect(probe.total('graphWalks', 'startup-reopen')).toBe(1)
    expect(probe.total('graphRows', 'startup-reopen')).toBe(distinct * observations)
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

// A per-ref full scan breaks these controls when E grows at fixed R. Clock
// boundaries use genuine captures and commitments; no ref metadata is rewritten.
it.each([
  { name: 'expiry-e1-r31', distinct: 31, expired: 1, observations: 1, roots: 1 },
  { name: 'expiry-e11-r31', distinct: 31, expired: 11, observations: 1, roots: 1 },
  { name: 'expiry-e31-r31', distinct: 31, expired: 31, observations: 1, roots: 1 },
  { name: 'expiry-e1-r11', distinct: 11, expired: 1, observations: 1, roots: 1 },
  { name: 'expiry-repeated31', distinct: 1, expired: 1, observations: 31, roots: 1 },
  { name: 'expiry-two-roots', distinct: 11, expired: 11, observations: 2, roots: 2 },
  { name: 'expiry-clear-full-budget', distinct: 11, expired: 11, observations: 2, roots: 2 },
])('streams original authority once after preflight for $name', async ({ name, distinct, expired, observations, roots }) => {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++now)
  const f = await legacyFixture({ distinct, observations })
  probe.reset()
  try {
    expect((await f.run()).kind).toBe('ready')
    if (roots === 2) {
      // A second actual B2 reservation/application, over the same original
      // observations, proves duplicate effects are prevented across roots too.
      f.request.invocation.operationId = 'second-original'
      f.request.invocation.targetSessionId = 'second-target'
      expect((await f.run()).kind).toBe('ready')
    }
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    expect(await readdir(join(directory, 'legacy-fork-v1'))).toHaveLength(roots)
    const full = await physicalBytes(directory), sourceCalls = f.sourceCalls()
    if (name.includes('full-budget')) await f.service().configure({ maxDiskBytes: full })
    clock.mockReturnValue(f.selectedRefs[expired - 1]!.expiresAt)
    probe.reset()
    const diagnostics: unknown[] = []
    let activeDatabase: DatabaseSync | undefined
    const snapshot = async (phase: string, ref?: string) => {
      const index = join(directory, 'index.sqlite'), db = activeDatabase ?? new DatabaseSync(index, { readOnly: true })
      try { diagnostics.push({ phase, ref, physical: await physicalBytes(directory), indexBytes: (await stat(index)).size,
        pageCount: db.prepare('PRAGMA page_count').get(), maxPages: db.prepare('PRAGMA max_page_count').get(), freelist: db.prepare('PRAGMA freelist_count').get(),
        journalBytes: await stat(index + '-journal').then(info => info.size, () => 0), ...(ref ? { owners: await readFile(ref, 'utf8') } : {}) }) }
      finally { if (!activeDatabase) db.close() }
    }
    const clearOriginal = ContextStore.prototype.clear
    const clearSpy = name.includes('full-budget') ? vi.spyOn(ContextStore.prototype, 'clear').mockImplementation(async function(this: ContextStore, ...args) {
      activeDatabase = (this as unknown as { db: DatabaseSync }).db
      const prepare = activeDatabase.prepare.bind(activeDatabase)
      const sqlSpy = vi.spyOn(activeDatabase, 'prepare').mockImplementation((...input: Parameters<typeof prepare>) => {
        diagnostics.push({ sql: input[0] }); return prepare(...input)
      })
      try { await snapshot('before-clear'); await clearOriginal.apply(this, args) }
      catch (failure) { await snapshot('after-failure'); throw failure }
      finally { sqlSpy.mockRestore(); activeDatabase = undefined }
    }) : undefined
    const replace = OwnerLedger.prototype.replace
    const ledgerSpy = name.includes('full-budget') ? vi.spyOn(OwnerLedger.prototype, 'replace').mockImplementation(async function(this: OwnerLedger, ...args) {
      if (args[1].size !== 0) return replace.apply(this, args)
      await snapshot('before-tombstone', args[0])
      await replace.apply(this, args)
      await snapshot('after-tombstone', args[0])
    }) : undefined
    try {
      await probe.run('streamed-expiry', 'effect-operation', async () => {
        if (name.includes('full-budget')) await f.service().clear('unrelated')
        else expect(await f.service().capture({ sessionId: 'creator', callId: 'sweep', label: 'sweep', text: 'actual prune trigger', complete: true })).toBeDefined()
      })
    } catch (failure) {
      await receipt(name, { distinct, expired, observations, roots, rows: distinct * observations * roots, full, diagnostics, failure: String(failure) })
      throw failure
    } finally { ledgerSpy?.mockRestore(); clearSpy?.mockRestore() }
    const measured = probe.snapshot()
    await receipt(name, { distinct, expired, observations, roots, rows: distinct * observations * roots, full })
    for (const [index, ref] of f.selectedRefs.entries()) {
      if (index < expired) await expect(stat(join(directory, 'blobs', ref.id + '.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      else expect((await stat(join(directory, 'blobs', ref.id + '.txt'))).size).toBe(ref.bytes)
    }
    const total = (key: string) => Object.entries(measured.counts).reduce((sum, [phase, counts]) => sum + (phase.endsWith('/required-revocations') ? 0 : counts[key] ?? 0), 0)
    expect.soft(total('wholeAuthorityPreflights')).toBe(1)
    expect.soft(total('graphWalks')).toBe(2 * roots)
    expect.soft(total('graphRows')).toBe(2 * distinct * observations * roots)
    expect(total('authorityNamespaces')).toBe(2)
    expect(total('slot.sync')).toBe(expired)
    expect(Object.entries(measured.counts).filter(([phase]) => phase.endsWith('/expiry-sweep')).every(([, counts]) => !counts.inventories && !counts.sqlitePageAdmissions)).toBe(true)
    expect(f.sourceCalls()).toBe(sourceCalls)
    expect(measured.activeIO).toBe(0); expect(measured.activeHandles).toBe(0)
    if (name.includes('full-budget')) expect(await physicalBytes(directory)).toBeLessThanOrEqual(full)
  } finally { clock.mockRestore(); await f.close() }
}, 120000)
