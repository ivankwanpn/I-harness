import { afterEach, expect, it, vi } from 'vitest'
import type { FileHandle } from 'node:fs/promises'

const controls = vi.hoisted(() => ({
  prepare: undefined as undefined | ((owner: import('@i-harness/context-output').ContextOutputService) => Promise<void>),
  afterCloseFailure: undefined as undefined | (() => Promise<void>),
  retire: undefined as undefined | ((handle: FileHandle, close: () => Promise<void>) => Promise<void>),
  captureIO: false,
  originals: new WeakMap<FileHandle, () => Promise<void>>(),
  owners: [] as import('@i-harness/context-output').ContextOutputService[],
}))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native, async open(...args: Parameters<typeof native.open>) {
    const handle = await native.open(...args)
    if (!controls.captureIO) return handle
    const close = handle.close.bind(handle)
    controls.originals.set(handle, close)
    // Installed at original acquisition, before the writer retains its one
    // close invocation. The same actual handle/receiver is returned.
    handle.close = () => controls.retire ? controls.retire(handle, close) : close()
    return handle
  } }
})
vi.mock('@i-harness/context-output', async original => {
  const native = await original<typeof import('@i-harness/context-output')>()
  return { ...native, createContextOutputService: (...args: Parameters<typeof native.createContextOutputService>) => {
    const owner = native.createContextOutputService(...args)
    const read = owner.readResult
    const close = owner.close.bind(owner)
    controls.owners.push(owner)
    owner.readResult = async (...input) => { await controls.prepare?.(owner); return read(...input) }
    owner.close = async () => {
      try { await close() }
      catch (cause) { await controls.afterCloseFailure?.(); throw cause }
    }
    return owner
  } }
})
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { acquireAssemblyResultStore, acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import { createSessionService } from '../src/service.ts'
import { unfinishedResult } from '../../context-output/test/close-fixture.ts'

afterEach(() => {
  controls.prepare = undefined
  controls.afterCloseFailure = undefined
  controls.retire = undefined
  controls.captureIO = false
  controls.owners = []
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reader-close-')), settings = join(root, 'settings.json')
  await writeFile(settings, '{}')
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 's' })
  const options = { workspace: root, coordinator, contextOutputSettingsPath: settings, sessionId: 's' }
  const seed = await acquireAssemblyResultStore(options), owner = seed.service!
  const scope = owner.registerResultScope({ operationId: 'seed', sessionId: 's', callId: 'seed', source: await seed.sourceFor!('s') }, () => true)
  const sink = await owner.beginResult(scope, 'text-utf8-v1')
  await sink.write(Buffer.from('original durable page'))
  const saved = await sink.finish('complete')
  if (saved.kind !== 'committed') throw Error('fixture refused')
  await seed.release()
  controls.owners = []
  return { root, options, coordinator, ref: saved.ref }
}

function onlyOriginalFailure(cause: unknown, fault: Error): boolean {
  if (cause === fault) return true
  if (cause instanceof AggregateError) return cause.errors.length > 0 && cause.errors.every(child => onlyOriginalFailure(child, fault))
  const nested = cause instanceof Error ? Object.getOwnPropertyDescriptor(cause, 'cause') : undefined
  return !!nested && 'value' in nested && onlyOriginalFailure(nested.value, fault)
}

async function cleanup(
  f: Awaited<ReturnType<typeof fixture>>,
  service: ReturnType<typeof createSessionService>,
  original: Awaited<ReturnType<typeof unfinishedResult>> | undefined,
  fault: Error,
  primary?: { cause: unknown },
) {
  controls.prepare = undefined
  controls.afterCloseFailure = undefined
  controls.retire = undefined
  controls.captureIO = false
  const failures: unknown[] = []
  for (const close of [() => service.close(), ...controls.owners.map(owner => () => owner.close())]) {
    try { await close() } catch (cause) { if (!onlyOriginalFailure(cause, fault)) failures.push(cause) }
  }
  // Test-only OS hygiene after the assertions. Closing an actual remaining
  // descriptor does not repair the producer's rejected original ACK promise.
  for (const handle of [original?.body, original?.leaves]) {
    if (!handle || handle.fd < 0) continue
    try {
      const close = controls.originals.get(handle)
      if (!close) throw Error('Original native close was not captured')
      await close()
    } catch (cause) { failures.push(cause) }
  }
  for (const handle of [original?.body, original?.leaves]) {
    if (handle && handle.fd >= 0) failures.push(Error('Original owned artifact descriptor remains open after raw hygiene'))
  }
  if (original) {
    for (const owner of controls.owners) {
      try { await owner.close(); failures.push(Error('Raw descriptor hygiene falsely acknowledged the original rejected close')) }
      catch (cause) { if (!onlyOriginalFailure(cause, fault)) failures.push(cause) }
    }
  }
  try { await f.coordinator.close() } catch (cause) { failures.push(cause) }
  const target = resolve(f.root)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('reader-close-')) throw Error('Unexpected owned fixture root')
  if (!primary && !failures.length) {
    try { await rm(target, { recursive: true, force: true }) } catch (cause) { failures.push(cause) }
  }
  if (primary || failures.length) console.error('Preserved failed cold-reader fixture:', target)
  if (primary && !failures.length) throw primary.cause
  if (failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original cold reader resource hygiene failed', { cause: primary?.cause })
}

it.each(['global', 'session'] as const)('retains an unacknowledged original native close through explicit %s teardown without admitting another owner', async mode => {
  const f = await fixture(), fault = new Error('cold reader original native close refused')
  let original: Awaited<ReturnType<typeof unfinishedResult>> | undefined
  let nativeCloseCalls = 0
  controls.prepare = async owner => {
    if (original) return
    controls.captureIO = true
    try { original = await unfinishedResult(owner, f.root, 'cold-owner-unfinished') }
    finally { controls.captureIO = false }
  }
  controls.retire = async (handle, close) => {
    if (handle === original?.body) { nativeCloseCalls++; throw fault }
    await close()
  }
  const independentCleanup = join(f.root, 'independent-cleanup')
  const service = createSessionService({ ...f.options, beforeDispose: async () => { await writeFile(independentCleanup, 'independent cleanup attempted') } })
  const close = () => mode === 'global' ? service.close() : service.closeSession('s')
  let primary: { cause: unknown } | undefined
  try {
    expect(await service.readResultPage!('s', { ref: f.ref })).toEqual({ kind: 'unavailable', reason: 'unavailable' })
    expect(nativeCloseCalls).toBe(1)
    expect(controls.owners).toHaveLength(1)
    const owner = controls.owners[0]!
    expect(original!.body.fd).toBeGreaterThanOrEqual(0)
    expect(original!.leaves.fd).toBe(-1)
    expect(await service.readResultPage!('s', { ref: f.ref })).toEqual({ kind: 'unavailable', reason: 'unavailable' })
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await close().then(() => { throw Error('Unknown native cleanup was falsely acknowledged') }, cause => cause)
      expect(failure).toBeInstanceOf(AggregateError)
      expect(onlyOriginalFailure(failure, fault)).toBe(true)
      expect(nativeCloseCalls).toBe(1)
    }
    if (mode === 'global') expect(await readFile(independentCleanup, 'utf8')).toBe('independent cleanup attempted')
    await expect(acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })).rejects.toThrow(/retir|cleanup/i)
    // Future native calls could now close successfully, but replaying the
    // producer's original invocation is not an acknowledgement protocol.
    controls.retire = undefined
    await expect(close()).rejects.toThrow(/cleanup/i)
    expect(nativeCloseCalls).toBe(1)
    expect(original!.body.fd).toBeGreaterThanOrEqual(0)
    expect(controls.owners).toEqual([owner])
    expect(service.hasAssembly('s')).toBe(false)
  } catch (cause) { primary = { cause } }
  finally { await cleanup(f, service, original, fault, primary) }
})

it('joins overlapping global and session cleanup retries without reissuing a rejected native close', async () => {
  const f = await fixture(), fault = new Error('shared cold cleanup failure')
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  let original: Awaited<ReturnType<typeof unfinishedResult>> | undefined
  let nativeCloseCalls = 0, closeFailures = 0, held = false
  controls.prepare = async owner => {
    if (original) return
    controls.captureIO = true
    try { original = await unfinishedResult(owner, f.root, 'cold-concurrent') }
    finally { controls.captureIO = false }
  }
  controls.retire = async (handle, close) => {
    if (handle === original?.body) { nativeCloseCalls++; throw fault }
    await close()
  }
  controls.afterCloseFailure = async () => { closeFailures++; if (held) { entered.resolve(); await resume.promise } }
  const service = createSessionService(f.options)
  let global: Promise<unknown> | undefined, session: Promise<unknown> | undefined
  let primary: { cause: unknown } | undefined
  try {
    expect(await service.readResultPage!('s', { ref: f.ref })).toMatchObject({ kind: 'unavailable' })
    held = true
    global = service.close().catch(cause => cause)
    await Promise.race([entered.promise, global.then(() => { throw Error('Original cleanup retry did not reach the held failure') })])
    session = service.closeSession('s').catch(cause => cause)
    await new Promise(resolve => setImmediate(resolve))
    expect(closeFailures).toBe(2)
    expect(nativeCloseCalls).toBe(1)
    resume.resolve()
    const failures = await Promise.all([global, session])
    expect(failures.every(cause => onlyOriginalFailure(cause, fault))).toBe(true)
    expect(closeFailures).toBe(2)
    expect(nativeCloseCalls).toBe(1)
    expect(original!.body.fd).toBeGreaterThanOrEqual(0)
    expect(original!.leaves.fd).toBe(-1)
    expect(controls.owners).toHaveLength(1)
  } catch (cause) { primary = { cause } }
  finally {
    held = false
    resume.resolve()
    await Promise.allSettled([global, session])
    await cleanup(f, service, original, fault, primary)
  }
})
