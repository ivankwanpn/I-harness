import { createArtifactQualificationIO } from '../src/artifact/qualification-io.ts'
import { readVerifiedArtifactBytes } from '../src/artifact/reader.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BootstrapDependencyRequest, ManagedArtifactRef, ResultDependency } from '@i-harness/core-session'
import { createContextOutputService } from '../src/index.ts'
import type { SeedDependencyHostAccess } from '../src/index.ts'
import { createTransferClosure } from '../src/artifact/transfer-closure.ts'
import { settleSeedDependencyTransferIO } from '../src/service.ts'
import { structureEvidence } from './structure-evidence.ts'

const controls = vi.hoisted(() => ({ reads: [] as string[], cutPath: '', cut: '', afterRead: undefined as undefined | ((path: string) => void), afterReaddir: undefined as undefined | ((path: string) => void), mutations: 0, requireRead:false,openFault:'',paths:new Map<object,string>(),closeMode:'r+',closeCounts:new Map<object,number>(), primary:undefined as unknown, failClose: false, falsey: false, failed: [] as import('node:fs/promises').FileHandle[], pending: undefined as Promise<void>|undefined, entered: undefined as (()=>void)|undefined }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if(String(args[0])===controls.openFault)throw controls.primary
    const handle = await fs.open(...args), path = String(args[0]), read = handle.read.bind(handle), write = handle.write.bind(handle), sync = handle.sync.bind(handle), close=handle.close.bind(handle)
    let readUsed=false;controls.paths.set(handle,path)
    handle.read = (async (...params: Parameters<typeof read>) => { readUsed=true;if(controls.cut==='falsey-read'&&path===controls.cutPath)throw controls.primary;const result = await read(...params); controls.reads.push(path); controls.afterRead?.(path); return result }) as typeof handle.read
    handle.write = (async (...params: Parameters<typeof write>) => { controls.mutations++; return write(...params) }) as typeof handle.write
    handle.sync = async () => {if(controls.cut==='falsey-sync'&&path===controls.cutPath)throw controls.primary; if (controls.cut === 'sync' && path.startsWith(controls.cutPath)) throw new Error('sync cut'); return sync() }
    handle.close=async()=>{controls.closeCounts.set(handle,(controls.closeCounts.get(handle)??0)+1);if(path===controls.cutPath&&args[1]===controls.closeMode&&controls.failClose&&(!controls.requireRead||readUsed)){controls.failed.push(handle);throw controls.falsey?undefined:Error('Original passive close debt')}if(path===controls.cutPath&&controls.pending){controls.entered?.();await controls.pending}await close()}
    return handle
  }, link: async (...args: Parameters<typeof fs.link>) => {
    controls.mutations++
    if (String(args[1]) === controls.cutPath && controls.cut === 'link') throw new Error('link cut')
    await fs.link(...args)
    if (String(args[1]) === controls.cutPath && controls.cut === 'response') throw new Error('link response cut')
  }, unlink: async (...args: Parameters<typeof fs.unlink>) => { controls.mutations++; return fs.unlink(...args) },
  readdir: async (...args: Parameters<typeof fs.readdir>) => { const result = await fs.readdir(...args); controls.afterReaddir?.(String(args[0])); return result } }
})
const evidence = resolve(structureEvidence('.tmp/context-transfer-artifact-20261023'), 'bootstrap-transfer')
await mkdir(evidence, { recursive: true })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
afterEach(() => Object.assign(controls, { reads: [], cutPath: '', cut: '', afterRead: undefined, afterReaddir: undefined, mutations: 0 }))

async function fixture(extra = 0, ownerPath?: string, prefix = 'original-', ownerSources: { catalog?: string; member?: string } = {}) {
  const root = await mkdtemp(resolve(evidence, prefix)), workspaceId = 'transfer-workspace'
  let source = true, target = true, sourcePolicy = true, targetPolicy = true, targetThrows = false, revision = 'target-rev-1', sourceCalls = 0, targetReadCalls = 0
  let deniedRelation: string | undefined
  let deleted!: (documents: readonly string[]) => Promise<void>
  const service = createContextOutputService({ root, workspaceId, documentDeletions: listener => { deleted = listener; return () => {} }, authorizeResult: (access, metadata) => {
    if (access.sessionId === 'parent') sourceCalls++
    if (access.sessionId !== 'parent' && access.sessionId !== 'producer') { targetReadCalls++; if (targetThrows) throw Error('incomplete target has no public snapshot') }
    if (access.sessionId === 'parent' && metadata.visibleVia && `${metadata.ref.id}:${metadata.visibleVia.id}` === deniedRelation) return false
    return access.sessionId === 'producer' || (access.sessionId === 'parent' ? source && sourcePolicy : target && targetPolicy)
      && (metadata.ref.codec === 'json-utf8-v1' || !!metadata.visibleVia)
  } })
  const members: ManagedArtifactRef[] = []
  for (const n of [0, 1]) {
    const scope = service.registerResultScope({ operationId: `member-${n}`, sessionId: 'producer', callId: `exec-${n}`, source: { sourceId: ownerSources.member ?? 'original-project' } }, () => true)
    const sink = await service.beginResult(scope, 'exec-frames-v1')
    await sink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'))
    const result = await sink.finish('complete'); if (result.kind !== 'committed') throw Error('fixture member refused')
    members.push(result.ref); await service.grant({ sessionId: 'producer' }, [result.ref.id], 'parent')
  }
  const entries: ResultDependency[] = [
    { kind: 'exec-frames', sourceId: 'native-a', retention: { kind: 'artifact', ref: members[0]! } },
    { kind: 'exec-frames', sourceId: 'native-missing', retention: { kind: 'unavailable', reason: 'quota', observedEncodedBytes: 999 } },
    { kind: 'exec-frames', sourceId: 'native-b', retention: { kind: 'artifact', ref: members[1]! } },
    { kind: 'exec-frames', sourceId: 'native-alias', retention: { kind: 'artifact', ref: members[0]! } },
    ...Array.from({ length: extra }, (_, n): ResultDependency => ({ kind: 'exec-frames', sourceId: `extra-${n}`, retention: { kind: 'artifact', ref: members[0]! } })),
  ]
  const owner = { operationId: 'original-catalog', sessionId: 'parent', callId: 'observe', source: { sourceId: ownerSources.catalog ?? 'original-project', ...(ownerPath ? { path: ownerPath } : {}) } }
  const scope = service.registerResultDependencyScope(owner, () => true, entries), sink = await service.beginResult(scope, 'json-utf8-v1')
  await sink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
  const catalog = await sink.finish('complete'); if (catalog.kind !== 'committed') throw Error('fixture catalog refused')
  expect(await service.settleResultDependencyMembership(scope, catalog.ref)).toBe('ready')
  const request: BootstrapDependencyRequest = { operationId: 'bootstrap-original', sourceSessionId: 'parent', targetSessionId: 'child', manifestDigest: 'a'.repeat(64), artifacts: [{ ref: catalog.ref, origins: [{ origin: 0, seq: 1, part: 'result' }], uses: [{ kind: 'dependency-catalog', count: entries.length }] }] }
  const binding = { operationId: request.operationId, sourceSessionId: request.sourceSessionId, targetSessionId: request.targetSessionId, targetDocumentId: request.targetSessionId, manifestDigest: request.manifestDigest }
  const access = { binding, sourceAccess: { sessionId: 'parent' }, sourceAvailable: () => source,
    assertSourceCurrent: () => { sourceCalls++; if (!source) throw Error('source revoked') }, targetAvailable: () => target,
    targetScope: () => ({ source: { sourceId: 'original-project' }, revision }), assertTargetCurrent: () => { if (!target) throw Error('target revoked') } }
  const directory = (ref: ManagedArtifactRef) => resolve(root, 'context-output', sha(workspaceId), 'managed-v1', ref.id)
  const pin = (ref: ManagedArtifactRef, session = 'child') => resolve(directory(ref), 'pins', sha(session) + '.json')
  const companion = (ref: ManagedArtifactRef, session = 'child') => resolve(directory(ref), 'pin-memberships', sha(session), sha(JSON.stringify([catalog.ref.id, catalog.ref.revision])) + '.json')
  return { root, workspaceId, service, members, entries, owner, catalog: catalog.ref, request, binding, access, directory, pin, companion, deleted,
    revokeSource: () => { source = false }, revokeTarget: () => { target = false }, denySourcePolicy: () => { sourcePolicy = false }, denyTargetPolicy: () => { targetPolicy = false }, throwTargetPolicy: () => { targetThrows = true }, targetReadCalls: () => targetReadCalls,
    denySourceRelation: (member: ManagedArtifactRef, catalog: ManagedArtifactRef) => { deniedRelation = `${member.id}:${catalog.id}` }, setRevision: (value: string) => { revision = value }, sourceCalls: () => sourceCalls }
}

it('existing ordinary grant retains bytes but cannot transfer original catalog membership (behavioral baseline)', async () => {
  const f = await fixture()
  try {
    await f.service.grant({ sessionId: 'parent' }, [f.catalog.id], 'child')
    for (const member of f.members) await f.service.grant({ sessionId: 'producer' }, [member.id], 'child')
    // The recorded RED established that ordinary pins cannot supply a transfer
    // witness. They must remain a conflict, never be upgraded into a receipt.
    await expect(f.service.readExecResult({ sessionId: 'child' }, { ref: f.members[0]!, viaCatalog: f.catalog })).rejects.toThrow(/membership/)
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    expect(await f.service.confirmSeedDependencies(scope, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'conflict' })
  } finally { await f.service.close() }
})

it('passively confirms surviving target retention after source release and a failed NEW check', async () => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    const confirmed = await f.service.confirmSeedDependencies(scope, f.request, () => true)
    expect(confirmed.kind).toBe('confirmed')
    await f.deleted(['parent']); f.revokeSource()
    expect((await f.service.confirmSeedDependencies(scope, f.request, () => true)).kind).toBe('blocked')
    const calls = f.sourceCalls(), mutations = controls.mutations
    expect(await f.service.reconcileSeedDependencies(scope, f.request)).toEqual(confirmed)
    expect(f.sourceCalls()).toBe(calls); expect(controls.mutations).toBe(mutations)
    expect(await f.service.readExecResult({ sessionId: 'child' }, { ref: f.members[0]!, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eA==' }] })
    const recovered = f.service.registerSeedDependencyTransfer(f.access)
    expect(await f.service.reconcileSeedDependencies(recovered, f.request)).toEqual(confirmed)
  } finally { await f.service.close() }
})

it.each(['pin', 'access', 'companion'] as const)('does not recreate a missing target %s during passive original confirmation', async missing => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    expect((await f.service.confirmSeedDependencies(scope, f.request, () => true)).kind).toBe('confirmed')
    const path = missing === 'pin' ? f.pin(f.members[0]!) : missing === 'access' ? resolve(f.directory(f.members[0]!), 'access', sha('child') + '.json') : f.companion(f.members[0]!)
    await rm(path); f.revokeSource()
    const calls = f.sourceCalls(), mutations = controls.mutations
    expect(await f.service.reconcileSeedDependencies(scope, f.request)).toEqual({ kind: 'blocked', reason: 'unavailable' })
    expect(f.sourceCalls()).toBe(calls); expect(controls.mutations).toBe(mutations)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.service.close() }
})

it.each(['pin', 'access', 'companion'] as const)('continues original %s publication after real link/sync/response cuts', async location => {
  for (const cut of ['link', 'sync', 'response']) {
    const f = await fixture()
    try {
      const scope = f.service.registerSeedDependencyTransfer(f.access), ref = f.members[1]!
      controls.cutPath = location === 'pin' ? f.pin(ref) : location === 'access' ? resolve(f.directory(ref), 'access', sha('child') + '.json') : f.companion(ref)
      controls.cut = cut
      expect(await f.service.confirmSeedDependencies(scope, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'unknown' })
      controls.cut = ''
      const before = await readdir(resolve(controls.cutPath, '..')), mutations = controls.mutations, calls = f.sourceCalls()
      const passive = await f.service.reconcileSeedDependencies(scope, f.request)
      expect(passive.kind).toBe(location === 'companion' && cut === 'response' ? 'confirmed' : 'blocked')
      expect(f.sourceCalls()).toBe(calls); expect(controls.mutations).toBe(mutations)
      expect(await readdir(resolve(controls.cutPath, '..'))).toEqual(before)
      expect((await f.service.confirmSeedDependencies(scope, f.request, () => true)).kind).toBe('confirmed')
    } finally { controls.cut = ''; controls.cutPath = ''; await f.service.close() }
  }
})

it('requires captured genuine scopes, closed bindings/hooks and the exact first full request', async () => {
  const f = await fixture()
  try {
    for (const access of [
      { ...f.access, extra: true }, { ...f.access, binding: { ...f.binding, extra: true } },
      { ...f.access, binding: { ...f.binding, operationId: 'x'.repeat(257) } },
      { ...f.access, binding: { ...f.binding, targetDocumentId: 'other' } }, { ...f.access, sourceAccess: { sessionId: 'other' } },
      new Proxy(f.access, {}), Object.defineProperty({ ...f.access }, 'hidden', { value: true }),
      Object.defineProperty({ ...f.access }, 'binding', { enumerable: true, get: () => { throw Error('getter must not execute') } }),
    ]) expect(() => f.service.registerSeedDependencyTransfer(access as SeedDependencyHostAccess)).toThrow()
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    expect(await f.service.confirmSeedDependencies({ kind: 'seed-dependency-transfer' }, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'unavailable' })
    const original = structuredClone(f.request)
    const result = await f.service.confirmSeedDependencies(scope, f.request, () => true)
    expect(result.kind).toBe('confirmed')
    const changes = [
      { ...original, operationId: 'other' }, { ...original, manifestDigest: 'b'.repeat(64) }, { ...original, sourceSessionId: 'other' }, { ...original, targetSessionId: 'other' },
      { ...original, artifacts: [{ ...original.artifacts[0]!, uses: [{ kind: 'result' }] }] },
      { ...original, artifacts: [{ ...original.artifacts[0]!, origins: [{ origin: 0, seq: 2, part: 'result' }] }] },
      { ...original, artifacts: [{ ...original.artifacts[0]!, ref: { ...f.catalog, completeness: 'source-limited' } }] },
    ]
    for (const request of changes) expect(await f.service.reconcileSeedDependencies(scope, request as BootstrapDependencyRequest)).toEqual({ kind: 'blocked', reason: 'conflict' })
    f.access.binding.operationId = 'mutated-caller'; f.access.assertTargetCurrent = () => { throw Error('mutated hook') }
    expect(await f.service.reconcileSeedDependencies(scope, original)).toEqual(result)
  } finally { await f.service.close() }
})

it('rejects malformed uses/full refs/counts and unavailable source evidence before publishing any target pin', async () => {
  const f = await fixture()
  try {
    const bad = [
      { ...f.request, artifacts: [{ ...f.request.artifacts[0]!, uses: [] }] },
      { ...f.request, artifacts: [{ ...f.request.artifacts[0]!, uses: [{ kind: 'dependency-catalog', count: 0 }] }] },
      { ...f.request, artifacts: [{ ...f.request.artifacts[0]!, uses: [{ kind: 'dependency-catalog', count: 5 }] }] },
      { ...f.request, artifacts: [{ ...f.request.artifacts[0]!, uses: [{ kind: 'dependency-catalog', count: 4, hidden: true }] }] },
      { ...f.request, artifacts: [{ ...f.request.artifacts[0]!, ref: { ...f.catalog, encodedBytes: f.catalog.encodedBytes + 1 } }] },
      { ...f.request, artifacts: [{ ...f.request.artifacts[0]!, origins: [{ origin: -1, seq: 1, part: 'result' }] }] },
    ]
    for (const request of bad) {
      const scope = f.service.registerSeedDependencyTransfer(f.access)
      expect((await f.service.confirmSeedDependencies(scope, request as BootstrapDependencyRequest, () => true)).kind).toBe('blocked')
      await expect(readFile(f.pin(f.catalog))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await rm(f.companion(f.members[0]!, 'parent'))
    expect((await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), f.request, () => true)).kind).toBe('blocked')
    await expect(readFile(f.pin(f.catalog))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.service.close() }
})

it('validates v1 source canonical membership against the complete catalog before any transfer publication', async () => {
  const f = await fixture()
  try {
    const path = f.companion(f.members[0]!, 'parent'), original = JSON.parse(await readFile(path, 'utf8'))
    for (const changed of [{ ...original, sourceId: 'wrong-native' }, { ...original, ordinal: 3, sourceId: 'native-alias' }]) {
      await writeFile(path, JSON.stringify(changed))
      expect((await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), f.request, () => true)).kind).toBe('blocked')
      await expect(readFile(f.pin(f.catalog))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally { await f.service.close() }
})

it('rechecks source policy and target revision after real catalog I/O and latches target ABA', async () => {
  for (const revoke of ['source', 'target', 'caller'] as const) {
    const f = await fixture(); let current = true
    try {
      const scope = f.service.registerSeedDependencyTransfer(f.access)
      controls.afterRead = path => { if (path === resolve(f.directory(f.catalog), 'body')) { if (revoke === 'source') f.revokeSource(); else if (revoke === 'target') f.setRevision('target-rev-2'); else current = false } }
      expect(await f.service.confirmSeedDependencies(scope, f.request, () => current)).toEqual({ kind: 'blocked', reason: 'policy' })
      controls.afterRead = undefined
      await expect(readFile(f.pin(f.catalog))).rejects.toMatchObject({ code: 'ENOENT' })
      if (revoke === 'target') {
        f.setRevision('target-rev-1')
        expect(await f.service.confirmSeedDependencies(scope, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'policy' })
      }
    } finally { controls.afterRead = undefined; await f.service.close() }
  }
})

it('retains original catalog/member identities across nested transfer and rejects forged v2 aliases', async () => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    expect((await f.service.confirmSeedDependencies(scope, f.request, () => true)).kind).toBe('confirmed')
    const nestedRequest = { ...f.request, operationId: 'second-bootstrap', sourceSessionId: 'child', targetSessionId: 'grandchild' }
    const nested = f.service.registerSeedDependencyTransfer({ ...f.access, binding: { ...f.binding, operationId: 'second-bootstrap', sourceSessionId: 'child', targetSessionId: 'grandchild', targetDocumentId: 'grandchild' }, sourceAccess: { sessionId: 'child' } })
    expect((await f.service.confirmSeedDependencies(nested, nestedRequest, () => true)).kind).toBe('confirmed')
    const path = f.companion(f.members[0]!, 'grandchild'), original = await readFile(path, 'utf8'), record = JSON.parse(original)
    expect(record).toMatchObject({ catalogOwner: f.owner, catalogOperationId: 'original-catalog', memberOperationId: 'member-0', sourceSessionId: 'child', ordinal: 0, sourceId: 'native-a' })
    for (const corrupted of [{ ...record, ordinal: 3, sourceId: 'native-alias' }, { ...record, sourceId: 'wrong' }, { ...record, manifestDigest: 'b'.repeat(64) }, { ...record, memberOperationId: 'other' }, { ...record, catalogOwner: { ...f.owner, callId: 'other' } }, { ...record, catalogRef: { ...f.catalog, encodedBytes: 0 } }, { ...record, extra: true }]) {
      await writeFile(path, JSON.stringify(corrupted))
      await expect(f.service.readExecResult({ sessionId: 'grandchild' }, { ref: f.members[0]!, viaCatalog: f.catalog })).rejects.toThrow()
    }
    await writeFile(path, original); await f.deleted(['parent', 'child'])
    expect((await f.service.reconcileSeedDependencies(nested, nestedRequest)).kind).toBe('confirmed')
    expect(await f.service.readExecResult({ sessionId: 'grandchild' }, { ref: f.members[0]!, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eA==' }] })
    await f.deleted(['grandchild'])
    expect(await f.service.reconcileSeedDependencies(nested, nestedRequest)).toEqual({ kind: 'blocked', reason: 'unavailable' })
  } finally { await f.service.close() }
})

it('returns typed unavailable for an oversized original catalog owner without publishing target metadata', async () => {
  const f = await fixture(0, 'x'.repeat(7500))
  try {
    expect(await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), f.request, () => true)).toEqual({ kind: 'blocked', reason: 'unavailable' })
    await expect(readFile(f.pin(f.catalog))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.service.close() }
})

it('keeps source authorization and target staging capability separate from ordinary body-read policy', async () => {
  const f = await fixture()
  try {
    f.denySourcePolicy()
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    expect(await f.service.confirmSeedDependencies(scope, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'policy' })
    await expect(readFile(f.pin(f.catalog))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.service.close() }
  const g = await fixture()
  try {
    const scope = g.service.registerSeedDependencyTransfer(g.access)
    const confirmed = await g.service.confirmSeedDependencies(scope, g.request, () => true)
    expect(confirmed.kind).toBe('confirmed')
    const bytes = await readFile(g.pin(g.catalog)); g.denyTargetPolicy()
    // T-07: ordinary read visibility is not pre-READY staging authority. Keep
    // the real read denial, and independently revoke the captured capability.
    expect(await g.service.reconcileSeedDependencies(scope, g.request)).toEqual(confirmed)
    expect(await readFile(g.pin(g.catalog))).toEqual(bytes)
    await expect(g.service.readExecResult({ sessionId: 'child' }, { ref: g.members[0]!, viaCatalog: g.catalog })).rejects.toThrow(/unauthorized/)
    g.revokeTarget()
    expect(await g.service.reconcileSeedDependencies(scope, g.request)).toEqual({ kind: 'blocked', reason: 'policy' })
  } finally { await g.service.close() }
})

it.each(['deny', 'throw'] as const)('stages with the captured target capability while ordinary target reads %s before readiness', async mode => {
  const f = await fixture()
  try {
    if (mode === 'deny') f.denyTargetPolicy(); else f.throwTargetPolicy()
    const scope = f.service.registerSeedDependencyTransfer(f.access), calls = f.targetReadCalls()
    const confirmed = await f.service.confirmSeedDependencies(scope, f.request, () => true)
    expect(confirmed.kind).toBe('confirmed')
    expect(f.targetReadCalls()).toBe(calls)
    expect(await f.service.reconcileSeedDependencies(scope, f.request)).toEqual(confirmed)
    expect(f.targetReadCalls()).toBe(calls)
    await expect(f.service.readExecResult({ sessionId: 'child' }, { ref: f.members[0]!, viaCatalog: f.catalog })).rejects.toThrow(mode === 'deny' ? /unauthorized/ : /incomplete target/)
    expect(f.targetReadCalls()).toBeGreaterThan(calls)
  } finally { await f.service.close() }
})

it.each(['catalog', 'member'] as const)('blocks an original %s source identity incompatible with the captured target even when source reads permit it', async mismatch => {
  const f = await fixture(0, undefined, 'original-', { [mismatch]: 'other-original-source' })
  try {
    expect(await f.service.readExecResult({ sessionId: 'parent' }, { ref: f.members[0]!, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eA==' }] })
    expect(await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), f.request, () => true)).toEqual({ kind: 'blocked', reason: 'policy' })
    await expect(readFile(f.pin(f.catalog))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.service.close() }
})

it('preserves legacy source-less root authority without inventing an original source', async () => {
  const f = await fixture()
  try {
    const sink = await f.service.beginResult(f.service.registerResultScope({ operationId: 'legacy-source-less', sessionId: 'parent', callId: 'legacy' }, () => true), 'text-utf8-v1')
    await sink.write(Buffer.from('legacy original'))
    const result = await sink.finish('complete'); if (result.kind !== 'committed') throw Error('legacy root fixture refused')
    expect(await f.service.readResult({ sessionId: 'parent' }, { ref: result.ref })).toMatchObject({ data: { kind: 'text', text: 'legacy original' } })
    const request = { ...f.request, artifacts: [{ ref: result.ref, origins: [], uses: [{ kind: 'result' as const }] }] }
    f.throwTargetPolicy()
    const confirmed = await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), request, () => true)
    expect(confirmed.kind).toBe('confirmed')
    expect(JSON.parse(await readFile(resolve(f.directory(result.ref), 'operation.json'), 'utf8')).owner).not.toHaveProperty('source')
    expect(await f.service.readResult({ sessionId: 'child' }, { ref: result.ref })).toMatchObject({ data: { kind: 'text', text: 'legacy original' } })
  } finally { await f.service.close() }
})

it('renews NEW source authorization after quota preflight before the first target mutation', async () => {
  const f = await fixture()
  try {
    const inventory = await readdir(resolve(f.directory(f.catalog), '..'), { recursive: true }), mutations = controls.mutations
    let denied = false
    controls.afterReaddir = path => { if (path === resolve(f.directory(f.catalog), '../..')) { denied = true; f.denySourcePolicy() } }
    expect(await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), f.request, () => true)).toEqual({ kind: 'blocked', reason: 'policy' })
    expect(denied).toBe(true); expect(controls.mutations).toBe(mutations)
    expect(await readdir(resolve(f.directory(f.catalog), '..'), { recursive: true })).toEqual(inventory)
  } finally { controls.afterReaddir = undefined; await f.service.close() }
})

it('blocks the reviewed late source-policy denial after the first real target pin publication without rolling it back', async () => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    let denied = false
    controls.afterRead = path => { if (path === f.pin(f.catalog)) { denied = true; f.denySourcePolicy() } }
    expect(await f.service.confirmSeedDependencies(scope, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'policy' })
    expect(denied).toBe(true); controls.afterRead = undefined
    const pin = await readFile(f.pin(f.catalog)), calls = f.sourceCalls(), mutations = controls.mutations
    expect(JSON.parse(pin.toString())).toMatchObject({ operationId: 'original-catalog', state: 'committed', seedTransfer: f.binding })
    await expect(readFile(f.pin(f.members[0]!))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.service.reconcileSeedDependencies(scope, f.request)).toEqual({ kind: 'blocked', reason: 'unavailable' })
    expect(await readFile(f.pin(f.catalog))).toEqual(pin)
    expect(f.sourceCalls()).toBe(calls); expect(controls.mutations).toBe(mutations)
  } finally { controls.afterRead = undefined; await f.service.close() }
})

it('renews each member-via-catalog relation when a shared member loses visibility during an unrelated root publication', async () => {
  const f = await fixture()
  try {
    const original = f.service.registerResultDependencyScope({ ...f.owner, operationId: 'another-original-catalog' }, () => true, f.entries)
    const sink = await f.service.beginResult(original, 'json-utf8-v1')
    await sink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries: f.entries })))
    const result = await sink.finish('complete'); if (result.kind !== 'committed') throw Error('second original catalog fixture refused')
    expect(await f.service.settleResultDependencyMembership(original, result.ref)).toBe('ready')
    const catalogs = [f.catalog, result.ref].sort((a, b) => a.id.localeCompare(b.id))
    // Identical catalog bodies give identical non-ID ref fields. The first
    // relation must survive when the same member is later seen via the second.
    const request = { ...f.request, artifacts: catalogs.map(ref => ({ ...f.request.artifacts[0]!, ref })) }
    let denied = false
    controls.afterRead = path => { if (path === f.pin(catalogs[1]!)) { denied = true; f.denySourceRelation(f.members[0]!, catalogs[0]!) } }
    expect(await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), request, () => true)).toEqual({ kind: 'blocked', reason: 'policy' })
    expect(denied).toBe(true); controls.afterRead = undefined
    await expect(f.service.readExecResult({ sessionId: 'parent' }, { ref: f.members[0]!, viaCatalog: catalogs[0]! })).rejects.toThrow(/unauthorized/)
    expect(await f.service.readExecResult({ sessionId: 'parent' }, { ref: f.members[0]!, viaCatalog: catalogs[1]! })).toMatchObject({ frames: [{ data: 'eA==' }] })
    await expect(readFile(f.pin(f.members[0]!))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { controls.afterRead = undefined; await f.service.close() }
})

it('renews NEW source authorization after final integrity confirmation while PASSIVE can confirm the exact issued work', async () => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    let denied = false
    controls.afterRead = path => {
      if (path === resolve(f.directory(f.members[0]!), 'operation.json') && existsSync(f.companion(f.members[1]!))) { denied = true; f.denySourcePolicy() }
    }
    expect(await f.service.confirmSeedDependencies(scope, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'policy' })
    expect(denied).toBe(true); controls.afterRead = undefined
    const paths = [f.pin(f.catalog), ...f.members.flatMap(ref => [f.pin(ref), f.companion(ref)])]
    const before = await Promise.all(paths.map(path => readFile(path))), calls = f.sourceCalls(), mutations = controls.mutations
    expect((await f.service.reconcileSeedDependencies(scope, f.request)).kind).toBe('confirmed')
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before)
    expect(f.sourceCalls()).toBe(calls); expect(controls.mutations).toBe(mutations)
  } finally { controls.afterRead = undefined; await f.service.close() }
})

it('passive recovery never touches captured source hooks or an aborted source signal', async () => {
  const f = await fixture()
  try {
    const confirmed = await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), f.request, () => true)
    expect(confirmed.kind).toBe('confirmed')
    const controller = new AbortController(); controller.abort()
    const passive = f.service.registerSeedDependencyTransfer({ ...f.access, sourceAccess: { sessionId: 'parent', signal: controller.signal }, sourceAvailable: () => { throw Error('source availability touched') }, assertSourceCurrent: () => { throw Error('source currentness touched') } })
    const calls = f.sourceCalls()
    expect(await f.service.reconcileSeedDependencies(passive, f.request)).toEqual(confirmed)
    expect(f.sourceCalls()).toBe(calls)
    const reordered = f.service.registerSeedDependencyTransfer({ ...f.access, binding: Object.fromEntries(Object.entries(f.binding).reverse()) as typeof f.binding })
    expect(await f.service.reconcileSeedDependencies(reordered, f.request)).toEqual(confirmed)
  } finally { await f.service.close() }
})

it('never interprets a missing NEW caller check or truthy nonboolean host availability as authority', async () => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    expect((await f.service.confirmSeedDependencies(scope, f.request, () => true)).kind).toBe('confirmed')
    expect(await f.service.confirmSeedDependencies(scope, f.request, undefined as never)).toEqual({ kind: 'blocked', reason: 'conflict' })
    for (const field of ['sourceAvailable', 'targetAvailable'] as const) {
      const invalid = f.service.registerSeedDependencyTransfer({ ...f.access, [field]: () => 'yes' as never })
      expect(await f.service.confirmSeedDependencies(invalid, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'policy' })
    }
  } finally { await f.service.close() }
})

it.each(['body', 'index', 'manifest.json'] as const)('refuses bodyless or incomplete original %s retention without reading member bytes', async missing => {
  for (const passive of [false, true]) {
    const f = await fixture()
    try {
      const scope = f.service.registerSeedDependencyTransfer(f.access)
      if (passive) expect((await f.service.confirmSeedDependencies(scope, f.request, () => true)).kind).toBe('confirmed')
      await rm(resolve(f.directory(f.members[0]!), missing)); controls.reads = []
      const outcome = passive ? await f.service.reconcileSeedDependencies(scope, f.request) : await f.service.confirmSeedDependencies(scope, f.request, () => true)
      expect(outcome).toEqual({ kind: 'blocked', reason: 'unavailable' })
      expect(controls.reads.filter(path => f.members.some(ref => path === resolve(f.directory(ref), 'body')))).toEqual([])
      if (!passive) await expect(readFile(f.pin(f.catalog))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.service.close() }
  }
})

it('accounts for foreign pending evidence without overwriting finals or cleaning inventory', async () => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    expect((await f.service.confirmSeedDependencies(scope, f.request, () => true)).kind).toBe('confirmed')
    const path = f.companion(f.members[0]!), original = await readFile(path), foreign = path + '.' + 'f'.repeat(64) + '.pending'
    await writeFile(foreign, 'retained foreign transaction')
    const mutations = controls.mutations
    expect(await f.service.reconcileSeedDependencies(scope, f.request)).toEqual({ kind: 'blocked', reason: 'conflict' })
    expect(await f.service.confirmSeedDependencies(scope, f.request, () => true)).toEqual({ kind: 'blocked', reason: 'conflict' })
    expect(await readFile(path)).toEqual(original); expect(await readFile(foreign, 'utf8')).toBe('retained foreign transaction'); expect(controls.mutations).toBe(mutations)
  } finally { await f.service.close() }
})

it('derives publication directories from record kinds when the workspace path contains pin-memberships', async () => {
  const f = await fixture(0, undefined, 'pin-memberships-workspace-')
  try {
    expect((await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), f.request, () => true)).kind).toBe('confirmed')
    expect((await readdir(resolve(f.root, 'context-output', sha(f.workspaceId), 'managed-v1'))).sort()).toEqual([f.catalog.id, ...f.members.map(ref => ref.id)].sort())
    await expect(readFile(resolve(f.directory(f.catalog), 'pin-memberships'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.service.close() }
})

it('confirms already published exact metadata without admitting new quota growth', async () => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    const confirmed = await f.service.confirmSeedDependencies(scope, f.request, () => true)
    expect(confirmed.kind).toBe('confirmed')
    await f.service.configure({ maxDiskBytes: 1 })
    expect(await f.service.confirmSeedDependencies(scope, f.request, () => true)).toEqual(confirmed)
    expect(await f.service.reconcileSeedDependencies(scope, f.request)).toEqual(confirmed)
  } finally { await f.service.close() }
})

it('validates both committed target pins and their closed transfer binding on v2 reads', async () => {
  const f = await fixture()
  try {
    expect((await f.service.confirmSeedDependencies(f.service.registerSeedDependencyTransfer(f.access), f.request, () => true)).kind).toBe('confirmed')
    for (const ref of [f.catalog, f.members[0]!]) {
      const path = f.pin(ref), original = await readFile(path, 'utf8'), pin = JSON.parse(original)
      for (const corrupt of [{ ...pin, seedTransfer: { ...f.binding, extra: true } }, { ...pin, state: 'pending' }, { ...pin, seedTransfer: { ...f.binding, manifestDigest: 'b'.repeat(64) } }, { ...pin, seedTransfer: null }]) {
        await writeFile(path, JSON.stringify(corrupt))
        await expect(f.service.readExecResult({ sessionId: 'child' }, { ref: f.members[0]!, viaCatalog: f.catalog })).rejects.toThrow()
      }
      await writeFile(path, original)
    }
  } finally { await f.service.close() }
})

it('matches an independent literal closure vector including ordered roots, aliases and unavailable occurrences', () => {
  // Independently generated with a standalone Node crypto script and its own
  // sorted JSON encoder, without importing any artifact/core hash helpers.
  const ref = (id: string, codec: ManagedArtifactRef['codec']): ManagedArtifactRef => ({ version: 1, id: `ctxv1_${id.repeat(64)}`, revision: 'a'.repeat(64), codec, encodedBytes: 8, contentDigest: 'b'.repeat(64), completeness: 'complete' })
  const catalog = ref('1', 'json-utf8-v1'), result = ref('2', 'text-utf8-v1'), member = ref('3', 'exec-frames-v1')
  const catalogOwner = { operationId: 'catalog-op', sessionId: 'original', callId: 'observe', source: { sourceId: 'original-source' } }
  const memberOwner = { operationId: 'member-op', sessionId: 'producer', callId: 'exec' }
  const closure = createTransferClosure('vector-workspace', { operationId: 'transfer-op', targetDocumentId: 'child', targetSessionId: 'child', sourceSessionId: 'parent', manifestDigest: 'c'.repeat(64) })
  closure.root({ ref: catalog, origins: [], uses: [{ kind: 'result' }, { kind: 'dependency-catalog', count: 3 }] }, catalogOwner)
  closure.root({ ref: result, origins: [], uses: [{ kind: 'result' }] }, { operationId: 'result-op', sessionId: 'original', callId: 'result' })
  closure.catalog()
  closure.entry(catalog, catalogOwner, 0, { kind: 'exec-frames', sourceId: 'first', retention: { kind: 'artifact', ref: member } }, memberOwner)
  closure.entry(catalog, catalogOwner, 1, { kind: 'exec-frames', sourceId: 'unavailable', retention: { kind: 'unavailable', reason: 'quota', observedEncodedBytes: 99 } })
  closure.entry(catalog, catalogOwner, 2, { kind: 'exec-frames', sourceId: 'alias', retention: { kind: 'artifact', ref: member } }, memberOwner)
  expect(closure.finish()).toBe('f9ac068799791a85bd2f46e767048f97e5e7d76ec8b03a3f369f674584a5d968')
})

it('transfers original refs with canonical v2 witnesses without reading member bodies', async () => {
  const f = await fixture(101)
  try {
    const before = await Promise.all([f.catalog, ...f.members].map(async ref => [await readFile(resolve(f.directory(ref), 'operation.json')), await readFile(resolve(f.directory(ref), 'body'))]))
    const scope = f.service.registerSeedDependencyTransfer(f.access)
    controls.reads = []
    const outcome = await f.service.confirmSeedDependencies(scope, f.request, () => true)
    // Separate standalone hash calculation over the actual original operations
    // and 105-entry body; this literal detects skipped unavailable/alias folds.
    expect(outcome).toEqual({ kind: 'confirmed', closureDigest: '0c1b3cd7ab95b0df8151cc549129d4d2cef4c45c555f404e27145683f3229582' })
    expect(controls.reads.filter(path => f.members.some(ref => path === resolve(f.directory(ref), 'body')))).toEqual([])
    for (const [n, member] of f.members.entries()) {
      expect(JSON.parse(await readFile(f.pin(member), 'utf8'))).toEqual({ version: 1, documentId: 'child', sessionId: 'child', operationId: `member-${n}`, revision: member.revision, state: 'committed', seedTransfer: f.binding })
      expect(JSON.parse(await readFile(f.companion(member), 'utf8'))).toMatchObject({ version: 2, kind: 'result-dependency-transfer', catalogOwner: f.owner, catalogOperationId: 'original-catalog', memberOperationId: `member-${n}`, sourceId: n === 0 ? 'native-a' : 'native-b', ordinal: n === 0 ? 0 : 2, transferOperationId: f.request.operationId, manifestDigest: f.request.manifestDigest, sourceSessionId: 'parent' })
      expect(await f.service.readExecResult({ sessionId: 'child' }, { ref: member, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eA==' }] })
    }
    expect(await Promise.all([f.catalog, ...f.members].map(async ref => [await readFile(resolve(f.directory(ref), 'operation.json')), await readFile(resolve(f.directory(ref), 'body'))]))).toEqual(before)
    f.revokeSource(); const calls = f.sourceCalls(), mutations = controls.mutations
    expect(await f.service.reconcileSeedDependencies(scope, f.request)).toEqual(outcome)
    expect(f.sourceCalls()).toBe(calls); expect(controls.mutations).toBe(mutations)
  } finally { await f.service.close() }
})

it.each(['link', 'sync', 'response'] as const)('settles only original selected managed publications after a %s cut', async cut => {
  const f = await fixture()
  try {
    const scope = f.service.registerSeedDependencyTransfer(f.access, 'original-publication')
    // The final companion is the last publication; all preceding work is owned.
    controls.cutPath = f.companion(f.members[1]!); controls.cut = cut
    expect((await f.service.confirmSeedDependencies(scope, f.request, () => true)).kind).toBe('blocked')
    controls.cut = ''; f.revokeSource(); const calls = f.sourceCalls()
    expect((await f.service.reconcileSeedDependencies(scope, f.request)).kind).toBe('confirmed')
    expect(f.sourceCalls()).toBe(calls)
    const foreign = f.service.registerSeedDependencyTransfer(f.access, 'original-publication')
    expect((await f.service.reconcileSeedDependencies(foreign, f.request)).kind).toBe('blocked')
  } finally { controls.cut = ''; await f.service.close() }
})

it('blocks passive confirmation after a successful final sync until original handle cleanup succeeds',async()=>{
 const f=await fixture();try{
 const warm=f.service.registerSeedDependencyTransfer(f.access);expect((await f.service.confirmSeedDependencies(warm,f.request,()=>true)).kind).toBe('confirmed')
 const cold=f.service.registerSeedDependencyTransfer(f.access);f.revokeSource();controls.cutPath=f.pin(f.catalog);controls.failClose=true
 const outcome=await f.service.reconcileSeedDependencies(cold,f.request);expect(outcome.kind).toBe('blocked');expect(controls.failed.length).toBeGreaterThan(0)
 const failed=new Set(controls.failed),counts=new Map(controls.closeCounts),reads=controls.reads.length,calls=f.sourceCalls(),mutations=controls.mutations
 controls.failClose=false;await settleSeedDependencyTransferIO(f.service,cold)
 expect(controls.reads).toHaveLength(reads);expect(f.sourceCalls()).toBe(calls);expect(controls.mutations).toBe(mutations)
 for(const [h,count]of counts)expect(controls.closeCounts.get(h)).toBe(count+(failed.has(h as import('node:fs/promises').FileHandle)?1:0))
 for(const h of failed)expect(h.fd).toBe(-1)
 expect((await f.service.reconcileSeedDependencies(cold,f.request)).kind).toBe('confirmed')
 }finally{controls.failClose=false;controls.failed=[];await f.service.close()}
})


it.each(['operation.json','manifest.json','index','body','catalog'] as const)('retains passive %s handles and settles only original cleanup',async name=>{
 const f=await fixture();try{const warm=f.service.registerSeedDependencyTransfer(f.access);expect((await f.service.confirmSeedDependencies(warm,f.request,()=>true)).kind).toBe('confirmed');const scope=f.service.registerSeedDependencyTransfer(f.access);f.revokeSource();controls.cutPath=resolve(f.directory(f.catalog),name==='catalog'?'body':name);controls.requireRead=name==='catalog';controls.closeMode='r';controls.failClose=true
 expect((await f.service.reconcileSeedDependencies(scope,f.request)).kind).toBe('blocked');expect(controls.failed.length).toBeGreaterThan(0);if(name==='body'){for(const [h,path]of controls.paths)if(path===resolve(f.directory(f.catalog),'index'))expect(controls.closeCounts.get(h)).toBe(1)}const reads=controls.reads.length,calls=f.sourceCalls();controls.failClose=false;await settleSeedDependencyTransferIO(f.service,scope);expect(controls.reads).toHaveLength(reads);expect(f.sourceCalls()).toBe(calls);expect((await f.service.reconcileSeedDependencies(scope,f.request)).kind).toBe('confirmed')
 }finally{controls.failClose=false;controls.requireRead=false;controls.closeMode='r+';controls.failed=[];await f.service.close()}
})
it.each([0,false,null,undefined])('blocks falsey primary+cleanup failure %s without losing original debt',async primary=>{
 const f=await fixture();try{const warm=f.service.registerSeedDependencyTransfer(f.access);expect((await f.service.confirmSeedDependencies(warm,f.request,()=>true)).kind).toBe('confirmed');const scope=f.service.registerSeedDependencyTransfer(f.access);controls.cutPath=f.pin(f.catalog);controls.primary=primary;controls.cut='falsey-sync';controls.failClose=true;controls.falsey=true
 expect((await f.service.reconcileSeedDependencies(scope,f.request)).kind).toBe('blocked');const settled=await settleSeedDependencyTransferIO(f.service,scope).then(()=>({ok:true}),error=>({ok:false,error}));expect(settled.ok).toBe(false);controls.cut='';controls.failClose=false;await settleSeedDependencyTransferIO(f.service,scope);expect((await f.service.reconcileSeedDependencies(scope,f.request)).kind).toBe('confirmed')
 }finally{controls.cut='';controls.failClose=false;controls.falsey=false;controls.failed=[];await f.service.close()}
})
it('joins pending passive close and service cleanup without confirmation or source regrant',async()=>{
 const f=await fixture();const leave=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();try{const warm=f.service.registerSeedDependencyTransfer(f.access);expect((await f.service.confirmSeedDependencies(warm,f.request,()=>true)).kind).toBe('confirmed');await f.deleted(['parent']);f.revokeSource();await f.deleted(['unrelated']);const scope=f.service.registerSeedDependencyTransfer(f.access);controls.cutPath=f.pin(f.catalog);controls.pending=leave.promise;controls.entered=entered.resolve;const calls=f.sourceCalls(),writes=controls.mutations;let confirmed=false,closed=false
 const verification=f.service.reconcileSeedDependencies(scope,f.request).then(result=>{confirmed=result.kind==='confirmed';return result});await entered.promise;const closing=f.service.close().then(()=>{closed=true});await Promise.resolve();expect(confirmed).toBe(false);expect(closed).toBe(false);leave.resolve();expect((await verification).kind).toBe('blocked');await closing;expect(f.sourceCalls()).toBe(calls);expect(controls.mutations).toBe(writes)
 }finally{leave.resolve();controls.pending=undefined;controls.entered=undefined;await f.service.close()}
})

it('preserves falsey partial-open and close failures independently on original integrity handles',async()=>{
 const f=await fixture(),io=createArtifactQualificationIO();try{controls.openFault=resolve(f.directory(f.catalog),'body');controls.primary=0;controls.cutPath=resolve(f.directory(f.catalog),'index');controls.closeMode='r';controls.failClose=true;controls.falsey=true
 const outcome=await readVerifiedArtifactBytes(f.root,f.directory(f.catalog),f.catalog,0,0,io).then(()=>({error:undefined}),error=>({error}));expect(outcome.error).toBeInstanceOf(AggregateError);expect((outcome.error as AggregateError).errors).toEqual([0,undefined]);expect(()=>io.assertSettled()).toThrow();const reads=controls.reads.length;controls.openFault='';controls.failClose=false;await io.settle();io.assertSettled();expect(controls.reads).toHaveLength(reads)
 }finally{controls.openFault='';controls.failClose=false;controls.falsey=false;controls.closeMode='r+';await io.settle();await f.service.close()}
})
