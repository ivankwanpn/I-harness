import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BootstrapDependencyRequest, ManagedArtifactRef, ResultDependency } from '@i-harness/core-session'
import { createContextOutputService } from '../src/index.ts'
import type { SeedDependencyHostAccess } from '../src/index.ts'
import { createTransferClosure } from '../src/artifact/transfer-closure.ts'
import { structureEvidence } from './structure-evidence.ts'

const controls = vi.hoisted(() => ({ reads: [] as string[], cutPath: '', cut: '', afterRead: undefined as undefined | ((path: string) => void), mutations: 0 }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), path = String(args[0]), read = handle.read.bind(handle), write = handle.write.bind(handle), sync = handle.sync.bind(handle)
    handle.read = (async (...params: Parameters<typeof read>) => { const result = await read(...params); controls.reads.push(path); controls.afterRead?.(path); return result }) as typeof handle.read
    handle.write = (async (...params: Parameters<typeof write>) => { controls.mutations++; return write(...params) }) as typeof handle.write
    handle.sync = async () => { if (controls.cut === 'sync' && path.startsWith(controls.cutPath)) throw new Error('sync cut'); return sync() }
    return handle
  }, link: async (...args: Parameters<typeof fs.link>) => {
    controls.mutations++
    if (String(args[1]) === controls.cutPath && controls.cut === 'link') throw new Error('link cut')
    await fs.link(...args)
    if (String(args[1]) === controls.cutPath && controls.cut === 'response') throw new Error('link response cut')
  }, unlink: async (...args: Parameters<typeof fs.unlink>) => { controls.mutations++; return fs.unlink(...args) } }
})
const evidence = resolve(structureEvidence('.tmp/context-transfer-artifact-20261023'), 'bootstrap-transfer')
await mkdir(evidence, { recursive: true })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
afterEach(() => Object.assign(controls, { reads: [], cutPath: '', cut: '', afterRead: undefined, mutations: 0 }))

async function fixture(extra = 0, ownerPath?: string, prefix = 'original-') {
  const root = await mkdtemp(resolve(evidence, prefix)), workspaceId = 'transfer-workspace'
  let source = true, target = true, sourcePolicy = true, targetPolicy = true, revision = 'target-rev-1', sourceCalls = 0
  let deleted!: (documents: readonly string[]) => Promise<void>
  const service = createContextOutputService({ root, workspaceId, documentDeletions: listener => { deleted = listener; return () => {} }, authorizeResult: (access, metadata) => {
    if (access.sessionId === 'parent') sourceCalls++
    return access.sessionId === 'producer' || (access.sessionId === 'parent' ? source && sourcePolicy : target && targetPolicy)
      && (metadata.ref.codec === 'json-utf8-v1' || !!metadata.visibleVia)
  } })
  const members: ManagedArtifactRef[] = []
  for (const n of [0, 1]) {
    const scope = service.registerResultScope({ operationId: `member-${n}`, sessionId: 'producer', callId: `exec-${n}`, source: { sourceId: 'original-project' } }, () => true)
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
  const owner = { operationId: 'original-catalog', sessionId: 'parent', callId: 'observe', source: { sourceId: 'original-project', ...(ownerPath ? { path: ownerPath } : {}) } }
  const scope = service.registerResultDependencyScope(owner, () => true, entries), sink = await service.beginResult(scope, 'json-utf8-v1')
  await sink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
  const catalog = await sink.finish('complete'); if (catalog.kind !== 'committed') throw Error('fixture catalog refused')
  expect(await service.settleResultDependencyMembership(scope, catalog.ref)).toBe('ready')
  const request: BootstrapDependencyRequest = { operationId: 'bootstrap-original', sourceSessionId: 'parent', targetSessionId: 'child', manifestDigest: 'a'.repeat(64), artifacts: [{ ref: catalog.ref, origins: [{ origin: 0, seq: 1, part: 'result' }], uses: [{ kind: 'dependency-catalog', count: entries.length }] }] }
  const binding = { operationId: request.operationId, sourceSessionId: request.sourceSessionId, targetSessionId: request.targetSessionId, targetDocumentId: request.targetSessionId, manifestDigest: request.manifestDigest }
  const access = { binding, sourceAccess: { sessionId: 'parent' }, sourceAvailable: () => source,
    assertSourceCurrent: () => { sourceCalls++; if (!source) throw Error('source revoked') }, targetAvailable: () => target,
    targetScope: () => ({ source: { sourceId: 'target-project' }, revision }), assertTargetCurrent: () => { if (!target) throw Error('target revoked') } }
  const directory = (ref: ManagedArtifactRef) => resolve(root, 'context-output', sha(workspaceId), 'managed-v1', ref.id)
  const pin = (ref: ManagedArtifactRef, session = 'child') => resolve(directory(ref), 'pins', sha(session) + '.json')
  const companion = (ref: ManagedArtifactRef, session = 'child') => resolve(directory(ref), 'pin-memberships', sha(session), sha(JSON.stringify([catalog.ref.id, catalog.ref.revision])) + '.json')
  return { root, workspaceId, service, members, entries, owner, catalog: catalog.ref, request, binding, access, directory, pin, companion, deleted,
    revokeSource: () => { source = false }, revokeTarget: () => { target = false }, denySourcePolicy: () => { sourcePolicy = false }, denyTargetPolicy: () => { targetPolicy = false }, setRevision: (value: string) => { revision = value }, sourceCalls: () => sourceCalls }
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

it('uses the actual source and target authorizer independently of physical retention', async () => {
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
    expect((await g.service.confirmSeedDependencies(scope, g.request, () => true)).kind).toBe('confirmed')
    const bytes = await readFile(g.pin(g.catalog)); g.denyTargetPolicy()
    expect(await g.service.reconcileSeedDependencies(scope, g.request)).toEqual({ kind: 'blocked', reason: 'policy' })
    expect(await readFile(g.pin(g.catalog))).toEqual(bytes)
    await expect(g.service.readExecResult({ sessionId: 'child' }, { ref: g.members[0]!, viaCatalog: g.catalog })).rejects.toThrow(/unauthorized/)
  } finally { await g.service.close() }
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
