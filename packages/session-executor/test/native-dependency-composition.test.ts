import { expect, it, vi } from 'vitest'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ResultArtifactScope, ResultArtifactSink } from '@i-harness/context-output'
import type { ResultDependencyCatalog } from '@i-harness/core-session'
import { fixture, rawBytes, currentToolResultProducer, toolResultDependencies, createSessionCoordinator, createJsonlBackend, acquireResultReadStore, createSessionService, sessionArtifactManifest } from './native-dependency-fixture.ts'

it('preserves four original artifacts, exact ordered native bytes and primary data through fresh lifecycle deletion', async () => {
  const f = await fixture('four-artifact')
  const ledger = resolve(f.root, 'native-effects.jsonl')
  let bodies = 0, getters = 0, launches = 0
  const expected = [Buffer.alloc(40000, 97), Buffer.alloc(35000, 98)]
  await f.mount(async () => {
    bodies++; launches++
    const first = await f.exec.run({ argv: [process.execPath, '-e', "require('node:fs').appendFileSync(process.argv[1],'first\\n');process.stdout.write(Buffer.alloc(40000,97));process.exitCode=5", ledger] })
    launches++
    const { jobId } = await f.exec.runBackground({ argv: [process.execPath, '-e', "require('node:fs').appendFileSync(process.argv[1],'second\\n');process.stdout.write(Buffer.alloc(35000,98))", ledger] })
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('native pair completion timeout')), 30000)
      const stop = f.exec.subscribeJob(jobId, view => { if (view.status !== 'running') { clearTimeout(timer); stop(); done() } })
    })
    const second = f.exec.getOutput(jobId), repeated = f.exec.getOutput(jobId)
    expect(second.retained).toEqual(repeated.retained); expect(second.exitCode).toBe(0)
    expect(toolResultDependencies(currentToolResultProducer()!)).toHaveLength(2)
    return { firstExit: first.exitCode, secondExit: second.exitCode, get padding() { getters++; return 'm'.repeat(70000) }, sourceId: 'payload-not-source', dependencies: [{ sourceId: 'fake' }], entries: ['data'], ref: second.retained?.retention }
  })
  let fresh: Awaited<ReturnType<typeof acquireResultReadStore>> | undefined
  let coordinator: ReturnType<typeof createSessionCoordinator> | undefined
  let shipping: ReturnType<typeof createSessionService> | undefined
  try {
    await f.assembly.agent.run('retain both native sources')
    const result = f.assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'composition')
    if (result?.type !== 'tool/result' || result.envelope?.retention.kind !== 'artifact' || result.envelope.dependencies?.kind !== 'artifact-set') throw new Error('Expected complete actual four-artifact composition')
    const primary = result.envelope.retention.ref, catalogRef = result.envelope.dependencies.ref
    expect(primary.encodedBytes).toBeGreaterThan(60000); expect(result.envelope.dependencies.count).toBe(2)
    const catalog = JSON.parse((await rawBytes(f.service, f.id, catalogRef)).toString()) as ResultDependencyCatalog
    const frames = catalog.entries.map(e => { if (e.retention.kind !== 'artifact') throw new Error('Expected two frames'); return e.retention.ref })
    expect(new Set(catalog.entries.map(e => e.sourceId)).size).toBe(2)
    const refs = [primary, catalogRef, ...frames]
    const before = await f.inventory()
    expect(before).toHaveLength(4); expect(before.every(row => row.operation.phase === 'committed' && row.pins.length === 1)).toBe(true)
    expect(new Set(before.map(row => row.operation.id))).toEqual(new Set(refs.map(ref => ref.id)))
    const primaryBody = await rawBytes(f.service, f.id, primary)
    expect(JSON.parse(primaryBody.toString())).toMatchObject({ firstExit: 5, secondExit: 0, padding: 'm'.repeat(70000), sourceId: 'payload-not-source', entries: ['data'], dependencies: [{ sourceId: 'fake' }] })
    const originalBodies = new Map<string, Buffer>([[primary.id, primaryBody], [catalogRef.id, Buffer.from(JSON.stringify(catalog))]])
    for (const [index, ref] of frames.entries()) {
      const bytes = await rawBytes(f.service, f.id, ref); originalBodies.set(ref.id, bytes)
      expect(bytes.subarray(0, 9).toString()).toBe('IHEXEC01\n')
      const records = bytes.subarray(9).toString().trim().split('\n').map(line => JSON.parse(line))
      expect(records.every(record => record.channel === 'stdout')).toBe(true)
      expect(Buffer.concat(records.map(record => Buffer.from(record.data, 'base64')))).toEqual(expected[index])
      expect(ref.completeness).toBe('complete')
    }
    await f.service.clear()
    expect((await f.inventory()).map(row => row.operation.ref)).toEqual(before.map(row => row.operation.ref))
    const originalService = f.service
    await f.retire()
    coordinator = createSessionCoordinator(createJsonlBackend(f.sessions), { lock: { enabled: true } })
    fresh = await acquireResultReadStore({ workspace: f.root, coordinator, sessionId: f.id, contextOutputSettingsPath: f.settings, readCallerAvailable: () => true })
    expect(fresh.service).not.toBe(originalService)
    shipping = createSessionService({ workspace: f.root, coordinator, contextOutputSettingsPath: f.settings, modelPolicy: 'test-mock' })
    await coordinator.updateMeta(f.id, { archived: true })
    for (const ref of refs) await expect(rawBytes(fresh.service!, f.id, ref)).rejects.toThrow(/unauthorized/)
    expect((await f.inventory()).map(row => row.operation.ref)).toEqual(before.map(row => row.operation.ref))
    await coordinator.updateMeta(f.id, { archived: false })
    for (const ref of refs) expect(await rawBytes(fresh.service!, f.id, ref)).toEqual(originalBodies.get(ref.id))
    for (const [index, ref] of frames.entries()) {
      const bytes: Buffer[] = []; let cursor: { recordOffset: number; sliceOffset: number } | undefined
      for (;;) {
        const page = await shipping.readResultPage!(f.id, { ref, cursor, maxBytes: 4096 })
        if ('kind' in page || !('frames' in page)) throw new Error('typed native page failed: ' + JSON.stringify(page))
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
        bytes.push(...page.frames.map(part => Buffer.from(part.data, 'base64')))
        if (page.eof) break
        expect(page.nextCursor).not.toEqual(cursor); cursor = page.nextCursor!
      }
      expect(Buffer.concat(bytes)).toEqual(expected[index])
    }
    const manifest = await sessionArtifactManifest(f.sessions, f.root, f.id)
    await coordinator.deleteOwnedSession!(f.id, manifest)
    expect(await readdir(f.managed)).toEqual([])
    const deletion = await coordinator.deletionReceipt!(f.id)
    expect(deletion?.manifest.documents).toEqual([...manifest.documents].sort())
    expect(deletion?.manifest.files).toEqual([...manifest.files!].sort())
    await writeFile(resolve(f.root, 'lifecycle-receipt.json'), JSON.stringify({ refs, before, manifest, bodies, getters, launches, nativeExits: [5, 0], freshStoreDistinct: true, retainedFreshDeletionObserver: true, finalInventory: await readdir(f.managed) }, null, 2))
    expect({ bodies, getters, launches }).toEqual({ bodies: 1, getters: 1, launches: 2 })
    expect(await readFile(ledger, 'utf8')).toBe('first\nsecond\n')
  } finally { await shipping?.close(); await fresh?.release(); await coordinator?.close(); await f.close() }
}, 60000)

it.each(['calibration', 'source', 'catalog'] as const)('uses original finish acknowledgement at a real finalizer checkpoint: %s', async mode => {
  const f = await fixture('uncertain-' + mode)
  const ledger = resolve(f.root, 'native-effects.jsonl')
  let released = mode === 'calibration', bodies = 0, launches = 0, selected: ResultArtifactScope | undefined, attempts = 0, finalizerEntries = 0
  const registrations: { scope: ResultArtifactScope; codec?: string; bytes: Buffer[] }[] = []
  const register = f.service.registerResultScope.bind(f.service)
  const registrationSpy = vi.spyOn(f.service, 'registerResultScope').mockImplementation((...args) => { const scope = register(...args); registrations.push({ scope, bytes: [] }); return scope })
  const begin = f.service.beginResult.bind(f.service), wrapped = new WeakSet<ResultArtifactSink>()
  const beginSpy = vi.spyOn(f.service, 'beginResult').mockImplementation(async (scope, codec) => {
    const sink = await begin(scope, codec), row = registrations.find(row => row.scope === scope)!
    row.codec = codec
    if (!wrapped.has(sink)) {
      wrapped.add(sink)
      const write = sink.write.bind(sink), finish = sink.finish.bind(sink)
      sink.write = async bytes => { row.bytes.push(Buffer.from(bytes)); await write(bytes) }
      sink.finish = async completeness => {
        const saved = await finish(completeness)
        const body = Buffer.concat(row.bytes).toString()
        const isCatalog = codec === 'json-utf8-v1' && body.startsWith('{"version":1,"kind":"result-dependencies","entries":')
        if (!selected && (mode === 'catalog' ? isCatalog : codec === 'exec-frames-v1')) selected = scope
        if (scope === selected) { attempts++; if (!released) throw new Error('controlled post-original-finish acknowledgement unavailable') }
        return saved
      }
    }
    return sink
  })
  await f.mount(async () => {
    bodies++
    for (let n = 0; n < 2; n++) { launches++; const native = await f.exec.run({ argv: [process.execPath, '-e', `require('node:fs').appendFileSync(process.argv[1],'source-${n}\\n');process.stdout.write('source-${n}')`, ledger] }); expect(native.exitCode).toBe(0) }
    return { label: 'inline uncertainty scheduling control', facts: [0, 0] }
  })
  const finalize = f.assembly.tools.finalize.bind(f.assembly.tools)
  const finalizerSpy = vi.spyOn(f.assembly.tools, 'finalize').mockImplementation(async (...args) => { finalizerEntries++; return finalize(...args) })
  try {
    if (mode === 'calibration') await f.assembly.agent.run('positive native interception')
    else {
      await expect(f.assembly.agent.run('hold original acknowledgement')).rejects.toBeDefined()
      expect(finalizerEntries).toBeGreaterThan(0); expect(attempts).toBeGreaterThan(0)
      expect(f.assembly.session.events.filter(e => e.type === 'tool/result' && e.callId === 'composition')).toHaveLength(0)
      const checkpoint = await f.inventory()
      expect(checkpoint.filter(row => row.operation.codec === 'exec-frames-v1' && row.operation.phase === 'committed')).toHaveLength(2)
      await writeFile(resolve(f.root, 'pending-checkpoint.json'), JSON.stringify({ mode, finalizerEntries, attempts, selected, registrations: registrations.map(row => ({ operationId: row.scope.operationId, codec: row.codec, bytes: Buffer.concat(row.bytes).length })), checkpoint, noF1: true }, null, 2))
      released = true
      const document = await f.coordinator.openManagedDocument(f.id)
      await document.close()
    }
    const result = f.assembly.session.events.find(e => e.type === 'tool/result' && e.callId === 'composition')
    expect(result).toMatchObject({ envelope: { retention: { kind: 'inline' }, dependencies: { kind: 'artifact-set', count: 2 } } })
    expect(registrations.filter(row => row.codec === 'exec-frames-v1')).toHaveLength(2)
    expect(registrations.filter(row => row.codec === 'json-utf8-v1')).toHaveLength(1)
    expect({ bodies, launches }).toEqual({ bodies: 1, launches: 2 })
    expect(await readFile(ledger, 'utf8')).toBe('source-0\nsource-1\n')
    await writeFile(resolve(f.root, 'recovered-receipt.json'), JSON.stringify({ mode, selected, attempts, finalizerEntries, bodies, launches, result, inventory: await f.inventory() }, null, 2))
  } finally { released = true; finalizerSpy.mockRestore(); beginSpy.mockRestore(); registrationSpy.mockRestore(); await f.close() }
}, 60000)
