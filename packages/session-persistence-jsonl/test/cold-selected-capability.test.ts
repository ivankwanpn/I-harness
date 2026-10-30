import { expect, it, vi } from 'vitest'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFactBatch, encodeFactBatch } from '@i-harness/core-session'
import { codecSeed, codecPage, codecRow, sealCodecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { buildSelectedResultsHeader } from '../../session-persistence/src/coordinator/selected-results-header.ts'
import * as selected from '../../session-persistence/src/selected-source-owner.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'

async function fixture() {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'cold-cap-'))
  const exported = codecSeed('public-completed', [codecPage([codecRow()])])
  exported.seed.groups = [{ extent: { kind: 'framed', first: 1, last: 1 }, items: [{ kind: 'summary', scope: 'turn', extent: { kind: 'framed', first: 1, last: 1 }, origins: [{ origin: 0, seq: 1, part: 'message' }], sourceProvenance: [{ origin: 0, kind: 'summary', authority: 'derived', scope: 'turn' }], messages: [{ role: 'user', content: 'summary' }] }] }]
  exported.seed.passive.codeStore.groups = [0]
  const seed = compileSelectedResultsSemanticSeed(sealCodecSeed(exported.seed))
  const core = readSelectedResultsCore({ version: 2, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {}, results: 'selected-results-v1' })
  const { intent, requestDigest } = createSelectedResultsIntent(core, { kind: 'unmanaged' })
  const invocation = { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-31T00:00:00.000Z', requestDigest }
  const request = { invocation, core, requestIntent: intent }, route = { protocol: 'public-results-v1' as const, request }
  const built = buildSelectedResultsHeader({ invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed }, { version: 1, kind: 'semantic-bootstrap-selected-results-capture', request })
  const meta = JSON.parse(built.headerBytes), first = encodeFactBatch('bootstrap:op:seed', meta.journal.legacyPrefixDigest, seed.records)
  const complete = encodeFactBatch('bootstrap:op:complete', decodeFactBatch(first.bytes).prefixDigest, [{ type: 'session/bootstrap', version: 1, seq: seed.records.length, operationId: 'op', manifestDigest: meta.semanticSeed.manifestDigest, dependencyClosureDigest: seed.dependencyDigest, seedLength: seed.records.length }])
  const path = join(root, 'target.jsonl'), raw = Buffer.concat([Buffer.from(built.headerBytes), Buffer.from(first.bytes), Buffer.from(complete.bytes)])
  await writeFile(path, raw)
  await writeFile(selectedBootstrapPaths(path, route).stage, built.stageBytes)
  await writeFile(join(root, 'task-target.doc.jsonl'), JSON.stringify(taskDocumentStorageContract.empty()) + '\n')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  return { root, coordinator, route, raw, path }
}

it('retains the original cold checked target for finite inspection without making it ready', async () => {
  const f = await fixture()
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(result.kind).toBe('qualification-required')
    expect(result).toHaveProperty('target')
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    const changed = { ...f.route, request: { ...f.route.request, invocation: { ...f.route.request.invocation, createdAt: '2026-11-01T00:00:00.000Z' } } }
    expect((await selected.inspectColdSelectedTarget(f.coordinator, changed)).kind).toBe('conflict')
    const again = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(again.kind === 'qualification-required' && again.target).toBe(result.target)
    let original: unknown
    await selected.useColdSelectedTarget(f.coordinator, result.target, async observation => {
      original = observation.document
      expect(observation.document.view).toBe(observation.view)
      expect(observation.view.formatVersion).toBe(14)
      expect(observation.receipt.invocation).toEqual(f.route.request.invocation)
      expect(observation.receipt.seedLength).toBe(observation.facts.seedLength)
      expect(observation.prefix.eventCount).toBe(observation.view.events.length)
      expect(observation.birth.stage.seed.seedLength).toBe(observation.facts.seedLength)
      expect(Object.isFrozen(observation.birth)).toBe(true)
      expect(Object.isFrozen(observation.birth.stage.seed)).toBe(true)
      observation.assertCurrent()
      expect(() => observation.document.assertReady()).toThrow()
    })
    await selected.useColdSelectedTarget(f.coordinator, result.target, async observation => { expect(observation.document).toBe(original) })
    await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow()
    await expect(f.coordinator.withProcessReadObservation!('target', { documentKeys: [] }, async () => true, async value => value)).rejects.toThrow()
    expect(await readFile(f.path)).toEqual(f.raw)
  } finally { await f.coordinator.close() }
})

it('never opens or profiles the absent source through the original coordinator during target use', async () => {
  const f = await fixture()
  const load = f.coordinator.loadOwned.bind(f.coordinator), open = f.coordinator.openManagedDocument.bind(f.coordinator), profile = f.coordinator.profile.bind(f.coordinator)
  let sourceReads = 0
  const guard = (id: string) => { if (id === 'source') { sourceReads++; throw Error('Source must remain absent') } }
  const hooks = [
    vi.spyOn(f.coordinator, 'loadOwned').mockImplementation((id, ...args) => { guard(id); return load(id, ...args) }),
    vi.spyOn(f.coordinator, 'openManagedDocument').mockImplementation((id, ...args) => { guard(id); return open(id, ...args) }),
    vi.spyOn(f.coordinator, 'profile').mockImplementation((id, ...args) => { guard(id); return profile(id, ...args) }),
  ]
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    await selected.useColdSelectedTarget(f.coordinator, result.target, async value => { value.assertCurrent(); expect(value.view.header?.parentSession).toBe('source') })
    expect(sourceReads).toBe(0)
  } finally { hooks.forEach(hook => hook.mockRestore()); await f.coordinator.close() }
})

const predecessor = process.env.IH_TASK_D_PREDECESSOR_FIXTURES
it.skipIf(!predecessor)('retains the actual predecessor birth while its owned current target transitions to14', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'cold-cap13-'))
  const source = join(predecessor!, 'selected13-result', 'sessions')
  const stageName = (await readdir(source)).find(name => name.startsWith('target.jsonl.bootstrap-') && name.endsWith('.stage'))!
  await copyFile(join(source, 'target.jsonl'), join(root, 'target.jsonl'))
  await copyFile(join(source, stageName), join(root, stageName))
  const original = await readFile(join(root, 'target.jsonl')), stageBytes = await readFile(join(root, stageName)), stage = JSON.parse(stageBytes.toString())
  const route = { protocol: 'public-results-v1' as const, request: stage.captureReservation.request }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const result = await selected.inspectColdSelectedTarget(coordinator, route)
    if (result.kind !== 'qualification-required') throw Error('Missing original13 target')
    await selected.useColdSelectedTarget(coordinator, result.target, async value => {
      expect(value.view.formatVersion).toBe(14)
      expect(JSON.parse(value.birth.stage.headerBytes).formatVersion).toBe(13)
      expect(value.birth.stage).toEqual(stage)
      value.assertCurrent()
    })
    const current = await readFile(join(root, 'target.jsonl'))
    expect(current.subarray(current.indexOf(10) + 1)).toEqual(original.subarray(original.indexOf(10) + 1))
    expect(await readFile(join(root, stageName))).toEqual(stageBytes)
    await expect(coordinator.openManagedDocument('target')).rejects.toThrow()
  } finally { await coordinator.close() }
})

it('rejects copied and foreign targets and keeps a finite callback guard local to its use', async () => {
  const f = await fixture(), other = await fixture()
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(result).toHaveProperty('target')
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    await expect(selected.useColdSelectedTarget(f.coordinator, { ...result.target }, async () => true)).rejects.toThrow()
    await expect(selected.useColdSelectedTarget(other.coordinator, result.target, async () => true)).rejects.toThrow()
    let guard!: () => void
    await selected.useColdSelectedTarget(f.coordinator, result.target, async observation => {
      guard = observation.assertCurrent
      await expect(f.coordinator.close()).rejects.toThrow()
      observation.assertCurrent()
      await expect(selected.useColdSelectedTarget(f.coordinator, result.target, async () => true)).rejects.toThrow()
    })
    expect(guard).toThrow()
    await f.coordinator.closeManagedDocument!('target')
    await expect(selected.useColdSelectedTarget(f.coordinator, result.target, async () => true)).rejects.toThrow()
  } finally { await Promise.all([f.coordinator.close(), other.coordinator.close()]) }
})

it.each([undefined, null, false, 0, ''])('preserves callback failure %s and permits the same entry to be inspected again', async failure => {
  const f = await fixture()
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(result).toHaveProperty('target')
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    const value = await selected.useColdSelectedTarget(f.coordinator, result.target, async () => { throw failure }).then(() => ({ failed: false }), cause => ({ failed: true, cause }))
    expect(value).toEqual({ failed: true, cause: failure })
    await selected.useColdSelectedTarget(f.coordinator, result.target, async observation => observation.assertCurrent())
    await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow()
  } finally { await f.coordinator.close() }
})

it('external close fences the original in-flight use then joins it before releasing the claim', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const result = await selected.inspectColdSelectedTarget(f.coordinator, f.route)
    expect(result).toHaveProperty('target')
    if (result.kind !== 'qualification-required') throw Error('Missing cold target')
    const use = selected.useColdSelectedTarget(f.coordinator, result.target, async observation => { entered.resolve(); await release.promise; observation.assertCurrent() })
    const failedUse = use.then(() => false, () => true)
    await entered.promise
    let closed = false
    const close = f.coordinator.closeManagedDocument!('target').then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(f.coordinator.ownerOf!('target')).toBe(true)
    release.resolve()
    expect(await failedUse).toBe(true)
    await close
    expect(f.coordinator.ownerOf!('target')).toBe(false)
  } finally { release.resolve(); await f.coordinator.close() }
})
