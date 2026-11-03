import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, createSession, exportConversationSeed, managedResultRefs, rewindCuts, semanticSeedResultRefs, type ManagedArtifactRef } from '@i-harness/core-session'
import { createSessionCoordinator, compileSemanticSeed } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { acquireAssemblyResultStore } from '../../session-executor/src/lifecycle/result-store.ts'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { createDesktopHost } from '../src/host.ts'
import type { RpcMessage } from '@i-harness/sdk'

async function fixture(native: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-result-read-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const broker = createProjectScopeBroker(coordinator, workspace)
  const project = { id: 'p', name: 'Confirmed', roots: [workspace], primaryRoot: workspace }
  await broker.configure(project); await broker.bind('parent', 'p')
  const runtime = native ? await createNativeContextRuntime({ workspace, storageRoot: join(sessionDir, 'native-context'), coordinator, projectFor: broker.nativeScopeFor, resultReadScopeFor: broker.resultReadScopeFor,
    visibleRefsFor: async id => { const snapshot = (await coordinator.snapshot!(id)).session, cuts = rewindCuts(snapshot); return [...semanticSeedResultRefs(snapshot), ...snapshot.events.flatMap(event => cuts.some(cut => event.seq! >= cut.cutFrom && event.seq! < cut.markerSeq) ? [] : managedResultRefs(event))] } }) : undefined
  const producer = runtime ? undefined : await acquireAssemblyResultStore({ workspace, coordinator, sessionId: 'parent', contextOutputSettingsPath: settingsPath, projectContext: await broker.forSession('parent') })
  const owner = runtime?.contextOutput ?? producer!.service!, sourceFor = runtime?.sourceFor ?? producer!.sourceFor!
  const refs: ManagedArtifactRef[] = [], source = createSession()
  for (const text of ['first semantic bytes', 'second semantic bytes']) {
    const scope = owner.registerResultScope({ operationId: text, sessionId: 'parent', callId: text, source: await sourceFor('parent') }, () => true)
    const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from(text))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture result')
    refs.push(saved.ref)
    append(source, { type: 'turn/start' }); append(source, { type: 'step/start' }); append(source, { type: 'tool/call', callId: text, name: 'read', args: {} }); append(source, { type: 'assistant/message', text: '' })
    append(source, { type: 'tool/result', callId: text, name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: text, media: [], retention: { kind: 'artifact', ref: saved.ref } } }); append(source, { type: 'step/end' }); append(source, { type: 'turn/end' })
  }
  const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw Error('fixture export')
  const seed = compileSemanticSeed(exported)
  // Existing real pin/grant owner prepares the retrieval fixture. This is not
  // qualification of the later semantic transfer adapter or caller cutover.
  let fixtureGranted = false
  const ready = await coordinator.bootstrapSemanticTarget({ invocation: { version: 1, operationId: 'read-fixture', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'parent' }, seed }, {
    assertCurrent() {}, dependencies: { async confirm() { await owner.grant({ sessionId: 'parent' }, refs.map(ref => ref.id), 'target'); fixtureGranted = true; return { kind: 'confirmed', closureDigest: seed.dependencyDigest } }, async reconcile() { if (!fixtureGranted) throw Error('fixture pins not granted'); return { kind: 'confirmed', closureDigest: seed.dependencyDigest } } },
  })
  if (ready.kind !== 'ready') throw Error(`fixture bootstrap ${JSON.stringify(ready)}`)
  await broker.inherit('parent', 'target')
  const execution = vi.fn(() => { throw Error('No execution allowed') })
  const service = createSessionService({ workspace, coordinator, contextOutputSettingsPath: settingsPath, ...(runtime ? { contextOutput: owner } : {}), resultReadScopeFor: broker.resultReadScopeFor, modelBindingFor: execution, projectContextFor: execution })
  return { root, workspace, sessionDir, settingsPath, project, coordinator, broker, producer, runtime, service, refs, execution, document: ready.document,
    async close() { await service.close(); await producer?.release(); await runtime?.close(); await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

it.each([false, true])('reads real ready seed refs after parent runtime close and applies rewind separately from reset (native=%s)', async native => {
  const f = await fixture(native)
  try {
    await f.producer?.release(); await f.coordinator.closeManagedDocument('parent')
    await f.coordinator.updateMeta('parent', { archived: true })
    expect(await f.service.readResultPage!('target', { ref: f.refs[0]! })).toMatchObject({ data: { text: 'first semantic bytes' } })
    const snapshot = (await f.coordinator.snapshot!('target')).session, seq = snapshot.events.length
    await f.document.compaction.commit( [{ type: 'compaction/reset', seq, removedSeqs: [1, 2] }])
    expect(await f.service.readResultPage!('target', { ref: f.refs[1]! })).toMatchObject({ data: { text: 'second semantic bytes' } })
    await f.document.compaction.commit( [{ type: 'rewind/point', version: 1, seq: seq + 1, anchorSeq: 2, targetTurn: 1, mode: 'conversation', fileOps: [] }])
    expect(await f.service.readResultPage!('target', { ref: f.refs[0]! })).toMatchObject({ data: { text: 'first semantic bytes' } })
    expect(await f.service.readResultPage!('target', { ref: f.refs[1]! })).toMatchObject({ kind: 'unavailable' })
    const cold = createProjectScopeBroker(f.coordinator, f.workspace), service = createSessionService({ workspace: f.workspace, coordinator: f.coordinator, ...(f.runtime ? { contextOutput: f.runtime.contextOutput } : {}), resultReadScopeFor: cold.resultReadScopeFor })
    try { expect(await service.readResultPage!('target', { ref: f.refs[0]! })).toMatchObject({ kind: 'unavailable' }) } finally { await service.close(); await cold.close() }
    expect(f.execution).not.toHaveBeenCalled(); expect(f.service.hasAssembly('target')).toBe(false)
  } finally { await f.close() }
})

it('wires real fresh Gateway host semantic visibility and saved binding only after current catalog confirmation', async () => {
  const f = await fixture(true)
  await f.service.close(); await f.runtime!.close(); await f.broker.close(); await f.coordinator.close()
  const frames: RpcMessage[] = [], host = await createDesktopHost({ workspace: f.workspace, sessionDir: f.sessionDir, settingsPath: f.settingsPath, onWrite: frame => frames.push(frame) })
  let id = 0
  const call = async (method: string, params = {}) => { const current = ++id; await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: current, method, params })); return frames.find(frame => 'id' in frame && frame.id === current) as any }
  try {
    await call('initialize')
    expect(await call('session/result/read', { sessionId: 'target', ref: f.refs[0] })).toMatchObject({ result: { kind: 'unavailable' } })
    await call('desktop/project/sync', { projects: [f.project] })
    expect(await call('session/result/read', { sessionId: 'target', ref: f.refs[0] })).toMatchObject({ result: { data: { text: 'first semantic bytes' } } })
  } finally { await host.close(); await f.close() }
}, 20000)
