import { expect, it, vi } from 'vitest'
const observerCuts = vi.hoisted(() => ({ afterVerifiedRead: undefined as undefined | (() => Promise<void>), afterRemove: undefined as undefined | ((path: string) => Promise<void>) }))
vi.mock('../../context-output/src/artifact/reader.ts', async original => {
  const native = await original<typeof import('../../context-output/src/artifact/reader.ts')>()
  return { ...native, readVerifiedArtifactBytes: async (...args: Parameters<typeof native.readVerifiedArtifactBytes>) => {
    const value = await native.readVerifiedArtifactBytes(...args); await observerCuts.afterVerifiedRead?.(); return value
  } }
})
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native, rm: async (...args: Parameters<typeof native.rm>) => { const value = await native.rm(...args); await observerCuts.afterRemove?.(String(args[0])); return value } }
})
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { BackgroundJobView, ExecService } from '@i-harness/exec'
import type { ManagedArtifactRef } from '@i-harness/core-session'

// Install task-owned settings before importing any runtime owner.
const evidence = resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? resolve(import.meta.dirname, '../../../.tmp/context-r4a-native-dependencies-20261021-implementation'))
if (existsSync(resolve(evidence, 'evidence-seal.json'))) throw new Error('Native dependency evidence root is sealed; set IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT to a fresh task-owned root')
await mkdir(evidence, { recursive: true })
const settingsRoot = resolve(evidence, 'config')
await mkdir(settingsRoot, { recursive: true })
process.env.IH_CONFIG_DIR = settingsRoot
const { createSessionCoordinator } = await import('@i-harness/session-persistence')
const { createJsonlBackend } = await import('@i-harness/session-persistence-jsonl')
const { contextWorkspaceLocation } = await import('@i-harness/context-output')
const { createSessionAssembly } = await import('../src/assembly.ts')
const { createSessionService } = await import('../src/service.ts')
const { acquireResultReadStore } = await import('../src/lifecycle/result-store.ts')
const { acquireAssemblyResultStore } = await import('../src/lifecycle/result-store.ts')
const { controlledModel } = await import('./controlled-model.ts')
const { currentToolResultProducer } = await import('@i-harness/core-tools')
const { committedFactSeqs } = await import('@i-harness/core-session')
const { sessionArtifactManifest } = await import('../../desktop-gateway/src/session-artifacts.ts')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

it('makes an actual child native frame readable to its genuine parent job_output observer', async () => {
  const root = await mkdtemp(resolve(evidence, 'observer-'))
  const settings = resolve(root, 'settings.json'), release = resolve(root, 'release')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: false, maxDiskBytes: 16777216 } } }))
  const worker = resolve(root, 'worker.mjs')
  await writeFile(worker, `import {existsSync} from 'node:fs';process.stdout.write(Buffer.alloc(40000,97));while(!existsSync(process.argv[2]))await new Promise(r=>setTimeout(r,10));process.stderr.write('child-end');`)
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let sends = 0, launches = 0, exec!: ExecService, jobId = '', childId = '', siblingId = '', siblingDenied = false
  let frameRef: ManagedArtifactRef | undefined, catalogRef: ManagedArtifactRef | undefined
  const model = controlledModel(async function* () {
    const n = ++sends
    if (n === 1) yield { type: 'tool_call', call: { id: 'spawn-native', name: 'spawn_agent', args: { task_name: 'native', agent_type: 'native-worker', message: 'launch', fork_turns: 'none', background: false } } }
    else if (n === 2) yield { type: 'tool_call', call: { id: 'child-launch', name: 'native_child', args: {} } }
    else if (n === 5) yield { type: 'tool_call', call: { id: 'parent-discover-running', name: 'job_list', args: {} } }
    else if (n === 7) yield { type: 'tool_call', call: { id: 'parent-observe-terminal', name: 'job_output', args: { job_id: jobId } } }
    else if (n === 9) yield { type: 'tool_call', call: { id: 'actual-member-read', name: 'context_output_read', args: { ref: frameRef, viaCatalog: catalogRef, maxBytes: 4096 } } }
    else if (n === 11) yield { type: 'tool_call', call: { id: 'spawn-sibling', name: 'spawn_agent', args: { task_name: 'sibling', agent_type: 'sibling-worker', message: 'inspect', fork_turns: 'none', background: false } } }
    else if (n === 12) yield { type: 'tool_call', call: { id: 'sibling-probe', name: 'sibling_probe', args: {} } }
    else if (n === 15) yield { type: 'tool_call', call: { id: 'parent-observe-second', name: 'job_output', args: { job_id: jobId } } }
    else yield { type: 'text/chunk', text: 'done' }
    yield { type: 'end' }
  })
  const assembly = await createSessionAssembly({ sessionId: id, coordinator, workspace: root, contextOutputSettingsPath: settings,
    model, modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access',
    additionalTools: [{ name: 'native_child', description: 'controlled native job', inputSchema: {}, async execute() {
      launches++
      const result = await exec.runBackground({ argv: [process.execPath, worker, release] })
      jobId = result.jobId
      childId = exec.getOutput(jobId).receipt!.owner.sessionId
      return result
    } }, { name: 'sibling_probe', description: 'actual sibling denial', inputSchema: {}, async execute() {
      siblingId = currentToolResultProducer()!.sessionId!
      try { exec.getOutput(jobId) } catch (cause) { siblingDenied = /unknown job/i.test(String(cause)) }
      return { denied: siblingDenied }
    } }], pluginAgents: [{ name: 'native-worker', description: 'controlled worker', systemPrompt: 'launch once', tools: ['native_child'] }, { name: 'sibling-worker', description: 'sibling', systemPrompt: 'inspect once', tools: ['sibling_probe'] }] })
  exec = assembly.ctx.services.get<ExecService>('exec/service')!
  const lease = await acquireResultReadStore({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settings, readCallerAvailable: () => true })
  const reader = createSessionService({ workspace: root, coordinator, contextOutputSettingsPath: settings, modelPolicy: 'test-mock' })
  const receipt: Record<string, unknown> = { root, parent: id }
  let retired = false, freshCoordinator: ReturnType<typeof createSessionCoordinator> | undefined
  let freshLease: Awaited<ReturnType<typeof acquireResultReadStore>> | undefined, freshReader: ReturnType<typeof createSessionService> | undefined
  let secondReleased = false
  let membershipSpy: { mockRestore(): void } | undefined
  try {
    await assembly.agent.run('launch an actual durable child')
    expect(childId).not.toBe(id)
    expect((await coordinator.profile(childId)).meta).toMatchObject({ parentSession: id, origin: 'subagent' })
    await assembly.agent.run('discover the running native job')
    const discovery = assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'parent-discover-running')
    expect(discovery).toMatchObject({ envelope: { retention: { kind: 'inline', value: { jobs: expect.arrayContaining([expect.objectContaining({ id: jobId, kind: 'bash', status: 'running' })]) } } } })
    expect(discovery?.type === 'tool/result' ? discovery.envelope?.dependencies : undefined).toBeUndefined()
    const completed = new Promise<BackgroundJobView>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('owned native completion timeout')), 30000)
      const stop = exec.subscribeJob(jobId, view => { if (view.status !== 'running') { clearTimeout(timer); stop(); done(view) } })
    })
    await writeFile(release, '')
    const terminal = await completed
    expect(terminal.status).toBe('completed'); expect(terminal.exitCode).toBe(0)
    if (terminal.retained?.retention.kind !== 'artifact') throw new Error('native frame did not settle: ' + JSON.stringify(terminal))
    const frame = terminal.retained.retention.ref
    frameRef = frame
    await assembly.agent.run('read completed child output')
    const result = assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'parent-observe-terminal')
    if (result?.type !== 'tool/result' || result.envelope?.dependencies?.kind !== 'artifact-set') throw new Error('missing genuine parent catalog: ' + JSON.stringify(result))
    expect(result.envelope.dependencies.count).toBe(1)
    catalogRef = result.envelope.dependencies.ref
    const catalogPage = await lease.service!.readResult({ sessionId: id }, { ref: result.envelope.dependencies.ref })
    const catalog = JSON.parse(catalogPage.data.kind === 'text' ? catalogPage.data.text : Buffer.from(catalogPage.data.base64, 'base64').toString())
    expect(catalog.entries).toEqual([terminal.retained])
    const location = await contextWorkspaceLocation(root, coordinator.storageRoot!)
    const managed = resolve(location.serviceRoot, 'context-output', sha(location.workspaceKey), 'managed-v1', frame.id)
    const targetPin = JSON.parse(await readFile(resolve(managed, 'pins', sha(id) + '.json'), 'utf8'))
    expect(targetPin).toMatchObject({ sessionId: id, documentId: id, revision: frame.revision })
    const operation = JSON.parse(await readFile(resolve(managed, 'operation.json'), 'utf8'))
    expect(operation).toMatchObject({ phase: 'committed', owner: { sessionId: childId }, ref: frame })
    const originSource = await lease.sourceFor!(childId), targetSource = await lease.sourceFor!(id)
    expect(originSource?.sourceId).toBe(targetSource?.sourceId)
    // Actual source owner can read independently of the target visibility
    // decision. This distinguishes missing storage from a denied parent.
    const originPage = await reader.readResultPage!(childId, { ref: frame, maxBytes: 4096 })
    expect(originPage).not.toHaveProperty('kind', 'unavailable')
    const barePage = await reader.readResultPage!(id, { ref: frame, maxBytes: 4096 })
    expect(barePage).toMatchObject({ kind: 'unavailable', reason: 'unauthorized' })
    // Root's approved new contract deliberately requires the original catalog
    // selector; it does not turn the old bare member query into authority.
    const page = await reader.readResultPage!(id, { ref: frame, viaCatalog: result.envelope.dependencies.ref, maxBytes: 4096 })
    Object.assign(receipt, { childId, jobId, launches, nativeExit: terminal.exitCode, frame, catalog: result.envelope.dependencies, targetPin, operation, originSource, targetSource, originPage, barePage, page, parentResult: result })
    await writeFile(resolve(root, 'observer-receipt.json'), JSON.stringify(receipt, null, 2))
    expect(page, 'The genuine parent must read its original child frame through the exact original viaCatalog selector').not.toHaveProperty('kind', 'unavailable')
    async function typedBytes(service: ReturnType<typeof createSessionService>, witness: ManagedArtifactRef) {
      const stdout: Buffer[] = [], stderr: Buffer[] = []; let cursor: { recordOffset: number; sliceOffset: number } | undefined
      for (;;) {
        const current = await service.readResultPage!(id, { ref: frame, viaCatalog: witness, maxBytes: 4096, cursor })
        if ('kind' in current || !('frames' in current)) throw new Error('Original witnessed frame page denied: ' + JSON.stringify(current))
        expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThanOrEqual(4096)
        for (const part of current.frames) (part.channel === 'stdout' ? stdout : stderr).push(Buffer.from(part.data, 'base64'))
        if (current.eof) break
        expect(current.nextCursor).not.toEqual(cursor); cursor = current.nextCursor!
      }
      expect(Buffer.concat(stdout)).toEqual(Buffer.alloc(40000, 97)); expect(Buffer.concat(stderr).toString()).toBe('child-end')
    }
    await typedBytes(reader, catalogRef)
    let archiveDuringRead = false
    observerCuts.afterVerifiedRead = async () => {
      observerCuts.afterVerifiedRead = undefined; archiveDuringRead = true
      await coordinator.updateMeta(id, { archived: true })
    }
    expect(await reader.readResultPage!(id, { ref: frame, viaCatalog: catalogRef, maxBytes: 4096 })).toMatchObject({ kind: 'unavailable', reason: 'unauthorized' })
    expect(archiveDuringRead).toBe(true)
    await coordinator.updateMeta(id, { archived: false })
    await typedBytes(reader, catalogRef)
    const rawParts: Buffer[] = []; let rawOffset = 0
    for (;;) {
      const raw = await lease.service!.readResult({ sessionId: id }, { ref: frame, viaCatalog: catalogRef, offset: rawOffset, maxBytes: 4096 })
      rawParts.push(raw.data.kind === 'text' ? Buffer.from(raw.data.text) : Buffer.from(raw.data.base64, 'base64'))
      if (raw.eof) break
      expect(raw.nextOffset).toBeGreaterThan(rawOffset); rawOffset = raw.nextOffset!
    }
    const rawBody = Buffer.concat(rawParts)
    expect(createHash('sha256').update(rawBody).digest('hex')).toBe(frame.contentDigest)
    expect(rawBody.subarray(0, 9).toString()).toBe('IHEXEC01\n')
    const changedScope = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: id, contextOutputSettingsPath: settings, projectContext: () => ({ id: 'changed-current-project', roots: [root] }) })
    try { expect(await reader.readResultPage!(id, { ref: frame, viaCatalog: catalogRef })).toMatchObject({ kind: 'unavailable', reason: 'unauthorized' }) }
    finally { await changedScope.release() }
    await typedBytes(reader, catalogRef)
    for (const bad of [{ ...catalogRef, revision: '0'.repeat(64) }, { ...catalogRef, contentDigest: '0'.repeat(64) }]) expect(await reader.readResultPage!(id, { ref: frame, viaCatalog: bad })).toMatchObject({ kind: 'unavailable' })
    assembly.tools.promote(['context_output_read'])
    await assembly.agent.run('page the original child with its original catalog')
    const toolRead = assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'actual-member-read')
    expect(toolRead).toMatchObject({ envelope: { retention: { kind: 'inline', value: { ref: frame, frames: expect.any(Array), eof: false } } } })
    await assembly.agent.run('verify an actual sibling cannot observe the native job')
    expect(siblingDenied).toBe(true); expect(siblingId).not.toBe(childId)
    expect(await reader.readResultPage!(siblingId, { ref: frame, viaCatalog: catalogRef })).toMatchObject({ kind: 'unavailable' })
    // A later genuine observer has its own immutable witness. Its unknown
    // acknowledgement cannot replace or revoke the already visible first one.
    const settleMembership = lease.service!.settleResultDependencyMembership.bind(lease.service!)
    let secondCatalog: ManagedArtifactRef | undefined, secondScope: string | undefined, secondAttempts = 0
    membershipSpy = vi.spyOn(lease.service!, 'settleResultDependencyMembership').mockImplementation(async (scope, ref) => {
      const saved = await settleMembership(scope, ref)
      if (ref.id !== catalogRef!.id) {
        secondAttempts++; secondCatalog ??= ref; secondScope ??= scope.operationId
        expect(scope.operationId).toBe(secondScope)
        if (!secondReleased) throw new Error('original second membership acknowledgement unavailable')
      }
      return saved
    })
    await expect(assembly.agent.run('observe the same completed frame again')).rejects.toBeDefined()
    expect(secondAttempts).toBeGreaterThan(0); expect(secondCatalog).toBeDefined()
    expect(assembly.session.events.some(e => e.type === 'tool/result' && e.callId === 'parent-observe-second')).toBe(false)
    await typedBytes(reader, catalogRef)
    expect(await reader.readResultPage!(id, { ref: frame, viaCatalog: secondCatalog! })).toMatchObject({ kind: 'unavailable' })
    secondReleased = true
    await (await coordinator.openManagedDocument(id)).close()
    membershipSpy?.mockRestore(); membershipSpy = undefined
    const secondResult = assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'parent-observe-second')
    expect(secondResult).toMatchObject({ envelope: { dependencies: { kind: 'artifact-set', count: 1, ref: secondCatalog } } })
    await typedBytes(reader, catalogRef); await typedBytes(reader, secondCatalog!)
    const companions = resolve(managed, 'pin-memberships', sha(id))
    expect(await readdir(companions)).toHaveLength(2)
    // Retire every original registration before constructing the cold owner.
    const originalService = lease.service
    await reader.close(); await assembly.dispose(); await lease.release(); await coordinator.close(); retired = true
    freshCoordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
    freshLease = await acquireResultReadStore({ workspace: root, coordinator: freshCoordinator, sessionId: id, contextOutputSettingsPath: settings, readCallerAvailable: () => true })
    expect(freshLease.service).not.toBe(originalService)
    freshReader = createSessionService({ workspace: root, coordinator: freshCoordinator, contextOutputSettingsPath: settings, modelPolicy: 'test-mock' })
    await typedBytes(freshReader, catalogRef); await typedBytes(freshReader, secondCatalog!)
    // Actual transport composition: Desktop main -> SDK client -> Gateway
    // server -> original cold result store, with explicit advertised v2.
    const { PassThrough } = await import('node:stream')
    const { createDesktopHost } = await import('../../desktop-gateway/src/host.ts')
    const { HarnessClient, encodeFrame } = await import('../../sdk/src/index.ts')
    const { dispatchResultReadRequest } = await import('../../desktop/src/main/result-pages.ts')
    const input = new PassThrough(), replies = new PassThrough()
    const host = await createDesktopHost({ workspace: root, sessionDir: resolve(root, 'sessions'), settingsPath: settings, onWrite: message => replies.write(encodeFrame(message) + '\n') })
    input.on('data', line => { void host.handleLine(String(line).trim()) })
    const client = new HarnessClient(replies, input)
    try {
      const info = await client.initialize()
      expect(info.capabilities['session-result-read']).toEqual(['1', '2'])
      expect(await dispatchResultReadRequest({ kind: 'session/result/read', workspaceId: 'native-observer', sessionId: id, ref: frame, viaCatalog: catalogRef, maxBytes: 4096 }, async () => ({ client, info }) as never)).toMatchObject({ ref: frame, frames: expect.any(Array) })
    } finally { await client.close(); await host.close() }
    // Supported lower child lifecycle, with a genuine fresh storage deletion
    // observer held through acknowledgement. Ordinary Gateway delete rejects
    // subagent origins and is deliberately not claimed here.
    await freshCoordinator.closeManagedDocument(childId)
    const childManifest = await sessionArtifactManifest(resolve(root, 'sessions'), root, childId)
    await freshCoordinator.deleteOwnedSession!(childId, childManifest)
    expect(await readdir(resolve(managed, 'pins'))).toEqual([sha(id) + '.json'])
    await typedBytes(freshReader, catalogRef); await typedBytes(freshReader, secondCatalog!)
    // Publish an actual managed rewind fact through its original source port.
    if (secondResult?.type !== 'tool/result' || secondResult.seq === undefined) throw new Error('Missing actual second result position')
    let rewindDuringRead = false
    observerCuts.afterVerifiedRead = async () => {
      observerCuts.afterVerifiedRead = undefined; rewindDuringRead = true
      const document = await freshCoordinator!.openManagedDocument(id), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
      committedFactSeqs(await source.rewind.capture({ type: 'rewind/point', version: 1, targetTurn: 3, anchorSeq: secondResult.seq!, mode: 'conversation', fileOps: [] }).admit())
      await source.close(); action.finish()
    }
    expect(await freshReader.readResultPage!(id, { ref: frame, viaCatalog: secondCatalog! })).toMatchObject({ kind: 'unavailable', reason: 'unauthorized' })
    expect(rewindDuringRead).toBe(true)
    await typedBytes(freshReader, catalogRef)
    expect(await readdir(companions)).toHaveLength(2)
    await freshCoordinator.updateMeta(id, { archived: true })
    expect(await freshReader.readResultPage!(id, { ref: frame, viaCatalog: catalogRef })).toMatchObject({ kind: 'unavailable' })
    await freshCoordinator.updateMeta(id, { archived: false })
    await typedBytes(freshReader, catalogRef)
    await freshReader.close()
    expect(await freshReader.readResultPage!(id, { ref: frame, viaCatalog: catalogRef })).toMatchObject({ kind: 'unavailable' })
    await freshCoordinator.closeManagedDocument(id)
    const parentManifest = await sessionArtifactManifest(resolve(root, 'sessions'), root, id)
    let deletionInterrupted = false
    observerCuts.afterRemove = async path => {
      if (resolve(path) === resolve(managed, 'pins', sha(id) + '.json') && !deletionInterrupted) { deletionInterrupted = true; throw new Error('controlled original pin deletion acknowledgement unavailable') }
    }
    await expect(freshCoordinator.deleteOwnedSession!(id, parentManifest)).rejects.toThrow(/acknowledgement/)
    expect(deletionInterrupted).toBe(true)
    await expect(readFile(resolve(managed, 'pins', sha(id) + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(companions)).toHaveLength(2)
    observerCuts.afterRemove = undefined
    await freshCoordinator.deleteOwnedSession!(id, parentManifest)
    await expect(readFile(resolve(managed, 'operation.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    Object.assign(receipt, { toolRead, siblingId, siblingDenied, secondCatalog, secondScope, secondAttempts, secondResult, distinctFreshStore: true, childManifest, parentManifest, archiveDuringRead, rewindDuringRead, selectiveRewind: true, deletionInterrupted, targetDeletedFrameAbsent: true })
    await writeFile(resolve(root, 'observer-receipt.json'), JSON.stringify(receipt, null, 2))
    expect(launches).toBe(1)
  } finally {
    observerCuts.afterVerifiedRead = undefined; observerCuts.afterRemove = undefined
    secondReleased = true; membershipSpy?.mockRestore()
    await writeFile(release, '')
    if (!retired) { for (const job of exec.listJobs()) if (job.status === 'running') await exec.killJob(job.id); await reader.close(); await assembly.dispose(); await lease.release(); await coordinator.close() }
    await freshReader?.close(); await freshLease?.release(); await freshCoordinator?.close()
    await writeFile(resolve(root, 'cleanup.json'), JSON.stringify({ allOwnedJobsClosed: true, launches, childId, jobId }))
  }
}, 60000)
