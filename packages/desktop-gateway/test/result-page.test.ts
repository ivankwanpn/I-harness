import { expect, it, vi } from 'vitest'
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
  for (const sessionId of ['parent', 'foreign', 'archived', 'child']) await coordinator.create({ sessionId, ...(sessionId === 'child' ? { origin: 'subagent', parentSession: 'parent' } : {}), ...(sessionId === 'archived' ? { archived: true } : {}) })
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

