import { afterEach, expect, it, vi } from 'vitest'
const controls = vi.hoisted(() => ({ prepare: undefined as undefined | ((owner: import('@i-harness/context-output').ContextOutputService) => Promise<void>), owners: [] as import('@i-harness/context-output').ContextOutputService[] }))
vi.mock('@i-harness/context-output', async original => {
  const native = await original<typeof import('@i-harness/context-output')>()
  return { ...native, createContextOutputService: (...args: Parameters<typeof native.createContextOutputService>) => {
    const owner = native.createContextOutputService(...args), read = owner.readResult
    controls.owners.push(owner)
    owner.readResult = async (...input) => { await controls.prepare?.(owner); return read(...input) }
    return owner
  } }
})
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { acquireAssemblyResultStore, acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import { createSessionService } from '../src/service.ts'
import { unfinishedResult } from '../../context-output/test/close-fixture.ts'

afterEach(() => { controls.prepare = undefined; controls.owners = [] })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reader-close-')), settings = join(root, 'settings.json')
  await writeFile(settings, '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 's' })
  const options = { workspace: root, coordinator, contextOutputSettingsPath: settings, sessionId: 's' }
  const seed = await acquireAssemblyResultStore(options), owner = seed.service!
  const scope = owner.registerResultScope({ operationId: 'seed', sessionId: 's', callId: 'seed', source: await seed.sourceFor!('s') }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('original durable page'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture refused')
  await seed.release(); controls.owners = []
  return { root, options, coordinator, ref: saved.ref }
}

it.each(['global', 'session'] as const)('retains failed cold-read cleanup for explicit %s teardown retries without admitting another page or owner', async mode => {
  const f = await fixture(), fault = new Error('cold reader original native close refused')
  let original: Awaited<ReturnType<typeof unfinishedResult>> | undefined, closeCalls = 0, allow = false
  let spy: ReturnType<typeof vi.spyOn> | undefined
  controls.prepare = async owner => {
    if (original) return
    original = await unfinishedResult(owner, f.root, 'cold-owner-unfinished')
    const nativeClose = original.body.close.bind(original.body)
    spy = vi.spyOn(original.body, 'close').mockImplementation(async () => { closeCalls++; if (!allow) throw fault; await nativeClose() })
  }
  const independentCleanup = join(f.root, 'independent-cleanup')
  const service = createSessionService({ ...f.options, beforeDispose: async () => { await writeFile(independentCleanup, 'independent cleanup attempted') } })
  const close = () => mode === 'global' ? service.close() : service.closeSession('s')
  try {
    expect(await service.readResultPage!('s', { ref: f.ref })).toEqual({ kind: 'unavailable', reason: 'unavailable' })
    expect(closeCalls).toBe(1); expect(controls.owners).toHaveLength(1)
    const owner = controls.owners[0]!
    expect(original!.body.fd).toBeGreaterThanOrEqual(0)
    // A fresh read cannot become an unrelated cleanup retry or a new owner.
    expect(await service.readResultPage!('s', { ref: f.ref })).toEqual({ kind: 'unavailable', reason: 'unavailable' })
    expect(closeCalls).toBe(1); expect(controls.owners).toEqual([owner])
    const failure = await close().catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(mode === 'global' ? failure.errors[0].errors : failure.errors).toContain(fault)
    expect(closeCalls).toBe(2)
    if (mode === 'global') expect(await readFile(independentCleanup, 'utf8')).toBe('independent cleanup attempted')
    await expect(close()).rejects.toThrow(/cleanup/i)
    expect(closeCalls).toBe(3)
    await expect(acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })).rejects.toThrow(/retir|cleanup/i)
    allow = true
    await close()
    expect(closeCalls).toBe(4)
    expect(original!.body.fd).toBe(-1); expect(original!.leaves.fd).toBe(-1)
    controls.prepare = undefined
    if (mode === 'session') expect(await service.readResultPage!('s', { ref: f.ref })).toMatchObject({ data: { text: 'original durable page' } })
    const fresh = await acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
    try { expect(fresh.service).not.toBe(owner) } finally { await fresh.release() }
    expect(service.hasAssembly('s')).toBe(false)
  } finally {
    allow = true; controls.prepare = undefined
    await service.close(); for (const owner of controls.owners) await owner.close()
    spy?.mockRestore(); await original?.body.close(); await original?.leaves.close()
    await f.coordinator.close(); await rm(f.root, { recursive: true, force: true })
  }
})

it('joins overlapping global and session retries of the exact cold-reader cleanup flight', async () => {
  const f = await fixture(), fault = new Error('shared cold cleanup failure')
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  let original: Awaited<ReturnType<typeof unfinishedResult>> | undefined, closeCalls = 0, allow = false
  let spy: ReturnType<typeof vi.spyOn> | undefined
  controls.prepare = async owner => {
    if (original) return
    original = await unfinishedResult(owner, f.root, 'cold-concurrent')
    const nativeClose = original.body.close.bind(original.body)
    spy = vi.spyOn(original.body, 'close').mockImplementation(async () => {
      closeCalls++
      if (!allow) { if (closeCalls > 1) { entered.resolve(); await resume.promise }; throw fault }
      await nativeClose()
    })
  }
  const service = createSessionService(f.options)
  try {
    expect(await service.readResultPage!('s', { ref: f.ref })).toMatchObject({ kind: 'unavailable' })
    const global = service.close().catch(error => error)
    await entered.promise
    const session = service.closeSession('s').catch(error => error)
    await new Promise(resolve => setImmediate(resolve))
    expect(closeCalls).toBe(2)
    resume.resolve()
    const [globalFailure, sessionFailure] = await Promise.all([global, session])
    expect(globalFailure.errors[0].errors).toContain(fault)
    expect(sessionFailure.errors).toContain(fault)
    expect(closeCalls).toBe(2); expect(controls.owners).toHaveLength(1)
    allow = true; await service.close()
    expect(closeCalls).toBe(3)
    expect(original!.body.fd).toBe(-1); expect(original!.leaves.fd).toBe(-1)
  } finally {
    allow = true; resume.resolve(); controls.prepare = undefined
    await service.close(); for (const owner of controls.owners) await owner.close()
    spy?.mockRestore(); await original?.body.close(); await original?.leaves.close()
    await f.coordinator.close(); await rm(f.root, { recursive: true, force: true })
  }
})
