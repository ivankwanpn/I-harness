// Original native journal disposal must outlive its separately committed receipt.
import { expect, it, vi } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
const leases = vi.hoisted(() => ({ root: '', values: [] as import('../../fs-lock/src/index.ts').SessionLock[] }))
vi.mock('../../fs-lock/src/index.ts', async load => {
  const native = await load<typeof import('../../fs-lock/src/index.ts')>()
  return { ...native, async acquireSessionLock(...args: Parameters<typeof native.acquireSessionLock>) {
    const original = await native.acquireSessionLock(...args)
    if (leases.root && args[0].lockPath.startsWith(leases.root)) leases.values.push(original)
    return original
  } }
})
const fault = vi.hoisted(() => ({ path: '', stage: '', armed: '', mode: 'before' as 'before' | 'consumed', hits: 0, loseAppendAck: false, prefixCut: undefined as (() => Promise<void>) | undefined, loadCut: undefined as (() => Promise<void>) | undefined, owner: undefined as unknown, observed: [] as { stage: string; owner: unknown }[], results: [] as { stage: string; result: unknown }[], resources: [] as { handle: FileHandle; close: () => Promise<void>; calls: number; owner: unknown }[] }))
vi.mock('node:fs/promises', async load => {
  const native = await load<typeof import('node:fs/promises')>()
  return { ...native, async open(...args: Parameters<typeof native.open>) {
    const handle = await native.open(...args)
    if (String(args[0]) !== fault.path || args[1] !== 'r+' || fault.stage !== fault.armed) return handle
    const resource = { handle, close: handle.close.bind(handle), calls: 0, owner: fault.owner }
    fault.resources.push(resource)
    handle.close = async () => {
      resource.calls++
      if (fault.armed) {
        fault.hits++
        if (fault.mode === 'consumed') { await resource.close(); throw undefined }
        throw new Error('issue88 close before native ACK')
      }
      await resource.close()
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { isHeldFactOwner } from '@i-harness/session-persistence'
import { retainOriginalNativeJournalCleanup, canJoinOriginalNativePrewrite } from '../../session-persistence/src/native-fact-writer-internal.ts'
import { createSessionCoordinator } from './helpers/composed.ts'

type AppendInput = Parameters<NonNullable<import('@i-harness/session-persistence').PersistenceBackend['appendOwnedBatch']>>
function backendAt(root: string, observeAppend?: (...args: AppendInput) => void) {
  return createJsonlBackend(root, { wrap(backend) {
    const readOriginal = backend.read
    backend.read = async (...args) => {
      const result = await Reflect.apply(readOriginal,backend,args)
      if (fault.loadCut) { const cut=fault.loadCut;fault.loadCut=undefined;await cut() }
      return result
    }
    for (const name of ['readJournalPrefix', 'appendOwnedBatch', 'reconcileOwnedBatch', 'confirmBootstrapFrames'] as const) {
      const original = backend[name]
      if (!original) throw new Error('Missing native journal method ' + name)
      // Constructor-owned interception, stable before nominal association.
      Object.defineProperty(backend, name, { configurable: true, enumerable: true, writable: true, value: async (...args: unknown[]) => {
        if (name === 'appendOwnedBatch') observeAppend?.(...args as AppendInput)
        const before = fault.stage, beforeOwner = fault.owner; fault.stage = name; fault.owner = args[1]; fault.observed.push({ stage: name, owner: args[1] })
        try { const result = await Reflect.apply(original, backend, args); fault.results.push({ stage: name, result }); if (name === 'appendOwnedBatch' && fault.loseAppendAck) { fault.loseAppendAck = false; throw new Error('Original append delivery lost after native result') }; return result } finally { if(name === 'readJournalPrefix' && fault.prefixCut){const cut=fault.prefixCut;fault.prefixCut=undefined;await cut()}; fault.stage = before; fault.owner = beforeOwner }
      } })
    }
  } })
}

it('removes original prewrite scheduling evidence when retained native cleanup refuses entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-prewrite-cleanup-debt-'))
  leases.root = root
  let input: AppendInput | undefined
  const backend = backendAt(root, (...args) => { input = args })
  const coordinator = createSessionCoordinator(backend)
  try {
    const { id } = await coordinator.create()
    const document = await coordinator.openManagedDocument(id)
    fault.path = join(root, id + '.jsonl')
    fault.mode = 'before'
    fault.armed = 'appendOwnedBatch'
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed' })
    expect(input).toBeDefined()
    expect(fault.resources).toHaveLength(1)
    const original = input!
    const bytes = await readFile(fault.path)
    // Use the actual original request/issuer, not a copied authority. The
    // ledger's retained native close error must refuse this call before batch
    // validation/issuance, and its scheduling token must not survive rejection.
    await expect(backend.appendOwnedBatch!(...original)).rejects.toThrow('issue88 close before native ACK')
    expect(canJoinOriginalNativePrewrite(backend, original[0], original[1], original[3])).toBe(false)
    expect(await readFile(fault.path)).toEqual(bytes)
    expect(fault.resources).toHaveLength(1)
    fault.armed = ''
    await coordinator.close()
  } finally {
    await rawCleanup(coordinator, root)
  }
})
async function rawCleanup(coordinator: ReturnType<typeof createSessionCoordinator>, root: string) {
  // All callers await their original operation/close before this finally.
  // This is test hygiene, NOT a logical disposal ACK assertion.
  fault.armed = ''; fault.stage = ''; fault.path = ''
  const results = await Promise.allSettled(fault.resources.map(async resource => { if (resource.handle.fd >= 0) await resource.close() }))
  await coordinator.close().catch(() => {})
  const releases = await Promise.allSettled(leases.values.map(async lease => { if (lease.held) await lease.release() }))
  leases.values = []; leases.root = ''
  fault.results = []
  fault.prefixCut = undefined; fault.loadCut = undefined; fault.loseAppendAck = false; fault.resources = []; fault.observed = []; fault.owner = undefined; fault.hits = 0
  await rm(root, { recursive: true, force: true })
  const errors = [...results, ...releases].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Original raw fixture descriptor cleanup failed')
}

for (const stage of ['appendOwnedBatch', 'reconcileOwnedBatch'] as const) for (const mode of ['before', 'consumed'] as const) it('retains committed native journal disposal separately from its receipt: ' + stage + '/' + mode, async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-issue88-append-'))
  leases.root = root
  const coordinator = createSessionCoordinator(backendAt(root))
  try {
    const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
    fault.path = join(root, id + '.jsonl'); fault.mode = mode; fault.armed = stage; fault.loseAppendAck = stage === 'reconcileOwnedBatch'
    const result = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect(result.kind).toBe('committed')
    const committedBytes = await readFile(fault.path)
    expect(committedBytes.toString().split('\n').filter(line => line.includes('session/fact-batch'))).toHaveLength(1)
    expect(fault.resources).toHaveLength(1); expect(fault.hits).toBe(1)
    const resource = fault.resources[0]!
    expect(resource.handle.fd >= 0).toBe(mode === 'before')
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'off' })).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(fault.resources).toHaveLength(1)
    expect(await readFile(fault.path)).toEqual(committedBytes)
    const firstClose = await coordinator.close().then(() => ({ kind: 'clean' }), error => ({ kind: 'failed', error }))
    expect({ disposition: firstClose.kind, retainedNativeLeases: leases.values.filter(lease => lease.held).length }).toMatchObject({ disposition: 'failed', retainedNativeLeases: expect.any(Number) })
    expect(leases.values.some(lease => lease.held)).toBe(true)
    expect(await readFile(fault.path)).toEqual(committedBytes)
    fault.armed = ''
    const calls = resource.calls
    if (mode === 'before') {
      await coordinator.close()
      expect(resource.handle.fd).toBe(-1); expect(resource.calls).toBeGreaterThan(calls)
    } else {
      const retry = await coordinator.close().then(() => 'clean', () => 'failed')
      expect(retry).toBe('failed'); expect(resource.calls).toBe(calls)
    }
    expect(await readFile(fault.path)).toEqual(committedBytes)
  } finally { await rawCleanup(coordinator, root) }
})

it('retains the cold pre-attach journal owner when prefix disposal rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-issue88-cold-'))
  leases.root = root
  const first = createSessionCoordinator(backendAt(root))
  const { id } = await first.create(); await first.close()
  leases.root = root
  const coordinator = createSessionCoordinator(backendAt(root))
  try {
    fault.path = join(root, id + '.jsonl'); fault.mode = 'before'; fault.armed = 'readJournalPrefix'
    const bytes = await readFile(fault.path)
    const opening = await coordinator.openManagedDocument(id).then(() => 'opened', () => 'failed')
    expect(opening).toBe('failed'); expect(fault.hits).toBe(1); expect(fault.resources).toHaveLength(1)
    const original = fault.resources[0]!
    expect(original.owner).toBe(fault.observed.find(call => call.stage === 'readJournalPrefix')!.owner)
    expect(original.handle.fd).toBeGreaterThanOrEqual(0)
    const closing = await coordinator.closeManagedDocument(id).then(() => 'clean', () => 'failed')
    expect({ disposition: closing, retainedNativeLeases: leases.values.filter(lease => lease.held).length }).toMatchObject({ disposition: 'failed', retainedNativeLeases: expect.any(Number) })
    expect(leases.values.some(lease => lease.held)).toBe(true)
    fault.armed = ''; await coordinator.closeManagedDocument(id)
    expect(original.handle.fd).toBe(-1); expect(original.calls).toBeGreaterThan(1)
    expect(await readFile(fault.path)).toEqual(bytes)
    const reopened = await coordinator.openManagedDocument(id)
    reopened.assertReady()
    expect(reopened.view.events).toEqual([])
    expect(await readFile(fault.path)).toEqual(bytes)
  } finally { await rawCleanup(coordinator, root) }
})


it('retains a bootstrap confirmation descriptor through its distinct confirmation owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-issue88-confirm-'))
  const request = {
    invocation: { version: 1 as const, operationId: 'original', targetSessionId: 'target', createdAt: '2026-11-13T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
    target: { kind: 'new' as const }, metadata: {},
    lineage: { origin: 'fork' as const, parentSession: 'parent' },
    seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] },
  }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('No source dependencies') }, async reconcile() { throw Error('No source dependencies') } } }
  leases.root = root
  const first = createSessionCoordinator(backendAt(root))
  try { expect((await first.bootstrapSemanticTarget!(request, guards)).kind).toBe('ready') } finally { await first.close() }
  leases.root = root
  const coordinator = createSessionCoordinator(backendAt(root))
  try {
    fault.path = join(root, 'target.jsonl'); fault.mode = 'before'; fault.armed = 'confirmBootstrapFrames'
    const bytes = await readFile(fault.path)
    fault.observed = []
    const confirmation = await coordinator.bootstrapSemanticTarget!(request, guards)
    expect(confirmation.kind).toBe('already-ready')
    expect(fault.results.find(call => call.stage === 'confirmBootstrapFrames')?.result).toMatchObject({ kind: 'committed', receipts: expect.any(Array) })
    expect(fault.hits).toBe(1); expect(fault.resources).toHaveLength(1)
    const resource = fault.resources[0]!
    expect(resource.owner).toBe(fault.observed.find(call => call.stage === 'confirmBootstrapFrames')!.owner)
    expect(resource.handle.fd).toBeGreaterThanOrEqual(0)
    const closing = await coordinator.close().then(() => 'clean', () => 'failed')
    expect({ disposition: closing, retainedNativeLeases: leases.values.filter(lease => lease.held).length }).toMatchObject({ disposition: 'failed', retainedNativeLeases: expect.any(Number) })
    expect(leases.values.some(lease => lease.held)).toBe(true)
    fault.armed = ''; await coordinator.close()
    expect(resource.handle.fd).toBe(-1)
    expect(await readFile(fault.path)).toEqual(bytes)
  } finally { await rawCleanup(coordinator, root) }
})






it('disposes its original descriptor after public method and handle method replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-issue88-replaced-'))
  leases.root = root
  const backend = backendAt(root), coordinator = createSessionCoordinator(backend)
  const originalRead = backend.read
  try {
    const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
    fault.path = join(root, id + '.jsonl'); fault.mode = 'before'; fault.armed = 'appendOwnedBatch'
    expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
    const resource = fault.resources[0]!
    if (!isHeldFactOwner(resource.owner)) throw new Error('Original held scope required')
    const cleanup = retainOriginalNativeJournalCleanup(backend, id, resource.owner)
    expect(cleanup).toBeDefined()
    await expect(coordinator.close()).rejects.toBeInstanceOf(AggregateError)
    const replacedClose = vi.fn(async () => { throw new Error('Replacement close must never run') })
    resource.handle.close = replacedClose
    backend.read = async () => { throw new Error('Replacement public method must never run for disposal') }
    fault.armed = ''
    await cleanup!.settle()
    expect(resource.handle.fd).toBe(-1)
    expect(replacedClose).not.toHaveBeenCalled()
    expect(cleanup!.hasDebt()).toBe(false)
    backend.read = originalRead
    await coordinator.close()
  } finally { backend.read = originalRead; await rawCleanup(coordinator, root) }
})


it.each(['prefix','load'] as const)('joins overlapping cold opening and public close through the same original cleanup lifetime: %s', async cut => {
  const root = await mkdtemp(join(tmpdir(), 'ih-issue91-overlap-'))
  leases.root = root
  const first = createSessionCoordinator(backendAt(root))
  const { id } = await first.create()
  await first.close()
  const coordinator = createSessionCoordinator(backendAt(root))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let opening: Promise<string> | undefined, closing: Promise<string> | undefined, openingError: unknown
  try {
    fault.path = join(root, id + '.jsonl'); fault.mode = 'before'; fault.armed = 'readJournalPrefix'
    const originalBytes = await readFile(fault.path)
    const pause = async () => { entered.resolve(); await release.promise }
    if(cut === 'prefix')fault.prefixCut=pause;else fault.loadCut=pause
    opening = coordinator.openManagedDocument(id).then(() => 'opened', error => { openingError=error;return 'failed' })
    await entered.promise
    let closed = false
    closing = coordinator.closeManagedDocument(id).then(() => { closed = true; return 'clean' }, () => { closed = true; return 'failed' })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve()
    expect(await opening).toBe('failed')
    const disposition = await closing
    if(cut === 'load') {
      expect(openingError).toMatchObject({message:'TASK_TRANSITION_FAILED',cause:{message:'TASK_TRANSITION_CONFLICT'}})
      expect(disposition).toBe('clean')
      expect(fault.resources).toHaveLength(0)
      expect(await readFile(fault.path)).toEqual(originalBytes)
      return
    }
    expect(disposition).toBe('failed')
    expect(fault.resources).toHaveLength(1)
    expect(leases.values.some(lease => lease.held)).toBe(true)
    fault.armed = ''
    await coordinator.closeManagedDocument(id)
    expect(fault.resources[0]!.handle.fd).toBe(-1)
    const fresh = await coordinator.openManagedDocument(id)
    fresh.assertReady()
    expect(fresh.view.events).toEqual([])
  } finally {
    release.resolve()
    await Promise.allSettled([opening, closing].filter((flight): flight is Promise<string> => !!flight))
    await rawCleanup(coordinator, root)
  }
})
