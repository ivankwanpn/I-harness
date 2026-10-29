import { mkdtemp, mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createJsonlSessionCoordinator } from '@i-harness/session-persistence-jsonl'
import type { ResultDependency } from '@i-harness/core-session'
import { acquireAssemblyResultStore, acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import { readManagedResultPage } from '@i-harness/context-output'
import { createResultPageReader } from '../src/service/result-reader.ts'
import { lookupProcessReadContext } from '@i-harness/session-persistence/internal/process-read-context'
import { createSessionService } from '../src/service.ts'

const trace = vi.hoisted(() => ({ path: '', active: false, reads: [] as { length: number; position: number; bytes: number }[], fullReads: 0, builds: 0, decodes: 0, snapshots: 0, afterRelease: undefined as (() => void) | undefined, afterRead: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('../../session-persistence/src/coordinator-factory.ts', async original => {
  const real = await original<typeof import('../../session-persistence/src/coordinator-factory.ts')>()
  return { ...real, createSessionCoordinatorCore(...args: Parameters<typeof real.createSessionCoordinatorCore>) {
    const coordinator = real.createSessionCoordinatorCore(...args), snapshot = coordinator.snapshot!
    coordinator.snapshot = (...input) => { if (trace.active) trace.snapshots++; return Reflect.apply(snapshot, coordinator, input) }
    return coordinator
  } }
})
vi.mock('../src/lifecycle/result-store.ts', async original => {
  const real = await original<typeof import('../src/lifecycle/result-store.ts')>()
  return { ...real, async acquireResultReadStore(...args: Parameters<typeof real.acquireResultReadStore>) {
    const lease = await real.acquireResultReadStore(...args)
    return { ...lease, async release() { await lease.release(); trace.afterRelease?.() } }
  } }
})
vi.mock('@i-harness/core-session', async original => {
  const real = await original<typeof import('@i-harness/core-session')>()
  return { ...real, readFactJournal(...args: Parameters<typeof real.readFactJournal>) { if (trace.active) trace.decodes++; return real.readFactJournal(...args) } }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => { if (trace.active && String(args[0]) === trace.path) trace.fullReads++; return fs.readFile(...args) }, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), read = handle.read.bind(handle)
    handle.read = (async (...input: [Buffer, number, number, number]) => { const result = await read(...input); if (trace.active && String(args[0]) === trace.path) trace.reads.push({ length: input[2], position: input[3], bytes: result.bytesRead }); await trace.afterRead?.(String(args[0])); return result }) as typeof handle.read
    return handle
  } }
})
vi.mock('../../session-persistence/src/coordinator/process-read-visibility.ts', async original => {
  const real = await original<typeof import('../../session-persistence/src/coordinator/process-read-visibility.ts')>()
  return { ...real, createProcessReadVisibility() { if (trace.active) trace.builds++; return real.createProcessReadVisibility() } }
})

it('reads a genuine catalog member repeatedly in an original cold process scope without snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-real-bridge-')), sessionRoot = join(root, 'sessions'), settings = join(root, 'settings.json')
  await mkdir(sessionRoot); await writeFile(settings, '{}')
  const coordinator = createJsonlSessionCoordinator(sessionRoot, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 's' })
  const options = { workspace: root, coordinator, contextOutputSettingsPath: settings, sessionId: 's' }
  const producer = await acquireAssemblyResultStore(options), output = producer.service!, source = await producer.sourceFor!('s')
  const owner = { operationId: 'member', sessionId: 's', callId: 'member', source }
  const memberSink = await output.beginResult(output.registerResultScope(owner, () => true), 'exec-frames-v1')
  await memberSink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'))
  const member = await memberSink.finish('complete'); if (member.kind !== 'committed') throw new Error('member refused')
  const entries: ResultDependency[] = [{ kind: 'exec-frames', sourceId: 'native', retention: { kind: 'artifact', ref: member.ref } }]
  const catalogScope = output.registerResultDependencyScope({ ...owner, operationId: 'catalog', callId: 'catalog' }, () => true, entries)
  const sink = await output.beginResult(catalogScope, 'json-utf8-v1'); await sink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
  const catalog = await sink.finish('complete'); if (catalog.kind !== 'committed') throw new Error('catalog refused')
  expect(await output.settleResultDependencyMembership(catalogScope, catalog.ref)).toBe('ready')
  await coordinator.append('s', [{ type: 'tool/call', callId: 'c', name: 'read', args: {} }, { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'unavailable', reason: 'quota', observedEncodedBytes: 0 }, dependencies: { kind: 'artifact-set', ref: catalog.ref, count: 1 } } }])
  const getter = () => ({ revision: 'one' })
  const service = createSessionService({ ...options, resultReadScopeFor: async () => getter })
  try {
    trace.path = join(sessionRoot, 's.jsonl'); const historyBytes = (await stat(trace.path)).size; trace.reads = []; trace.fullReads = 0; trace.builds = 0; trace.decodes = 0; trace.active = true
    const result = await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async observation => {
      for (let n = 0; n < 3; n++) {
        const page = await service.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })
        expect(page).toMatchObject({ frames: [{ data: 'eA==' }] }); await observation.check()
      }
      return 'candidate'
    }, async (candidate, observation) => { observation.assertCurrent(); return candidate })
    trace.active = false
    expect(result).toBe('candidate'); expect(trace.fullReads).toBe(0); expect(trace.snapshots).toBe(0)
    expect(trace.builds).toBe(1); expect(trace.decodes).toBe(1)
    expect(trace.reads.filter(read => read.position === 0 && read.length === historyBytes + 1 && read.bytes === historyBytes)).toHaveLength(2)
    console.log(JSON.stringify({ control: 'standalone-process-cost', pages: 3, historyBytes, witnessBytePasses: 2, journalDecodes: trace.decodes, visibilityBuilds: trace.builds, profileReads: trace.reads.filter(read => read.length === 65536).length, profileBytes: trace.reads.filter(read => read.length === 65536).reduce((sum, read) => sum + read.bytes, 0), fullReadFileCalls: trace.fullReads, catalogAndPinIO: 'actual, not counted by this probe' }))
    let publishBodies = 0
    trace.reads = []; trace.active = true
    trace.afterRead = async path => { if (path.endsWith('body')) publishBodies++ }
    try {
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => 'cached', async (value, o) => {
        o.assertCurrent(); expect(lookupProcessReadContext(coordinator, 's')!.containsVisibleResult(catalog.ref)).toBe(true)
        expect(await service.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return value
      })).rejects.toThrow()
      expect(publishBodies).toBe(0)
      expect(trace.reads.filter(read => read.position === 0 && read.length === historyBytes + 1 && read.bytes === historyBytes)).toHaveLength(2)
    } finally { trace.afterRead = undefined; trace.active = false }
    const foreignCoordinator = createJsonlSessionCoordinator(sessionRoot, { lock: { enabled: true } })
    const a = await acquireResultReadStore({ ...options, readCallerAvailable: () => true }, getter)
    const b = await acquireResultReadStore({ ...options, coordinator: foreignCoordinator, readCallerAvailable: () => true }, () => ({ revision: 'foreign', scope: { id: 'foreign', roots: [root] } }))
    try {
      await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
        if (typeof a.withProcessReadContext !== 'function') throw new Error('No genuine page lease')
        const page = await a.withProcessReadContext(() => readManagedResultPage(a.service!, { sessionId: 's' }, { ref: member.ref, viaCatalog: catalog.ref }))
        expect(page).toMatchObject({ frames: [{ data: 'eA==' }] }); return 'own-registration'
      }, async value => value)
      let releasedDuringSource = false, published = false
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
        trace.afterRead = async path => { if (path === trace.path) { trace.afterRead = undefined; releasedDuringSource = true; await a.release() } }
        try { await a.withProcessReadContext!(() => readManagedResultPage(a.service!, { sessionId: 's' }, { ref: member.ref, viaCatalog: catalog.ref })) } catch {}
        return 'cached'
      }, async value => { published = true; return value })).rejects.toThrow()
      expect(releasedDuringSource).toBe(true); expect(published).toBe(false)
    } finally { trace.afterRead = undefined; await b.release(); await a.release(); await foreignCoordinator.close() }
    let available = true
    const finalReader = createResultPageReader({ ...options, resultReadScopeFor: async () => getter }, () => available)
    try {
      trace.afterRelease = () => { available = false }
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
        expect(await finalReader.read('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'cached'
      }, async () => { throw new Error('PUBLISHED_CACHED') })).rejects.not.toThrow('PUBLISHED_CACHED')
    } finally { trace.afterRelease = undefined; await finalReader.join() }
    for (const mode of ['scope', 'resolver', 'profile', 'release-failure'] as const) {
      let revision = 'one', currentGetter = () => ({ revision })
      const heldGetter = currentGetter
      const final = createResultPageReader({ ...options, resultReadScopeFor: async () => currentGetter }, () => true)
      let published = false
      try {
        trace.afterRelease = () => {
          if (mode === 'scope') revision = 'two'
          else if (mode === 'resolver') currentGetter = () => ({ revision: 'one' })
          else if (mode === 'profile') trace.afterRead = async path => { if (path === trace.path) { trace.afterRead = undefined; throw new Error('Original profile final read failed') } }
          else throw new Error('Original lease final cleanup failed')
        }
        await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
          expect(await final.read('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'cached'
        }, async value => { published = true; return value })).rejects.toThrow()
        expect(published).toBe(false)
      } finally { trace.afterRelease = undefined; trace.afterRead = undefined; currentGetter = heldGetter; await final.join() }
    }
    let restoredPin: { path: string; bytes: Buffer } | undefined
    try {
      trace.afterRead = async path => {
        if (!path.includes(member.ref.id) || !path.endsWith('body')) return
        trace.afterRead = undefined
        const pin = join(dirname(path), 'pins', createHash('sha256').update('s').digest('hex') + '.json')
        restoredPin = { path: pin, bytes: await readFile(pin) }; await rm(pin)
      }
      let published = false
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
        expect(await service.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'cached'
      }, async value => { published = true; return value })).rejects.toThrow()
      expect(restoredPin).toBeDefined(); expect(published).toBe(false)
    } finally { trace.afterRead = undefined; if (restoredPin) await writeFile(restoredPin.path, restoredPin.bytes) }
    const unlistedSink = await output.beginResult(output.registerResultScope({ ...owner, operationId: 'unlisted', callId: 'unlisted' }, () => true), 'exec-frames-v1')
    await unlistedSink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eQ=="}\n'))
    const unlisted = await unlistedSink.finish('complete'); if (unlisted.kind !== 'committed') throw new Error('unlisted fixture refused')
    let memberPublished = false
    await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
      expect(await service.readResultPage!('s', { ref: unlisted.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'cached'
    }, async value => { memberPublished = true; return value })).rejects.toThrow()
    expect(memberPublished).toBe(false)
    const foreign = { ...member.ref, id: `ctxv1_${'f'.repeat(64)}` }
    await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
      expect(await service.readResultPage!('s', { ref: foreign, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' })
      return 'discard'
    }, async value => value)).rejects.toThrow()
    const missingResolver = createSessionService(options)
    try {
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => {
        expect(await missingResolver.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return 'discard'
      }, async value => value)).rejects.toThrow()
    } finally { await missingResolver.close() }
    const managed = await coordinator.openManagedDocument('s')
    trace.reads = []; trace.builds = 0; trace.decodes = 0; trace.snapshots = 0; trace.active = true
    await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async o => {
      expect(await service.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ frames: [{ data: 'eA==' }] }); await o.check(); return 'managed'
    }, async (value, o) => { o.assertCurrent(); return value })
    trace.active = false
    expect(trace.builds).toBe(1); expect(trace.decodes).toBe(0); expect(trace.snapshots).toBe(0)
    expect(trace.reads.filter(read => read.position === 0 && read.length === historyBytes + 1)).toHaveLength(0)
    await coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async o => {
      await o.check()
      expect((await managed.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
      return 'managed-suffix'
    }, async (value, o, last) => { expect(last.kind).toBe('suffix'); o.assertCurrent(); expect(lookupProcessReadContext(coordinator, 's')!.containsVisibleResult(catalog.ref)).toBe(true); return value })
    publishBodies = 0; trace.afterRead = async path => { if (path.endsWith('body')) publishBodies++ }
    try {
      await expect(coordinator.withProcessReadObservation!('s', { documentKeys: [] }, async () => 'cached', async value => {
        expect(await service.readResultPage!('s', { ref: member.ref, viaCatalog: catalog.ref })).toMatchObject({ kind: 'unavailable' }); return value
      })).rejects.toThrow()
      expect(publishBodies).toBe(0)
    } finally { trace.afterRead = undefined }
  } finally { trace.active = false; await service.close(); await producer.release(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
