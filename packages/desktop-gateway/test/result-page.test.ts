import { expect, it, vi } from 'vitest'
import { encodeExecFrameRecord, managedResultRefs } from '@i-harness/core-session'
const io = vi.hoisted(() => ({ enabled: false, reads: 0, entered: undefined as (() => void) | undefined, resume: undefined as Promise<void> | undefined }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0])
    if (io.enabled && /[\\/]managed-v1[\\/].*[\\/](body|index)$/.test(path)) {
      io.reads++; if (io.entered) { const entered = io.entered; io.entered = undefined; entered(); await io.resume }
    }
    return fs.open(...args)
  } }
})
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { acquireAssemblyResultStore } from '../../session-executor/src/lifecycle/result-store.ts'
import { createSdkServer } from '@i-harness/sdk/server'
import { decodeFrame, encodeFrame, makeRequest } from '@i-harness/sdk'
import { createSessionManagementFence } from '../src/session-management-fence.ts'
import { createConversationVisibility } from '../src/session-visibility.ts'
import * as readers from '../src/result-reader.ts'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { createProjectScopeBroker } from '../src/project-scope.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gateway-result-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await mkdir(sessionDir); await writeFile(settingsPath, '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  for (const sessionId of ['parent', 'foreign', 'archived', 'child']) await coordinator.create({ sessionId, ...(sessionId === 'child' ? { origin: 'subagent', parentSession: 'parent', seedLength: 0 } : {}), ...(sessionId === 'archived' ? { archived: true } : {}) })
  const lease = await acquireAssemblyResultStore({ workspace, coordinator, sessionId: 'parent', contextOutputSettingsPath: settingsPath }), owner = lease.service!
  const scope = owner.registerResultScope({ operationId: 'gateway', sessionId: 'parent', callId: 'c', source: await lease.sourceFor!('parent') }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('cold gateway body 🙂'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Original fixture refused')
  await owner.grant({ sessionId: 'parent' }, [saved.ref.id], 'child')
  await lease.release(); await coordinator.close()
  const cold = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  const service = createSessionService({ workspace, coordinator: cold, contextOutputSettingsPath: settingsPath, modelBindingFor: async () => { throw new Error('No execution') } })
  return { root, workspace, sessionDir, settingsPath, coordinator: cold, service, ref: saved.ref, async close() { io.enabled = false; io.entered = undefined; io.resume = undefined; await service.close(); await cold.close(); await rm(root, { recursive: true, force: true }) } }
}

it('guards actual cold SDK pages by conversation visibility independently of committed pins', async () => {
  const f = await fixture(), fence = createSessionManagementFence()
  const read = readers.createConversationResultReader(f.coordinator, f.service, createConversationVisibility(f.coordinator), fence)
  const server = createSdkServer(f.service, { readResultPage: read })
  let id = 0
  const call = async (sessionId: string, ref = f.ref, extra = {}) => decodeFrame((await server.handleLine(encodeFrame(makeRequest(++id, 'session/result/read', { sessionId, ref, ...extra }))))!) as any
  try {
    await server.handleLine(encodeFrame(makeRequest(++id, 'initialize', {})))
    const before = await readFile(join(f.sessionDir, 'parent.jsonl')); io.enabled = true; io.reads = 0
    expect(await call('parent')).toMatchObject({ result: { eof: true, data: { text: 'cold gateway body 🙂' } } }); expect(io.reads).toBeGreaterThan(0)
    io.reads = 0
    for (const session of ['foreign', 'archived', 'child', 'absent']) expect((await call(session)).result).toMatchObject({ kind: 'unavailable' })
    for (const forged of [{ revision: 'a'.repeat(64) }, { codec: 'json-utf8-v1' as const }, { encodedBytes: f.ref.encodedBytes + 1 }, { contentDigest: 'b'.repeat(64) }, { completeness: 'source-limited' as const }]) expect((await call('parent', { ...f.ref, ...forged })).result).toMatchObject({ kind: 'unavailable' })
    expect(await call('parent', f.ref, { maxBytes: 64000 })).toMatchObject({ error: { code: -32602 } })
    expect(io.reads).toBe(0); expect(f.service.hasAssembly('parent')).toBe(false)
    const otherWorkspace = join(f.root, 'other-workspace'); await mkdir(otherWorkspace)
    const foreign = createSessionService({ workspace: otherWorkspace, coordinator: f.coordinator, contextOutputSettingsPath: f.settingsPath })
    try { expect(await foreign.readResultPage!('parent', { ref: f.ref })).toMatchObject({ kind: 'unavailable' }); expect(io.reads).toBe(0) }
    finally { await foreign.close() }
    expect(await readFile(join(f.sessionDir, 'parent.jsonl'))).toEqual(before)
  } finally { await server.close(); await f.close() }
})

it.each(['before', 'during'] as const)('enforces the supplied native original owner current project policy %s verified I/O', async phase => {
  const f = await fixture(), broker = createProjectScopeBroker(f.coordinator, f.workspace)
  await broker.configure({ id: 'p', name: 'Fixture', roots: [f.workspace], primaryRoot: f.workspace }); await broker.bind('parent', 'p')
  const native = await createNativeContextRuntime({ workspace: f.workspace, storageRoot: join(f.sessionDir, 'native-context'), coordinator: f.coordinator, projectFor: broker.nativeScopeFor })
  const owner = native.contextOutput, scope = owner.registerResultScope({ operationId: 'project-body', sessionId: 'parent', callId: 'project', source: await native.sourceFor('parent') }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('confirmed project bytes'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Original project fixture refused')
  const service = createSessionService({ workspace: f.workspace, coordinator: f.coordinator, contextOutput: owner }), fence = createSessionManagementFence()
  const read = readers.createConversationResultReader(f.coordinator, service, createConversationVisibility(f.coordinator), fence)!
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  try {
    io.enabled = true; io.reads = 0
    if (phase === 'before') await broker.revoke('p')
    else { io.entered = entered.resolve; io.resume = resume.promise }
    const pending = read('parent', { ref: saved.ref })
    if (phase === 'during') { await entered.promise; await broker.revoke('p'); resume.resolve() }
    expect(await pending).toMatchObject({ kind: 'unavailable' })
    expect(io.reads === 0).toBe(phase === 'before')
    await broker.configure({ id: 'p', name: 'Restored', roots: [f.workspace], primaryRoot: f.workspace })
    expect(await read('parent', { ref: saved.ref })).toMatchObject({ eof: true, data: { text: 'confirmed project bytes' } })
  } finally { resume.resolve(); io.enabled = false; await service.close(); await native.close(); await broker.close(); await f.close() }
})

it('publishes both ordinary parallel reads while one holds real body I/O', async () => {
  const f = await fixture(), fence = createSessionManagementFence()
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const read = readers.createConversationResultReader(f.coordinator, f.service, createConversationVisibility(f.coordinator), fence)!
  const pending: Promise<unknown>[] = []
  try {
    io.enabled = true; io.entered = entered.resolve; io.resume = resume.promise
    pending.push(read('parent', { ref: f.ref }))
    await entered.promise
    // Both requests are admitted while the first physical read is held. The
    // original store may serialize its own initialization, so do not require
    // the second I/O to finish before releasing the first.
    pending.push(read('parent', { ref: f.ref }))
    await new Promise(resolve => setImmediate(resolve))
    resume.resolve()
    for (const page of await Promise.all(pending)) expect(page).toMatchObject({ eof: true, data: { text: 'cold gateway body 🙂' } })
  } finally { resume.resolve(); await Promise.allSettled(pending); await f.close() }
})

it.each(['archive', 'fence'] as const)('discards an admitted page when %s revokes visibility during real body I/O', async mode => {
  const f = await fixture(), fence = createSessionManagementFence(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const read = readers.createConversationResultReader(f.coordinator, f.service, createConversationVisibility(f.coordinator), fence)!
  let management: Promise<void> | undefined
  try {
    io.enabled = true; io.entered = entered.resolve; io.resume = resume.promise
    const pending = read('parent', { ref: f.ref }); await entered.promise
    let managed = false
    if (mode === 'archive') await f.coordinator.updateMeta('parent', { archived: true })
    else { management = fence.exclusive('parent', async () => { managed = true }); await new Promise(resolve => setImmediate(resolve)); expect(managed).toBe(false) }
    resume.resolve(); expect(await pending).toMatchObject({ kind: 'unavailable' }); await management
    if (mode === 'fence') expect(managed).toBe(true)
  } finally { resume.resolve(); await management; await f.close() }
})

it.each((['text-utf8-v1', 'exec-frames-v1'] as const).flatMap(codec => (['reconfigure', 'ABA', 'withdraw', 'close'] as const).map(mode => ({ codec, mode }))))('discards native $codec bytes after broker $mode during body I/O', async ({ codec, mode }) => {
  const f = await fixture(), broker = createProjectScopeBroker(f.coordinator, f.workspace)
  const project = { id: 'p', name: 'Fixture', roots: [f.workspace], primaryRoot: f.workspace }
  await broker.configure(project); await broker.bind('parent', 'p')
  const native = await createNativeContextRuntime({ workspace: f.workspace, storageRoot: join(f.sessionDir, 'native-revision'), coordinator: f.coordinator, projectFor: broker.nativeScopeFor, resultReadScopeFor: broker.resultReadScopeFor })
  const owner = native.contextOutput, scope = owner.registerResultScope({ operationId: 'revision-body', sessionId: 'parent', callId: 'read', source: await native.sourceFor('parent') }, () => true)
  const sink = await owner.beginResult(scope, codec); await sink.write(Buffer.from(codec === 'text-utf8-v1' ? 'revision protected bytes' : encodeExecFrameRecord({ channel: 'stdout', frame: 0, offset: 0, end: true, data: Buffer.from('revision protected bytes').toString('base64') })))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture')
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  try {
    io.enabled = true; io.entered = entered.resolve; io.resume = resume.promise
    const pending = codec === 'exec-frames-v1' ? owner.readExecResult({ sessionId: 'parent' }, { ref: saved.ref }) : owner.readResult({ sessionId: 'parent' }, { ref: saved.ref }); const outcome = pending.then(value => ({ value }), error => ({ error }))
    await entered.promise
    if (mode === 'reconfigure') await broker.configure(project)
    if (mode === 'ABA') { await broker.revoke('p'); await broker.configure(project) }
    if (mode === 'withdraw') await broker.revoke('p')
    if (mode === 'close') await broker.close()
    resume.resolve()
    expect(await outcome).toHaveProperty('error')
  } finally { resume.resolve(); io.enabled = false; await native.close(); await broker.close(); await f.close() }
})

it.each(['reconfigure', 'ABA', 'target-close'] as const)('discards automatic reader bytes after actual broker or target %s during I/O', async mode => {
  const f = await fixture(), broker = createProjectScopeBroker(f.coordinator, f.workspace)
  const project = { id: 'p', name: 'Fixture', roots: [f.workspace], primaryRoot: f.workspace }
  await broker.configure(project); await broker.bind('parent', 'p')
  const producer = await acquireAssemblyResultStore({ workspace: f.workspace, coordinator: f.coordinator, sessionId: 'parent', contextOutputSettingsPath: f.settingsPath, projectContext: await broker.forSession('parent') })
  const owner = producer.service!, scope = owner.registerResultScope({ operationId: 'auto-revision', sessionId: 'parent', callId: 'read', source: await producer.sourceFor!('parent') }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('automatic revision bytes'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture')
  await producer.release()
  const execution = vi.fn(() => { throw Error('No execution') }), service = createSessionService({ workspace: f.workspace, coordinator: f.coordinator, contextOutputSettingsPath: f.settingsPath, resultReadScopeFor: broker.resultReadScopeFor, modelBindingFor: execution, projectContextFor: execution })
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  let closing: Promise<void> | undefined
  try {
    io.enabled = true; io.entered = entered.resolve; io.resume = resume.promise
    const pending = service.readResultPage!('parent', { ref: saved.ref }); await entered.promise
    if (mode === 'reconfigure') await broker.configure(project)
    if (mode === 'ABA') { await broker.revoke('p'); await broker.configure(project) }
    if (mode === 'target-close') closing = service.closeSession('parent')
    resume.resolve(); expect(await pending).toMatchObject({ kind: 'unavailable' }); await closing
    expect(execution).not.toHaveBeenCalled(); expect(service.hasAssembly('parent')).toBe(false)
  } finally { resume.resolve(); io.enabled = false; await closing; await service.close(); await broker.close(); await f.close() }
})

it('keeps native default lineage dependent on a live ancestor when the target has no own binding', async () => {
  const f = await fixture(), broker = createProjectScopeBroker(f.coordinator, f.workspace)
  await broker.configure({ id: 'p', name: 'Fixture', roots: [f.workspace], primaryRoot: f.workspace }); await broker.bind('parent', 'p')
  const native = await createNativeContextRuntime({ workspace: f.workspace, storageRoot: join(f.sessionDir, 'default-lineage'), coordinator: f.coordinator, projectFor: broker.nativeScopeFor, resultReadScopeFor: broker.resultReadScopeFor, visibleRefsFor: async id => (await f.coordinator.snapshot!(id)).session.events.flatMap(managedResultRefs) })
  const owner = native.contextOutput, scope = owner.registerResultScope({ operationId: 'lineage', sessionId: 'parent', callId: 'read', source: await native.sourceFor('parent') }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('ancestor-owned bytes'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture')
  await owner.grant({ sessionId: 'parent' }, [saved.ref.id], 'child')
  await f.coordinator.append('child', [{ type: 'tool/result', seq: 0, callId: 'read', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'ancestor', media: [], retention: { kind: 'artifact', ref: saved.ref } } }])
  try {
    expect(await broker.resultReadScopeFor('child')).toBeUndefined()
    expect((await owner.readResult({ sessionId: 'child' }, { ref: saved.ref })).data).toEqual({ kind: 'text', text: 'ancestor-owned bytes' })
    await f.coordinator.updateMeta('parent', { archived: true })
    await expect(owner.readResult({ sessionId: 'child' }, { ref: saved.ref })).rejects.toThrow(/archived|unavailable|unauthorized/)
  } finally { await native.close(); await broker.close(); await f.close() }
})
