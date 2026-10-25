import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextOutputService, type ContextOutputOptions } from '../src/index.ts'
import { createSessionCoordinator, compileSemanticSeed } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createSession, append, exportConversationSeed } from '@i-harness/core-session'
import { legacyFixture } from './legacy-fork-fixture.ts'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createLegacyRetentionSelection, captureBootstrapPreparationFacts } from '@i-harness/core-session'
import { commitment } from '../src/legacy/fork-codec.ts'
import { physicalBytes } from '../src/artifact/quota.ts'
import { ContextStore } from '../src/store.ts'
import { createBootstrapRequestIntent } from '../../session-persistence/src/coordinator/bootstrap-intent.ts'
import { contextSourceIdentity } from '../src/index.ts'

const cuts = vi.hoisted(() => ({ afterLink: undefined as undefined | ((path: string) => void), afterRename: undefined as undefined | ((path: string) => void), afterReadFile: undefined as undefined | ((path: string) => void), measure: false, compiles: 0, sourceExports: 0 }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async readFile(...args: Parameters<typeof fs.readFile>) { const result = await fs.readFile(...args); cuts.afterReadFile?.(String(args[0])); return result }, async link(...args: Parameters<typeof fs.link>) { await fs.link(...args); cuts.afterLink?.(String(args[1])) }, async rename(...args: Parameters<typeof fs.rename>) { await fs.rename(...args); cuts.afterRename?.(String(args[0])) } }
})
vi.mock('../../session-persistence/src/semantic-seed.ts', async original => {
  const api = await original<typeof import('../../session-persistence/src/semantic-seed.ts')>()
  return { ...api, compileSemanticSeed(...args: Parameters<typeof api.compileSemanticSeed>) { if (cuts.measure) cuts.compiles++; return api.compileSemanticSeed(...args) } }
})
vi.mock('@i-harness/core-session', async original => {
  const api = await original<typeof import('@i-harness/core-session')>()
  return { ...api, exportConversationSeed(...args: Parameters<typeof api.exportConversationSeed>) { if (cuts.measure) cuts.sourceExports++; return api.exportConversationSeed(...args) } }
})

it('strict mode denies an unobserved original raw grant toward a real reserved B2 target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-legacy-fork-red-'))
  const options = { root, workspaceId: 'workspace', config: { enabled: true }, requireObservedLegacyRecipients: true } satisfies ContextOutputOptions & { requireObservedLegacyRecipients: boolean }
  const service = createContextOutputService(options)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  try {
    const ref = await service.capture({ sessionId: 'source', callId: 'visible', label: 'visible', text: 'VISIBLE retained result', complete: true })
    if (!ref) throw Error('capture failed')
    const source = createSession(); append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'selected' }); append(source, { type: 'context/result-ref', ref }); append(source, { type: 'turn/end' })
    const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'source' }, { kind: 'completed' })
    if (exported.kind !== 'seed') throw Error('seed failed')
    const invocation = { version: 1 as const, operationId: 'original', targetSessionId: 'target', createdAt: '2026-10-25T00:00:00.000Z', requestDigest: 'a'.repeat(64) }
    const outcome = await coordinator.bootstrapSemanticTarget({ invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed: compileSemanticSeed(exported) }, {
      assertCurrent() {}, dependencies: { async confirm() { throw Error('empty closure') }, async reconcile() { throw Error('empty closure') } },
      targetPreparation: { async confirm(request) { expect((await coordinator.inspectBootstrap(invocation)).token).toMatchObject({ manifestDigest: request.manifestDigest }); return { kind: 'blocked', reason: 'unavailable' } }, async reconcile() { return { kind: 'blocked', reason: 'unavailable' } }, assertTargetCurrent() {} },
    })
    expect(outcome.kind).toBe('blocked')
    await service.grant({ sessionId: 'source' }, [ref.id], 'target')
    await expect(service.read({ sessionId: 'target' }, { refId: ref.id })).rejects.toThrow(/observ|unauthorized|unavailable/i)
  } finally { await service.close(); await coordinator.close() }
})

it.each(['seed', 'observation', 'selection'])('refuses mismatched actual B2 %s metadata before publishing and accepts matching capture', async field => {
  const f = await legacyFixture()
  try {
    const result = await f.run(false, capture => {
      if (field === 'seed') capture.semanticSeedDigest = 'f'.repeat(64)
      if (field === 'observation') capture.sourceObservationDigest = 'e'.repeat(64)
      if (field === 'selection') capture.selection = { kind: 'completed', atSeq: 7 }
    })
    expect(result.kind).toBe('blocked')
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    await expect(readdir(join(directory, 'legacy-fork-v1'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.run()).kind).toBe('ready')
  } finally { await f.close() }
})

it('refuses a genuine captured B2 turn domain that differs from the guarded original source', async () => {
  const f = await legacyFixture()
  try {
    const other = createSession()
    for (let i = 0; i < 2; i++) { append(other, { type: 'turn/start' }); append(other, { type: 'user/message', text: `other ${i}` }); append(other, { type: 'turn/end' }) }
    await f.coordinator().create({ sessionId: 'other-source' }); await f.coordinator().append('other-source', other.events)
    const document = await f.coordinator().openManagedDocument('other-source'), selection = { kind: 'completed' as const, atSeq: 3 }, exported = exportConversationSeed(document.view, { kind: 'session', sessionId: 'source' }, selection)
    if (exported.kind !== 'seed') throw Error('Actual other B1 seed refused')
    f.request.seed = compileSemanticSeed(exported)
    expect((await f.run(false, capture => { capture.semanticSeedDigest = exported.digest; capture.sourceObservationDigest = exported.sourceObservationDigest })).kind).toBe('blocked')
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    await expect(readdir(join(directory, 'legacy-fork-v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.close() }
})

it('publishes exact empty root/application and never interprets missing retention as empty', async () => {
  const f = await legacyFixture({ observations: 0 })
  try {
    expect((await f.run()).kind).toBe('ready')
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'legacy-fork-v1'), name = (await readdir(directory))[0]!
    expect(JSON.parse(await readFile(join(directory, name, 'plan.json'), 'utf8'))).toMatchObject({ observationCount: 0, distinctRefCount: 0, pages: null })
    expect(JSON.parse(await readFile(join(directory, name, 'applied.json'), 'utf8'))).toMatchObject({ observationCount: 0, distinctRefCount: 0 })
    await rm(join(directory, name, 'applied.json')); expect((await f.run(true)).kind).toBe('blocked')
  } finally { await f.close() }
})

it('refuses actual physical quota shortage before any target owner addition', async () => {
  const f = await legacyFixture()
  try {
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    await f.service().configure({ maxDiskBytes: await physicalBytes(directory) + 2000 })
    expect((await f.run()).kind).toBe('blocked')
    expect(JSON.parse(await readFile(join(directory, 'owners', f.visible.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
  } finally { await f.close() }
})

it('commits the complete large metadata with literal source coordinates and no descriptor cap', async () => {
  const f = await legacyFixture({ path: 'long-path-'.repeat(20000) })
  const canonical = (value: unknown): string => value && typeof value === 'object' && !Array.isArray(value)
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}' : JSON.stringify(value)
  try {
    expect((await f.run()).kind).toBe('ready')
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'legacy-fork-v1')
    const operations = await readdir(directory), planDirectory = join(directory, operations[0]!)
    const row = JSON.parse(await readFile(join(planDirectory, 'pages', '0-0.json'), 'utf8')).rows[0]
    const expectedMetadata = canonical(f.visible)
    expect(row).toEqual({ refId: f.visible.id, revision: f.visible.revision, metadataDigest: createHash('sha256').update('ih.legacy-ref.metadata.v1\0').update(expectedMetadata).digest('hex'), metadataEncodedBytes: Buffer.byteLength(expectedMetadata), expiresAt: f.visible.expiresAt,
      original: { sessionId: 'source', seq: 2, part: 'context/result-ref.ref' }, extent: { kind: 'framed', first: 1, last: 1 }, anchor: { kind: 'seed-group', manifestSeq: 0, ordinal: 0 } })
    expect((await readFile(join(planDirectory, 'plan.json'))).length).toBeLessThan(65536)
    expect(commitment({ ...f.visible, source: { ...f.visible.source!, path: f.visible.source!.path + 'tail' } })).not.toEqual(commitment(f.visible))
    const selected = createLegacyRetentionSelection(f.view, f.request.seed.records[0]!.type === 'conversation/seed-manifest' ? f.request.seed.records[0]!.selection as { kind: 'completed' } : { kind: 'completed' })
    expect(selected.kind).toBe('selected')
  } finally { await f.close() }
}, 60000)

it('permits strict disabled metadata transfer, then observed read after enable', async () => {
  const f = await legacyFixture({ disabled: true })
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation()
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow(/disabled/)
    await f.service().configure({ enabled: true })
    expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).text).toContain('VISIBLE')
  } finally { await f.close() }
})

it('revokes before target clear at a full budget and preserves other canonical owners', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    const full = await physicalBytes(directory)
    await f.service().configure({ maxDiskBytes: full })
    const observation = await f.observation()
    await f.service().clear('target')
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    expect(JSON.parse(await readFile(join(directory, 'owners', f.visible.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
    expect(await physicalBytes(directory)).toBeLessThanOrEqual(full)
    await f.reopen(); expect((await f.run(true)).kind).toBe('blocked')
  } finally { await f.close() }
})

it('denies root/index absence, missing canonical membership, and torn terminal slots without passive repairs', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation(), directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    const operations = await readdir(join(directory, 'legacy-fork-v1')), plan = join(directory, 'legacy-fork-v1', operations[0]!, 'plan.json'), bytes = await readFile(plan)
    await rm(plan)
    await expect(f.service().read({ sessionId: 'target' }, { refId: f.visible.id })).rejects.toThrow()
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    await writeFile(plan, bytes)
    const inactive = join(directory, 'legacy-fork-v1', operations[0]!, 'revoke.1'), slot = await readFile(inactive); slot[0] = 1; await writeFile(inactive, slot)
    expect((await f.run(true)).kind).toBe('blocked')
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    expect(await readFile(inactive)).toEqual(slot)
    await f.service().clear('target')
    expect(await readFile(inactive)).not.toEqual(slot)
  } finally { await f.close() }
})

it('validates and deeply freezes B2 metadata without exposing mutable turn arrays', () => {
  const facts = captureBootstrapPreparationFacts({ version: 1, invocation: { version: 1, operationId: 'op', targetSessionId: 'child', createdAt: '2026-10-25T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, manifestDigest: 'b'.repeat(64), seedDigest: 'c'.repeat(64), sourceObservation: { kind: 'semantic', digest: 'd'.repeat(64) }, groupCount: 1, semantic: { selection: { kind: 'completed' }, turns: { total: 1, completed: [[1, 1]], unframedPrefix: false } } })
  expect(Object.isFrozen(facts.semantic!.turns.completed[0])).toBe(true)
  expect(() => captureBootstrapPreparationFacts({ ...facts, extra: true })).toThrow()
  let reads = 0
  expect(() => captureBootstrapPreparationFacts(Object.defineProperty({}, 'version', { enumerable: true, get() { reads++; return 1 } }))).toThrow(); expect(reads).toBe(0)
})

it.each(['source', 'signal'])('rejects a malformed host %s capability before issuing any original reservation', async field => {
  const f = await legacyFixture(); let getters = 0
  try {
    await expect(f.run(false, capture => {
      if (field === 'source') capture.source = null as unknown as typeof capture.source
      else capture.signal = Object.defineProperty({ addEventListener() {}, removeEventListener() {} }, 'aborted', { get() { getters++; return false } }) as unknown as AbortSignal
    })).rejects.toThrow()
    expect(getters).toBe(0); expect((await f.coordinator().inspectBootstrap(f.request.invocation)).kind).toBe('absent')
  } finally { await f.close() }
})

it('rejects an explicit null optional ref source instead of hashing it as valid metadata', () => {
  const ref = { id: 'ctx_' + 'a'.repeat(64), workspaceId: 'w', sessionId: 's', callId: 'c', label: 'l', revision: 'b'.repeat(64), bytes: 1, originalBytes: 1, complete: true, expiresAt: 2_000_000_000_000, source: null }
  expect(() => commitment(ref as unknown as import('../src/index.ts').ContextResultRef)).toThrow()
})

it('uses the canonical legacy manifest when capture optional source fields are explicitly undefined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-l1-optionals-')), service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, requireObservedLegacyRecipients: true })
  try {
    const ref = await service.capture({ sessionId: 'creator', callId: 'call', label: 'label', text: 'canonical body', complete: true, source: { sourceId: 'source', path: undefined, revision: undefined } })
    if (!ref) throw Error('Actual capture failed')
    expect((await service.readLegacyObserved({ sessionId: 'creator' }, { refId: ref.id }, { sessionId: 'creator', sourceId: 'source', assertCurrent() {}, localVisible: () => true, anchorVisible: () => false })).text).toBe('canonical body')
  } finally { await service.close() }
})

it('stops after a real page and continues the exact original prefix with fresh scope and no capture work', async () => {
  const f = await legacyFixture({ observations: 101 }), controller = new AbortController()
  try {
    cuts.afterLink = path => { if (path.replaceAll('\\', '/').endsWith('/pages/0-0.json')) controller.abort() }
    expect((await f.run(false, capture => { capture.signal = controller.signal })).kind).toBe('blocked')
    cuts.afterLink = undefined
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'legacy-fork-v1'), operations = await readdir(directory), planDirectory = join(directory, operations[0]!)
    const prefix = await readFile(join(planDirectory, 'pages', '0-0.json'))
    await expect(readFile(join(planDirectory, 'plan.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const before = await readFile(join(f.root, 'sessions', 'target.jsonl'))
    expect((await f.run(true)).kind).toBe('blocked')
    expect(await readFile(join(f.root, 'sessions', 'target.jsonl'))).toEqual(before)
    const capture = vi.spyOn(f.service(), 'capture')
    cuts.measure = true; cuts.compiles = cuts.sourceExports = 0
    expect((await f.run(false, capture => { const i = capture.invocation; capture.invocation = { requestDigest: i.requestDigest, createdAt: i.createdAt, targetSessionId: i.targetSessionId, operationId: i.operationId, version: i.version } }, undefined, true)).kind).toBe('confirmed')
    expect(capture).not.toHaveBeenCalled()
    expect(cuts.compiles).toBe(0); expect(cuts.sourceExports).toBe(0)
    expect(await readFile(join(planDirectory, 'pages', '0-0.json'))).toEqual(prefix)
    expect((await f.run()).kind).toBe('ready')
    expect(cuts.sourceExports).toBe(0); expect(cuts.compiles).toBeGreaterThan(0)
    console.info('B2 original immutable validation compile calls during finalization:', cuts.compiles, '; L1/source re-exports:', cuts.sourceExports)
    expect(JSON.parse(await readFile(join(planDirectory, 'plan.json'), 'utf8'))).toMatchObject({ observationCount: 101, distinctRefCount: 1 })
    expect(JSON.parse(await readFile(join(planDirectory, 'applied.json'), 'utf8'))).toMatchObject({ observationCount: 101, distinctRefCount: 1 })
  } finally { cuts.afterLink = undefined; cuts.measure = false; await f.close() }
}, 60000)

it('builds and verifies 10001 typed observations with the rightmost one-child directory', async () => {
  const open = ContextStore.prototype.open
  let peak = 0, retirements = 0, original: Set<unknown> | undefined
  const spy = vi.spyOn(ContextStore.prototype, 'open').mockImplementation(async function(this: ContextStore, ...args) {
    await open.apply(this, args)
    const set = original = (this as unknown as { fileDebt: Set<unknown> }).fileDebt, add = set.add.bind(set)
    set.add = value => { retirements++; add(value); peak = Math.max(peak, set.size); return set }
  })
  const f = await legacyFixture({ observations: 10001 })
  try {
    expect((await f.run()).kind).toBe('ready')
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'legacy-fork-v1'), operations = await readdir(directory), planDirectory = join(directory, operations[0]!)
    const root = JSON.parse(await readFile(join(planDirectory, 'plan.json'), 'utf8'))
    expect(root).toMatchObject({ observationCount: 10001, distinctRefCount: 1, pages: { level: 2, rows: 10001 } })
    const right = JSON.parse(await readFile(join(planDirectory, 'pages', '1-10000.json'), 'utf8'))
    expect(right).toMatchObject({ level: 1, children: [{ level: 0, firstRow: 10000, rows: 1 }] })
    const observation = await f.observation()
    await rm(join(planDirectory, 'pages', '0-10000.json'))
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    expect(retirements).toBeGreaterThan(10001); expect(peak).toBeLessThanOrEqual(2); expect(original!.size).toBe(0)
    console.info('Actual ContextStore scale retirement counters:', { retirements, peak, live: original!.size })
  } finally { spy.mockRestore(); await f.close() }
}, 300000)

it('completes actual mixed managed catalog/member and legacy closure, then reads both after cold source-free recovery', async () => {
  const f = await legacyFixture({ mixed: true })
  try {
    expect((await f.run()).kind).toBe('ready')
    expect((await f.service().readExecResult({ sessionId: 'target' }, { ref: f.managed!.member, viaCatalog: f.managed!.catalog })).frames.map(frame => frame.data)).toEqual(['eA=='])
    expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, await f.observation())).text).toContain('VISIBLE')
    await f.sourceClear(); await f.reopen(); const sourceCalls = f.sourceCalls()
    expect((await f.run(true)).kind).toBe('already-ready'); expect(f.sourceCalls()).toBe(sourceCalls)
    expect((await f.service().readExecResult({ sessionId: 'target' }, { ref: f.managed!.member, viaCatalog: f.managed!.catalog })).frames.map(frame => frame.data)).toEqual(['eA=='])
    expect((await f.service().searchLegacyObserved({ sessionId: 'target' }, { query: 'VISIBLE' }, await f.observation())).hits.map(hit => hit.ref.id)).toEqual([f.visible.id])
  } finally { await f.close() }
})

it.each(['owner-response', 'application-response'])('keeps original %s uncertainty and only continues through the actual source', async cut => {
  const f = await legacyFixture()
  try {
    if (cut === 'owner-response') cuts.afterRename = path => { if (path.replaceAll('\\', '/').endsWith(`/owners/${f.visible.id}.rewrite`)) throw Error('Original owner rename response lost') }
    else cuts.afterLink = path => { if (path.replaceAll('\\', '/').endsWith('/applied.json')) throw Error('Original application response lost') }
    expect((await f.run()).kind).toBe('blocked')
    cuts.afterRename = cuts.afterLink = undefined
    if (cut === 'owner-response') {
      const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex')), held = await physicalBytes(directory), budget = f.service().status().config.maxDiskBytes
      await f.service().configure({ maxDiskBytes: held })
      await f.coordinator().create({ sessionId: 'managed-sibling' })
      const sibling = await f.coordinator().openManagedDocument('managed-sibling')
      const scope = f.service().registerResultScope({ operationId: 'after-original-rename', sessionId: 'managed-sibling', callId: 'body' }, () => { sibling.assertReady(); return true })
      await expect(f.service().beginResult(scope, 'text-utf8-v1')).rejects.toThrow(/quota/)
      expect(await physicalBytes(directory)).toBe(held)
      expect((await readFile(join(directory, 'owners', f.visible.id + '.previous'))).length).toBeGreaterThan(0)
      await f.service().configure({ maxDiskBytes: budget })
    }
    const passive = await f.run(true)
    // An applied legacy grant cannot issue B2's missing semantic birth frames.
    expect(passive.kind).toBe('blocked')
    expect((await f.run(true, undefined, undefined, true)).kind).toBe(cut === 'application-response' ? 'confirmed' : 'blocked')
    expect((await f.run()).kind).toBe('ready')
    expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, await f.observation())).text).toContain('VISIBLE')
  } finally { cuts.afterRename = cuts.afterLink = undefined; await f.close() }
})

it('source clear preserves a newer canonical owner whose original rename response was lost', async () => {
  const f = await legacyFixture()
  try {
    cuts.afterRename = path => { if (path.replaceAll('\\', '/').endsWith(`/owners/${f.visible.id}.rewrite`)) throw Error('Original canonical owner response lost') }
    expect((await f.run()).kind).toBe('blocked'); cuts.afterRename = undefined
    await f.service().clear('source')
    const path = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'owners', f.visible.id + '.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(['creator', 'target'])
    expect((await f.run(true)).kind).toBe('blocked')
  } finally { cuts.afterRename = undefined; await f.close() }
})

it('acknowledges exact expiry after body/manifest GC, and same-body recapture cannot revive an old grant', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation(), future = f.visible.expiresAt + 1
    vi.spyOn(Date, 'now').mockReturnValue(future)
    await f.service().capture({ sessionId: 'other', callId: 'prune', label: 'prune', text: 'fresh trigger', complete: true })
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    const replacement = await f.service().capture({ sessionId: 'creator', callId: 'VISIBLE', label: 'VISIBLE', text: 'VISIBLE retained text', complete: true, source: { sourceId: f.sourceId } })
    expect(replacement?.id).toBe(f.visible.id); expect(replacement?.expiresAt).toBeGreaterThan(f.visible.expiresAt)
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    expect((await f.run(true, undefined, undefined, true)).kind).toBe('confirmed')
    await f.reopen(); expect((await f.run(true)).kind).toBe('already-ready')
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, await f.observation())).rejects.toThrow()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it('retains genuine fractional legacy expiry through transfer, cold read and the original expiry disposition', async () => {
  const f = await legacyFixture({ retentionDays: 7.000000001 })
  try {
    expect(Number.isInteger(f.visible.expiresAt)).toBe(false)
    expect((await f.run()).kind).toBe('ready'); await f.sourceClear(); await f.reopen()
    const calls = f.sourceCalls(); expect((await f.run(true)).kind).toBe('already-ready'); expect(f.sourceCalls()).toBe(calls)
    const observation = await f.observation()
    const page = await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)
    expect(page.ref.expiresAt).toBe(f.visible.expiresAt); expect(page.text).toContain('VISIBLE')
    vi.spyOn(Date, 'now').mockReturnValue(Math.ceil(f.visible.expiresAt) + 1)
    await f.service().capture({ sessionId: 'other', callId: 'prune', label: 'trigger', text: 'prune old', complete: true })
    const c = commitment(f.visible), slot = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'legacy-expiry-v1', f.visible.id, c.metadataDigest, 'expiry.1')
    expect((await readFile(slot)).toString()).toContain('"expiresAt":' + JSON.stringify(f.visible.expiresAt))
    expect((await f.run(true)).kind).toBe('already-ready')
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['read', 'search'])('discards observed %s payload when its exact ref expires during the actual body await', async operation => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation()
    cuts.afterReadFile = path => { if (path.replaceAll('\\', '/').endsWith(`/blobs/${f.visible.id}.txt`)) { cuts.afterReadFile = undefined; vi.spyOn(Date, 'now').mockReturnValue(Math.ceil(f.visible.expiresAt) + 1) } }
    if (operation === 'read') await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    else expect((await f.service().searchLegacyObserved({ sessionId: 'target' }, { query: 'VISIBLE' }, observation)).hits).toEqual([])
  } finally { cuts.afterReadFile = undefined; vi.restoreAllMocks(); await f.close() }
})

it('releases legacy target membership through actual document deletion alongside managed cleanup', async () => {
  const f = await legacyFixture({ mixed: true })
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation()
    await f.coordinator().deleteOwnedSession!('target', { documents: [] })
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    await expect(f.service().readExecResult({ sessionId: 'target' }, { ref: f.managed!.member, viaCatalog: f.managed!.catalog })).rejects.toThrow()
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    expect(JSON.parse(await readFile(join(directory, 'owners', f.visible.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
  } finally { await f.close() }
})

it('invalidates old project observations across ABA while a fresh actual scope requalifies the preserved grant', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const old = await f.observation()
    await f.broker().revoke('p'); await f.broker().configure(f.project)
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, old)).rejects.toThrow()
    expect((await f.run(true)).kind).toBe('already-ready')
    expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, await f.observation())).text).toContain('VISIBLE')
  } finally { await f.close() }
})

it('never treats a raw target owner grant as original bound application', async () => {
  const f = await legacyFixture()
  try {
    await f.service().grant({ sessionId: 'creator' }, [f.visible.id], 'target')
    // B2 may reserve its actual header, but a passive source-free port cannot
    // supply absent binding/pages/application from the owner-ID array.
    expect((await f.run(false, capture => { delete capture.source })).kind).toBe('blocked')
    expect((await f.run(true, undefined, undefined, true)).kind).toBe('blocked')
  } finally { await f.close() }
})

it('rebases nested live observations while preserving original coordinates and only the immediate via', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const coordinator = f.coordinator(), service = f.service(), parent = await coordinator.openManagedDocument('target'), view = parent.view, count = view.events.length
    const read = await f.observation(), selection = { kind: 'completed' as const }, exported = exportConversationSeed(view, { kind: 'session', sessionId: 'target' }, selection)
    if (exported.kind !== 'seed') throw Error('Nested B1 seed refused')
    const { intent, requestDigest } = createBootstrapRequestIntent({ action: 'fork', selection }, { kind: 'project', projectId: 'p' })
    const invocation = { version: 1 as const, operationId: 'nested', targetSessionId: 'grandchild', createdAt: '2026-10-25T00:00:00.000Z', requestDigest }
    const current = () => { parent.assertReady(); read.assertCurrent(); if (parent.view !== view || view.events.length !== count) throw Error('Nested source changed') }
    const preparation = f.broker().prepareBootstrapInheritance({ invocation, requestIntent: intent, sourceSessionId: 'target', sourceAvailable: () => true, assertNewWorkCurrent: current, targetAvailable: () => true })
    const scope = service.registerLegacyForkTransfer({ invocation, sourceSessionId: 'target', semanticSeedDigest: exported.digest, sourceObservationDigest: exported.sourceObservationDigest, selection,
      source: { view, read, assertCurrent() { current(); preparation.assertSourceCurrent() } },
      target: { available: () => true, assertCurrent: preparation.targetPreparation.assertTargetCurrent, sourceId() { return contextSourceIdentity('workspace', f.project.primaryRoot, preparation.targetScope().scope) } } })
    let result
    try {
      result = await coordinator.bootstrapSemanticTarget({ invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'target' }, seed: compileSemanticSeed(exported) }, {
        assertCurrent: current, dependencies: { async confirm() { throw Error('Empty nested closure') }, async reconcile() { throw Error('Empty nested closure') } },
        targetPreparation: { assertTargetCurrent: preparation.targetPreparation.assertTargetCurrent,
          async confirm(phase, fresh, facts) { const prepared = await preparation.targetPreparation.confirm(phase, fresh, facts); return prepared.kind === 'confirmed' ? service.confirmLegacyForkTransfer(scope, phase, fresh, facts!) : prepared },
          async reconcile(phase, facts) { const prepared = await preparation.targetPreparation.reconcile(phase, facts); return prepared.kind === 'confirmed' ? service.reconcileLegacyForkTransfer(scope, phase, facts!) : prepared },
        },
      })
      expect(result.kind).toBe('ready')
    } finally { await service.closeLegacyForkTransfer(scope); preparation.close() }
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'legacy-fork-v1')
    const plans = await Promise.all((await readdir(directory)).map(async name => ({ name, root: JSON.parse(await readFile(join(directory, name, 'plan.json'), 'utf8')) })))
    const nested = plans.find(plan => plan.root.binding.targetSessionId === 'grandchild')!
    const row = JSON.parse(await readFile(join(directory, nested.name, 'pages', '0-0.json'), 'utf8')).rows[0]
    expect(row.original).toEqual({ sessionId: 'source', seq: 2, part: 'context/result-ref.ref' })
    expect(row.via).toMatchObject({ sessionId: 'target', operationId: 'original', rowOrdinal: 0 })
    await service.clear('target')
    const grandchild = await coordinator.openManagedDocument('grandchild'), seed = grandchild.view.header!.semanticSeed!, targetScope = (await f.broker().resultReadScopeFor('grandchild'))!()
    const observation = { sessionId: 'grandchild', sourceId: contextSourceIdentity('workspace', f.project.primaryRoot, targetScope.scope), bootstrap: { invocation, manifestDigest: seed.manifestDigest, seedDigest: seed.seedDigest }, assertCurrent() { grandchild.assertReady() }, localVisible: () => false, anchorVisible: () => true }
    expect((await service.readLegacyObserved({ sessionId: 'grandchild' }, { refId: f.visible.id }, observation)).text).toContain('VISIBLE')
  } finally { await f.close() }
})

it('binds actual Gateway B2/project facts, retains only VISIBLE, then cold reads and searches after source clear', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    expect(f.acquired()).toBe(0)
    const observation = await f.observation(), service = f.service()
    expect((await service.readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).text).toBe('VISIBLE retained text')
    expect((await service.searchLegacyObserved({ sessionId: 'target' }, { query: 'VISIBLE' }, observation)).hits.map(hit => hit.ref.id)).toEqual([f.visible.id])
    for (const ref of [f.hidden, f.future]) await expect(service.readLegacyObserved({ sessionId: 'target' }, { refId: ref.id }, observation)).rejects.toThrow()
    await expect(service.read({ sessionId: 'target' }, { refId: f.visible.id })).rejects.toThrow()
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    const owners = JSON.parse(await readFile(join(directory, 'owners', f.visible.id + '.json'), 'utf8'))
    expect(owners).toEqual(['creator', 'source', 'target'])
    await f.sourceClear()
    expect((await service.readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, await f.observation())).text).toContain('VISIBLE')
    await f.reopen(); const sourceCalls = f.sourceCalls()
    expect((await f.run(true)).kind).toBe('already-ready')
    expect(f.sourceCalls()).toBe(sourceCalls)
    const cold = await f.observation()
    expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, cold)).text).toContain('VISIBLE')
    expect((await f.service().searchLegacyObserved({ sessionId: 'target' }, { query: 'VISIBLE' }, cold)).hits.map(hit => hit.ref.id)).toEqual([f.visible.id])
  } finally { await f.close() }
})
