import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { append, createSession, exportConversationSeed, managedResultRefs, rewindCuts, semanticSeedResultRefs, type BootstrapDependencyRequest, type ManagedArtifactRef, type ResultDependency } from '@i-harness/core-session'
import { compileSemanticSeed, createSessionCoordinator } from '@i-harness/session-persistence'
import { createBootstrapRequestIntent } from '../../session-persistence/src/coordinator/bootstrap-intent.ts'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { createProjectScopeBroker } from '../src/project-scope.ts'

const cleanup: (() => Promise<void>)[] = []
const io = vi.hoisted(() => ({ afterLink: undefined as undefined | ((path: string) => Promise<void>), afterRead: undefined as undefined | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async link(...args: Parameters<typeof fs.link>) { await fs.link(...args); await io.afterLink?.(String(args[1])) },
    async open(...args: Parameters<typeof fs.open>) { const handle = await fs.open(...args), read = handle.read.bind(handle)
      handle.read = (async (...params: Parameters<typeof read>) => { const result = await read(...params); await io.afterRead?.(String(args[0])); return result }) as typeof handle.read
      return handle
    } }
})
afterEach(async () => { io.afterLink = io.afterRead = undefined; for (const close of cleanup.splice(0).reverse()) await close() })
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture(empty = false, anonymous = false) {
  const root = await mkdtemp(join(tmpdir(), 'bt3-')), workspace = join(root, 'w'), storageRoot = join(root, 'n')
  cleanup.push(() => rm(root, { recursive: true, force: true })); await mkdir(workspace)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 's')), { lock: { enabled: true } })
  cleanup.push(() => coordinator.close()); await coordinator.create({ sessionId: 'source' })
  const broker = createProjectScopeBroker(coordinator, workspace); cleanup.push(() => broker.close())
  const project = { id: 'p', name: 'Project', roots: [workspace], primaryRoot: workspace }
  await broker.configure(project); await broker.bind('source', 'p')
  let sourceAlive = true, sourceVisible = true, targetVisible = true, sourceCalls = 0, targetProfiles = 0
  const visible = new Map<string, ManagedArtifactRef[]>()
  const openRuntime = async (passive = false, selectedBroker = broker) => {
    const runtime = await createNativeContextRuntime({ workspace, storageRoot,
      coordinator: { ...coordinator, async profile(id) { if (id === 'source') { sourceCalls++; if (passive) throw Error('cold source profile forbidden') } else targetProfiles++; return coordinator.profile(id) } },
      projectFor: selectedBroker.nativeScopeFor, resultReadScopeFor: selectedBroker.resultReadScopeFor,
      prepareBootstrapInheritance: selectedBroker.prepareBootstrapInheritance,
      visibleRefsFor: async id => {
        if (id === 'source') { sourceCalls++; if (passive) throw Error('cold source visibility forbidden'); return sourceVisible ? visible.get(id) ?? [] : [] }
        if (!targetVisible) return []
        const session = (await coordinator.snapshot!(id)).session, cuts = rewindCuts(session)
        return [...semanticSeedResultRefs(session), ...session.events.flatMap(event => cuts.some(cut => event.seq! >= cut.cutFrom && event.seq! < cut.markerSeq) ? [] : managedResultRefs(event))]
      } })
    cleanup.push(() => runtime.close()); return runtime
  }
  const runtime = await openRuntime(), owner = runtime.contextOutput, source = await runtime.sourceFor('source')
  const save = async (operationId: string, bytes: string, codec: ManagedArtifactRef['codec'] = 'text-utf8-v1') => {
    const scope = owner.registerResultScope({ operationId, sessionId: 'source', callId: operationId, source }, () => sourceAlive)
    const sink = await owner.beginResult(scope, codec); await sink.write(Buffer.from(bytes)); const saved = await sink.finish('complete')
    if (saved.kind !== 'committed') throw Error('fixture artifact'); return saved.ref
  }
  const text = await save('text-original', 'retained conversation text')
  const member = await save('exec-original', 'IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n', 'exec-frames-v1')
  const entries: ResultDependency[] = [{ kind: 'exec-frames', sourceId: 'exec-a', retention: { kind: 'artifact', ref: member } }, { kind: 'exec-frames', sourceId: 'missing', retention: { kind: 'unavailable', reason: 'quota' } }, { kind: 'exec-frames', sourceId: 'alias', retention: { kind: 'artifact', ref: member } }]
  const scope = owner.registerResultDependencyScope({ operationId: 'catalog-original', sessionId: 'source', callId: 'observe', source }, () => sourceAlive, entries)
  const sink = await owner.beginResult(scope, 'json-utf8-v1'); await sink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture catalog')
  const catalog = saved.ref; expect(await owner.settleResultDependencyMembership(scope, catalog)).toBe('ready'); visible.set('source', [text, catalog])
  const session = createSession()
  append(session, { type: 'turn/start' }); append(session, { type: 'step/start' }); append(session, { type: 'tool/call', callId: 'observe', name: 'read', args: {} }); append(session, { type: 'assistant/message', text: '' })
  append(session, { type: 'tool/result', callId: 'observe', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'retained', media: [], retention: { kind: 'artifact', ref: text }, dependencies: { kind: 'artifact-set', ref: catalog, count: entries.length } } })
  append(session, { type: 'step/end' }); append(session, { type: 'turn/end' })
  const exported = exportConversationSeed(session, anonymous ? { kind: 'anonymous' } : { kind: 'session', sessionId: 'source' }, { kind: 'all' }); if (exported.kind !== 'seed') throw Error('fixture seed')
  const seed = compileSemanticSeed(empty ? { kind: 'none' } : exported)
  const { intent, requestDigest } = createBootstrapRequestIntent({ action: 'fork', selection: 'all' }, { kind: 'project', projectId: 'p' })
  const invocation = { version: 1 as const, operationId: 'transfer-op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest }
  const request = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed }
  const capture = () => ({ invocation, requestIntent: intent, sourceSessionId: 'source', sourceAvailable() { sourceCalls++; return sourceAlive }, assertNewWorkCurrent() { sourceCalls++; if (!sourceAlive) throw Error('source closed') }, targetAvailable: () => true })
  const directory = (ref: ManagedArtifactRef) => join(storageRoot, 'context-output', 'context-output', sha(runtime.workspaceId), 'managed-v1', ref.id)
  return { root, runtime, coordinator, broker, project, request, capture, text, member, catalog, directory, openRuntime,
    closeSource: async () => { sourceAlive = false; await coordinator.closeManagedDocument('source'); await coordinator.updateMeta('source', { archived: true }) },
    denySource: () => { sourceVisible = false }, denyTarget: () => { targetVisible = false }, sourceCalls: () => sourceCalls, targetProfiles: () => targetProfiles }
}

it('legacy inheritance cannot complete genuine pre-READY storage bootstrap (behavioral baseline)', async () => {
  const f = await fixture(), preparation = f.broker.prepareBootstrapInheritance(f.capture())
  const outcome = await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, targetPreparation: preparation.targetPreparation, dependencies: {
    async confirm() { try { await f.runtime.inheritFork('source', 'target', [f.text, f.catalog]) } catch { return { kind: 'blocked', reason: 'unavailable' } } throw Error('legacy fixture unexpectedly passed incomplete profile') },
    async reconcile() { throw Error('legacy transfer never completed') },
  } })
  // Existing inheritance still requires a public READY profile. The adapter
  // positive below must complete through genuine staging instead.
  expect(outcome.kind).toBe('blocked')
})

it('composes genuine preparation and transfer before READY, then reads text and catalog members through the supplied service', async () => {
  const f = await fixture(), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
  const confirmation = vi.spyOn(f.runtime.contextOutput, 'confirmSeedDependencies'), reconciliation = vi.spyOn(f.runtime.contextOutput, 'reconcileSeedDependencies')
  const ready = await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })
  expect(ready.kind).toBe('ready'); expect(confirmation).toHaveBeenCalledTimes(1); expect(f.targetProfiles()).toBe(0)
  expect(reconciliation.mock.calls.every(call => call[0] === confirmation.mock.calls[0]![0])).toBe(true)
  await f.closeSource(); transfer.close()
  const service = createSessionService({ workspace: join(f.root, 'w'), coordinator: f.coordinator, contextOutput: f.runtime.contextOutput, resultReadScopeFor: f.broker.resultReadScopeFor })
  cleanup.push(() => service.close())
  expect(await service.readResultPage!('target', { ref: f.text })).toMatchObject({ data: { text: 'retained conversation text' } })
  expect(await service.readResultPage!('target', { ref: f.member, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eA==' }] })
  expect(service.hasAssembly('target')).toBe(false)
  f.denyTarget(); await expect(f.runtime.contextOutput.readResult({ sessionId: 'target' }, { ref: f.text })).rejects.toThrow(/unauthorized/)
})

it.each(['none', 'empty-observation'])('prepares %s with zero artifact callbacks', async kind => {
  const f = await fixture(true), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), undefined)
  if (kind === 'empty-observation') {
    const exported = exportConversationSeed(createSession(), { kind: 'session', sessionId: 'source' }, { kind: 'all' })
    if (exported.kind !== 'seed') throw Error('empty observation fixture')
    f.request.seed = compileSemanticSeed(exported)
  }
  const confirm = vi.spyOn(transfer.dependencies, 'confirm'), reconcile = vi.spyOn(transfer.dependencies, 'reconcile')
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })).kind).toBe('ready')
  expect(confirm).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled(); expect((await f.broker.nativeScopeFor('target')).projectId).toBe('p')
})

it('does not invent source authority for anonymous artifact observations', async () => {
  const f = await fixture(false, true), { sourceSessionId: _, ...capture } = f.capture(), transfer = f.runtime.prepareBootstrapTransfer(capture, undefined)
  const confirm = vi.spyOn(transfer.dependencies, 'confirm')
  expect(await f.coordinator.bootstrapSemanticTarget({ ...f.request, lineage: { origin: 'import' } }, { assertCurrent() {}, ...transfer })).toEqual({ kind: 'refused', reason: 'target-policy' })
  expect(confirm).not.toHaveBeenCalled()
  await expect(readFile(join(f.directory(f.member), 'pins', sha('target') + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cold passive adoption needs no original source access and cannot upgrade that factory to NEW', async () => {
  const f = await fixture(), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
  let original!: BootstrapDependencyRequest
  const confirm = transfer.dependencies.confirm
  transfer.dependencies.confirm = (request, current) => { original = structuredClone(request); return confirm(request, current) }
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })).kind).toBe('ready')
  await f.closeSource(); await f.runtime.close(); await f.broker.close(); await f.coordinator.closeManagedDocument('target')
  const broker = createProjectScopeBroker(f.coordinator, join(f.root, 'w')); cleanup.push(() => broker.close()); await broker.configure(f.project)
  const cold = await f.openRuntime(true, broker), calls = f.sourceCalls()
  const passive = cold.prepareBootstrapTransfer({ ...f.capture(), sourceAvailable() { throw Error('passive source hook') }, assertNewWorkCurrent() { throw Error('passive source action') } }, undefined)
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() { throw Error('passive action') }, ...passive })).kind).toBe('already-ready')
  expect(f.sourceCalls()).toBe(calls)
  expect((await passive.dependencies.confirm(original, () => true)).kind).toBe('blocked')
  expect(await cold.contextOutput.readExecResult({ sessionId: 'target' }, { ref: f.member, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eA==' }] })
  const pin = join(f.directory(f.member), 'pins', sha('target') + '.json'); await rm(pin)
  expect((await passive.dependencies.reconcile(original)).kind).toBe('blocked'); await expect(readFile(pin)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('captures source access and host functions synchronously, rejects malformed containers without getters, and retains exact full requests', async () => {
  const f = await fixture(), capture = f.capture(), access = { sessionId: 'source' }, transfer = f.runtime.prepareBootstrapTransfer(capture, access)
  capture.sourceAvailable = () => false; capture.targetAvailable = () => false; access.sessionId = 'wrong'
  let getters = 0
  expect(() => f.runtime.prepareBootstrapTransfer(f.capture(), Object.defineProperty({}, 'sessionId', { enumerable: true, get() { getters++; return 'source' } }) as any)).toThrow()
  expect(() => f.runtime.prepareBootstrapTransfer(f.capture(), Object.defineProperty({ sessionId: 'source' }, 'hidden', { value: true }))).toThrow()
  expect(() => f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'wrong' })).toThrow()
  expect(getters).toBe(0)
  const register = vi.spyOn(f.runtime.contextOutput, 'registerSeedDependencyTransfer'), confirm = vi.spyOn(f.runtime.contextOutput, 'confirmSeedDependencies')
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })).kind).toBe('ready')
  const original = structuredClone(confirm.mock.calls[0]![1])
  for (const changed of [
    { ...original, operationId: 'different' }, { ...original, sourceSessionId: 'different' }, { ...original, targetSessionId: 'different' }, { ...original, manifestDigest: 'f'.repeat(64) },
    { ...original, artifacts: original.artifacts.map(a => ({ ...a, origins: [{ origin: 0, seq: 99, part: 'result' }] })) },
    { ...original, artifacts: original.artifacts.map(a => ({ ...a, ref: { ...a.ref, contentDigest: 'f'.repeat(64) } })) },
    { ...original, artifacts: original.artifacts.map(a => ({ ...a, uses: [{ kind: 'result' as const }] })) },
  ]) expect(await transfer.dependencies.reconcile(changed)).toMatchObject({ kind: 'blocked', reason: 'conflict' })
  expect(register).toHaveBeenCalledTimes(1)
  expect((await transfer.dependencies.confirm(original, undefined as any)).kind).toBe('blocked')
  expect((await transfer.dependencies.reconcile(original)).kind).toBe('confirmed')
  transfer.close(); expect((await transfer.dependencies.reconcile(original)).kind).toBe('blocked')
})

it('requires current source catalog visibility for NEW and refuses source-free NEW without fabricating retention', async () => {
  const f = await fixture(), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
  f.denySource()
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })).kind).toBe('blocked')
  await expect(readFile(join(f.directory(f.member), 'pins', sha('target') + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const passive = f.runtime.prepareBootstrapTransfer(f.capture(), undefined)
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...passive })).kind).toBe('blocked')
})

it('binds the actual broker manifest before its asynchronous confirmation can observe caller mutation', async () => {
  const f = await fixture(), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
  let traps = 0
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw Error('proxy trap') } })
  expect(await transfer.targetPreparation.confirm(proxy as any, () => true)).toMatchObject({ kind: 'blocked' })
  expect(traps).toBe(0)
  const reserved = await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, dependencies: transfer.dependencies, targetPreparation: {
    async confirm() { return { kind: 'blocked', reason: 'unavailable' } }, async reconcile() { return { kind: 'blocked', reason: 'unavailable' } }, assertTargetCurrent() {},
  } })
  if (reserved.kind !== 'blocked' || !('manifestDigest' in reserved.token)) throw Error('actual reservation required')
  const phase = { invocation: structuredClone(f.request.invocation), manifestDigest: reserved.token.manifestDigest }
  const confirming = transfer.targetPreparation.confirm(phase, () => true)
  phase.manifestDigest = 'f'.repeat(64)
  expect(await confirming).toEqual({ kind: 'confirmed' })
  const manifest = f.request.seed.records[0]; if (manifest?.type !== 'conversation/seed-manifest') throw Error('fixture manifest')
  const request = { operationId: f.request.invocation.operationId, targetSessionId: 'target', sourceSessionId: 'source', manifestDigest: reserved.token.manifestDigest, artifacts: manifest.artifacts }
  expect((await transfer.dependencies.confirm(request, () => true)).kind).toBe('confirmed')
  expect((await transfer.dependencies.confirm({ ...request, manifestDigest: phase.manifestDigest }, () => true)).kind).toBe('blocked')
})

it.each(['close', 'target-aba', 'source-close'])('blocks %s across actual target publication, with a fresh genuine attempt able to continue exact original work', async action => {
  const f = await fixture(), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
  const pin = join(f.directory(f.member), 'pins', sha('target') + '.json')
  let hit = false
  io.afterLink = async path => { if (path !== pin) return; hit = true; io.afterLink = undefined
    if (action === 'close') transfer.close()
    if (action === 'target-aba') { await f.broker.revoke('p'); await f.broker.configure(f.project) }
    if (action === 'source-close') await f.closeSource()
  }
  const result = await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })
  expect(hit).toBe(true); expect(result.kind).toBe('blocked')
  await expect(f.coordinator.profile('target')).rejects.toThrow()
  const passive = f.runtime.prepareBootstrapTransfer(f.capture(), undefined)
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...passive })).kind).toBe('blocked')
  if (action !== 'source-close') {
    const fresh = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
    expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...fresh })).kind).toBe('ready')
    expect(await f.runtime.contextOutput.readExecResult({ sessionId: 'target' }, { ref: f.member, viaCatalog: f.catalog })).toMatchObject({ frames: [{ data: 'eA==' }] })
  }
})

it('recovers original publication after a landed-write lost response and preserves original artifact bytes', async () => {
  const f = await fixture(), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
  const inventory = async () => {
    const files: Record<string, string> = {}
    for (const ref of [f.text, f.member, f.catalog]) for (const item of await readdir(f.directory(ref), { withFileTypes: true })) if (item.isFile()) files[ref.id + '/' + item.name] = sha((await readFile(join(f.directory(ref), item.name))).toString('base64'))
    return files
  }
  const before = await inventory(), access = join(f.directory(f.member), 'access', sha('target') + '.json')
  let hit = false
  io.afterLink = async path => { if (path === access) { hit = true; io.afterLink = undefined; throw Error('landed publication response lost') } }
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })).kind).toBe('blocked'); expect(hit).toBe(true)
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })).kind).toBe('ready')
  expect(await inventory()).toEqual(before)
})

it.each(['revoke', 'aba'])('denies %s during an actual READY body read', async action => {
  const f = await fixture(), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })).kind).toBe('ready')
  let hit = false
  io.afterRead = async path => { if (path !== join(f.directory(f.text), 'body')) return; hit = true; io.afterRead = undefined; await f.broker.revoke('p'); if (action === 'aba') await f.broker.configure(f.project) }
  await expect(f.runtime.contextOutput.readResult({ sessionId: 'target' }, { ref: f.text })).rejects.toThrow()
  expect(hit).toBe(true)
})

it('keeps target pins and passive authority after real source document deletion releases original pins', async () => {
  const f = await fixture(), transfer = f.runtime.prepareBootstrapTransfer(f.capture(), { sessionId: 'source' })
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() {}, ...transfer })).kind).toBe('ready')
  await f.coordinator.closeManagedDocument('source'); await f.coordinator.deleteOwnedSession!('source', { documents: [] })
  await expect(readFile(join(f.directory(f.member), 'pins', sha('source') + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.directory(f.member), 'pins', sha('target') + '.json'), 'utf8')).toContain('transfer-op')
  const calls = f.sourceCalls()
  expect((await f.coordinator.bootstrapSemanticTarget(f.request, { assertCurrent() { throw Error('passive action') }, ...transfer })).kind).toBe('already-ready')
  expect(f.sourceCalls()).toBe(calls)
  expect(await f.runtime.contextOutput.readResult({ sessionId: 'target' }, { ref: f.text })).toMatchObject({ data: { text: 'retained conversation text' } })
})
