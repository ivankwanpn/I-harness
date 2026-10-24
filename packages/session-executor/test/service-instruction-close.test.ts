import { afterEach, expect, it, vi } from 'vitest'
const controls = vi.hoisted(() => ({
  environments: [] as import('../src/context/instructions/contracts.ts').InstructionEnvironment[],
  environmentCloses: [] as import('../src/context/instructions/contracts.ts').InstructionEnvironment[],
  sources: [] as import('@i-harness/instructions').InstructionService[],
  sourceCloses: [] as import('@i-harness/instructions').InstructionService[],
  owners: [] as import('@i-harness/context-output').ContextOutputService[],
  beforeRead: undefined as undefined | ((owner: import('@i-harness/context-output').ContextOutputService) => Promise<void>),
}))
vi.mock('@i-harness/instructions', async original => {
  const native = await original<typeof import('@i-harness/instructions')>()
  return { ...native, createObservedInstructionService: (...args: Parameters<typeof native.createObservedInstructionService>) => {
    const source = native.createObservedInstructionService(...args)
    controls.sources.push(source)
    // Observe the actual source close beneath the host's own view tracking, so
    // environment.close bypassing the assembly pin cannot evade this control.
    return { ...source, async close() { controls.sourceCloses.push(source); await source.close() } }
  } }
})
vi.mock('../src/context/instructions/index.ts', async original => {
  const native = await original<typeof import('../src/context/instructions/index.ts')>()
  return { ...native, createProjectInstructionEnvironment: () => {
    const environment = native.createProjectInstructionEnvironment(), close = environment.close.bind(environment)
    controls.environments.push(environment)
    environment.close = async () => { controls.environmentCloses.push(environment); await close() }
    return environment
  } }
})
vi.mock('@i-harness/context-output', async original => {
  const native = await original<typeof import('@i-harness/context-output')>()
  return { ...native, createContextOutputService: (...args: Parameters<typeof native.createContextOutputService>) => {
    const owner = native.createContextOutputService(...args), read = owner.readResult
    controls.owners.push(owner)
    owner.readResult = async (...input) => { await controls.beforeRead?.(owner); return read(...input) }
    return owner
  } }
})
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/index.ts'
import { acquireAssemblyResultStore, acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import { unfinishedResult } from '../../context-output/test/close-fixture.ts'
import { controlledModel } from './controlled-model.ts'
import { rmWorkspaceSync } from './helpers.ts'

afterEach(() => {
  controls.environments = []; controls.environmentCloses = []; controls.sources = []; controls.sourceCloses = []; controls.owners = []; controls.beforeRead = undefined
})

it('keeps the actual default instruction owner open while its retained assembly publication is unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'default-publication-')), settings = join(root, 'settings.json')
  await writeFile(join(root, 'AGENTS.md'), 'SERVICE_OWNED_ORIGINAL_PUBLICATION'); await writeFile(settings, '{}')
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  let key: BatchKey | undefined, ready = false, issues = 0, requests = 0
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'runtime/context')) { key = args[3].key; issues++; return { kind: 'unknown', key } }
    return outcome
  }
  backend.reconcileOwnedBatch = (...args) => !ready && key?.batchId === args[3].key.batchId ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args)
  // No instructionEnvironment option: the service creates and owns this actual
  // environment, including its host, observation owner and watch service.
  const service = createSessionService({ workspace: root, coordinator, contextOutputSettingsPath: settings, model: controlledModel(async function* () { requests++; yield { type: 'end' } }), contextWindow: 100000, codeMode: { mode: 'off' } })
  try {
    await expect(service.submit(id, 'hold the original publication', new AbortController().signal)).rejects.toThrow()
    expect([issues, requests, controls.environments.length, controls.sources.length, controls.owners.length]).toEqual([1, 0, 1, 1, 1])
    const source = controls.sources[0]!, owner = controls.owners[0]!, ownerClose = vi.spyOn(owner, 'close')
    const original = source.snapshot()
    expect(original).toMatchObject({ reliability: 'ready', complete: true }); expect(original.text).toContain('SERVICE_OWNED_ORIGINAL_PUBLICATION')
    await expect(service.close()).rejects.toThrow(/cleanup/)
    expect(controls.sourceCloses).toEqual([])
    expect(controls.environmentCloses).toEqual([])
    expect(source.snapshot()).toEqual(original)
    expect(await source.prepare([{ path: root, kind: 'directory' }])).toMatchObject({ reliability: 'ready', complete: true })
    expect(service.hasAssembly(id)).toBe(true); expect(ownerClose).not.toHaveBeenCalled()
    const reader = await acquireResultReadStore({ workspace: root, coordinator, contextOutputSettingsPath: settings, sessionId: id, readCallerAvailable: () => true })
    try { expect(reader.service).toBe(owner) } finally { await reader.release() }
    expect(controls.owners).toEqual([owner]); expect([issues, requests]).toEqual([1, 0])
    ready = true
    expect(await (await coordinator.openManagedDocument(id)).reconcile(key!)).toMatchObject({ kind: 'committed' })
    await service.close()
    expect(service.hasAssembly(id)).toBe(false)
    expect(controls.sourceCloses).toEqual([source]); expect(controls.environmentCloses).toEqual(controls.environments)
    expect(source.snapshot()).toMatchObject({ reliability: 'unavailable', complete: false })
    expect(ownerClose).toHaveBeenCalledTimes(1); expect([issues, requests]).toEqual([1, 0])
  } finally { ready = true; await service.close(); await coordinator.close(); rmWorkspaceSync(root) }
})

it('still closes an independent actual default environment when only cold-reader cleanup remains held', async () => {
  const root = await mkdtemp(join(tmpdir(), 'default-reader-cleanup-')), settings = join(root, 'settings.json')
  await writeFile(settings, '{}'); await writeFile(join(root, 'AGENTS.md'), 'INDEPENDENT_DEFAULT_OWNER')
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } }), { id } = await coordinator.create()
  const options = { workspace: root, coordinator, contextOutputSettingsPath: settings, sessionId: id }
  const seed = await acquireAssemblyResultStore(options), scope = seed.service!.registerResultScope({ operationId: 'seed', sessionId: id, callId: 'seed' }, () => true)
  const sink = await seed.service!.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('independent default environment control'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture refused')
  const service = createSessionService({ ...options, modelPolicy: 'test-mock', codeMode: { mode: 'off' } })
  let original: Awaited<ReturnType<typeof unfinishedResult>> | undefined, allow = false
  let spy: ReturnType<typeof vi.spyOn> | undefined
  try {
    await service.assemblyFor(id); await service.closeSession(id); await seed.release()
    expect(service.hasAssembly(id)).toBe(false); expect(controls.environments).toHaveLength(1)
    const environment = controls.environments[0]!, source = environment.host.create({ cwd: root, roots: [root], enabled: true, maxBytes: 24000, globalSources: [] })
    expect(await source.prepare([{ path: root, kind: 'directory' }])).toMatchObject({ reliability: 'ready', complete: true })
    expect(controls.sourceCloses).toEqual([]); expect(controls.environmentCloses).toEqual([])
    controls.beforeRead = async owner => {
      if (original) return
      original = await unfinishedResult(owner, root, 'reader-original')
      const nativeClose = original.body.close.bind(original.body)
      spy = vi.spyOn(original.body, 'close').mockImplementation(async () => { if (!allow) throw new Error('reader original native cleanup remains held'); await nativeClose() })
    }
    expect(await service.readResultPage!(id, { ref: saved.ref })).toMatchObject({ kind: 'unavailable' })
    await expect(service.close()).rejects.toThrow(/cleanup/)
    expect(original!.body.fd).toBeGreaterThanOrEqual(0)
    expect(controls.environmentCloses).toEqual([environment]); expect(controls.sourceCloses).toHaveLength(1)
    expect(source.snapshot()).toMatchObject({ reliability: 'unavailable', complete: false })
    allow = true; await service.close()
    expect(original!.body.fd).toBe(-1); expect(original!.leaves.fd).toBe(-1)
    expect(controls.environmentCloses).toEqual([environment]); expect(controls.sourceCloses).toHaveLength(1)
  } finally {
    allow = true; controls.beforeRead = undefined; await service.close(); await seed.release()
    spy?.mockRestore(); await original?.body.close(); await original?.leaves.close(); await coordinator.close(); rmWorkspaceSync(root)
  }
})
