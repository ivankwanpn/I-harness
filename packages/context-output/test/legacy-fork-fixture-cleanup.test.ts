import { afterEach, expect, it, vi } from 'vitest'
const faults = vi.hoisted(() => ({
  captureFailure: undefined as Error | undefined,
  failCallId: undefined as string | undefined,
  afterCapture: undefined as ((callId: string) => Promise<void>) | undefined,
  onCaptureFailure: undefined as (() => void) | undefined,
  completedSibling: undefined as Awaited<ReturnType<import('../src/index.ts').ContextOutputService['capture']>>,
  cleanupFailure: undefined as { cause: unknown } | undefined,
  services: [] as import('../src/index.ts').ContextOutputService[],
  coordinators: [] as ReturnType<typeof import('../../session-persistence-jsonl/src/task-document-factory.ts').createJsonlTaskTransitionCoordinator>[],
  brokers: [] as ReturnType<typeof import('../../desktop-gateway/src/project-scope.ts').createProjectScopeBroker>[],
  leases: [] as import('../../fs-lock/src/index.ts').SessionLock[],
  handles: [] as import('node:fs/promises').FileHandle[],
  roots: [] as string[],
  actualCapture: undefined as Awaited<ReturnType<import('../src/index.ts').ContextOutputService['capture']>>,
  heldAtFailure: false,
  attempts: { service: 0, nativeService: 0, broker: 0, coordinator: 0 },
}))
vi.mock('node:fs/promises', async load => {
  const native = await load<typeof import('node:fs/promises')>()
  return { ...native, async open(...args: Parameters<typeof native.open>) {
    const original = await native.open(...args)
    faults.handles.push(original)
    return original
  } }
})
vi.mock('../../fs-lock/src/index.ts', async load => {
  const native = await load<typeof import('../../fs-lock/src/index.ts')>()
  return { ...native, async acquireSessionLock(...args: Parameters<typeof native.acquireSessionLock>) {
    const original = await native.acquireSessionLock(...args)
    faults.leases.push(original)
    return original
  } }
})
vi.mock('../src/index.ts', async load => {
  const native = await load<typeof import('../src/index.ts')>()
  return { ...native, createContextOutputService(...args: Parameters<typeof native.createContextOutputService>) {
    const original = native.createContextOutputService(...args)
    const capture = original.capture.bind(original), close = original.close.bind(original)
    faults.services.push(original)
    original.capture = async (...input) => {
      const actual = await capture(...input)
      if (input[0].callId === 'VISIBLE-2') faults.completedSibling = actual
      await faults.afterCapture?.(input[0].callId)
      if (faults.captureFailure && (!faults.failCallId || faults.failCallId === input[0].callId)) {
        if (!actual) throw Error('The original native capture did not commit')
        faults.actualCapture = actual
        faults.heldAtFailure = faults.leases.some(lease => lease.held)
        faults.onCaptureFailure?.()
        throw faults.captureFailure
      }
      return actual
    }
    original.close = async () => {
      faults.attempts.service++
      if (faults.cleanupFailure) throw faults.cleanupFailure.cause
      faults.attempts.nativeService++
      await close()
    }
    return original
  } }
})
vi.mock('../../session-persistence-jsonl/src/task-document-factory.ts', async load => {
  const native = await load<typeof import('../../session-persistence-jsonl/src/task-document-factory.ts')>()
  return { ...native, createJsonlTaskTransitionCoordinator(...args: Parameters<typeof native.createJsonlTaskTransitionCoordinator>) {
    const original = native.createJsonlTaskTransitionCoordinator(...args), close = original.close.bind(original)
    faults.coordinators.push(original)
    faults.roots.push(String(args[0]))
    original.close = async () => { faults.attempts.coordinator++; await close() }
    return original
  } }
})
vi.mock('../../desktop-gateway/src/project-scope.ts', async load => {
  const native = await load<typeof import('../../desktop-gateway/src/project-scope.ts')>()
  return { ...native, createProjectScopeBroker(...args: Parameters<typeof native.createProjectScopeBroker>) {
    const original = native.createProjectScopeBroker(...args), close = original.close.bind(original)
    faults.brokers.push(original)
    original.close = async () => { faults.attempts.broker++; await close() }
    return original
  } }
})
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { legacyFixture } from './legacy-fork-fixture.ts'

function leaves(cause: unknown): unknown[] {
  return cause instanceof AggregateError ? cause.errors.flatMap(leaves) : [cause]
}
afterEach(() => {
  faults.captureFailure = undefined
  faults.failCallId = undefined; faults.afterCapture = undefined; faults.onCaptureFailure = undefined; faults.completedSibling = undefined
  faults.cleanupFailure = undefined
  faults.services = []; faults.coordinators = []; faults.brokers = []
  faults.leases = []; faults.handles = []; faults.roots = []
  faults.actualCapture = undefined; faults.heldAtFailure = false
  faults.attempts = { service: 0, nativeService: 0, broker: 0, coordinator: 0 }
})

it('joins the original concurrent capture sibling before failed setup cleanup and preserves its first cause', async () => {
  const primary = faults.captureFailure = new Error('Original concurrent capture delivery failed')
  faults.failCallId = 'VISIBLE-1'
  const failed = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  faults.onCaptureFailure = failed.resolve
  faults.afterCapture = async callId => { if (callId === 'VISIBLE-2') { entered.resolve(); await release.promise } }
  let retained: (() => Promise<void>) | undefined
  const initializing = legacyFixture({ distinct: 3, concurrentPrepare: true, retainFailedSetupCleanup: close => { retained = close } })
  let settled = false
  void initializing.then(() => { settled = true }, () => { settled = true })
  let testFailure: { cause: unknown } | undefined
  try {
    await Promise.race([Promise.all([failed.promise, entered.promise]), initializing.then(() => { throw Error('Original capture sibling was not held') }, cause => { throw new Error('Setup retired before its original capture sibling', { cause }) })])
    expect(settled).toBe(false)
    expect({ ...faults.attempts }).toEqual({ service: 0, nativeService: 0, broker: 0, coordinator: 0 })
    expect(faults.completedSibling).toBeDefined()
    release.resolve()
    const failure = await initializing.then(() => { throw Error('Original concurrent failure was lost') }, cause => cause)
    expect(leaves(failure)).toEqual([primary])
    expect({ ...faults.attempts }).toEqual({ service: 1, nativeService: 1, broker: 1, coordinator: 1 })
    const owners = join(dirname(faults.roots[0]!), 'context-output', createHash('sha256').update('workspace').digest('hex'), 'owners')
    expect(JSON.parse(await readFile(join(owners, faults.completedSibling!.id + '.json'), 'utf8'))).toEqual(['creator'])
    await retained!()
    expect({ ...faults.attempts }).toEqual({ service: 1, nativeService: 1, broker: 1, coordinator: 1 })
  } catch (cause) { testFailure = { cause } }
  finally {
    release.resolve()
    await initializing.catch(() => {})
    const failures: unknown[] = []
    try { await retained?.() } catch (cause) { failures.push(cause) }
    if (faults.leases.some(lease => lease.held) || faults.handles.some(handle => handle.fd >= 0)) failures.push(Error('Concurrent setup retained an actual native resource'))
    if (testFailure && !failures.length) throw testFailure.cause
    if (failures.length) throw new AggregateError([...(testFailure ? [testFailure.cause] : []), ...failures], 'Original concurrent fixture cleanup failed', { cause: testFailure?.cause })
  }
})

it('keeps the actual concurrent capture and batched grant effects unchanged on successful setup', async () => {
  const f = await legacyFixture({ distinct: 3, concurrentPrepare: true })
  try {
    expect(f.selectedRefs).toHaveLength(3)
    const owners = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'owners')
    for (const ref of f.selectedRefs) expect(JSON.parse(await readFile(join(owners, ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
    expect({ ...faults.attempts }).toEqual({ service: 0, nativeService: 0, broker: 0, coordinator: 0 })
  } finally { await f.close() }
  expect(faults.leases.every(lease => !lease.held)).toBe(true)
  expect(faults.handles.every(handle => handle.fd < 0)).toBe(true)
})

it.each([false, true])('closes original partial fixture owners after a real committed capture delivery failure (cleanupRefused=%s)', async cleanupRefused => {
  const primary = faults.captureFailure = new Error('Original fixture capture delivery failed')
  if (cleanupRefused) faults.cleanupFailure = { cause: false }
  let retained: (() => Promise<void>) | undefined
  let initializing: ReturnType<typeof legacyFixture> | undefined
  let testFailure: { cause: unknown } | undefined
  try {
    initializing = legacyFixture(cleanupRefused ? { retainFailedSetupCleanup: close => {
      expect(faults.services).toHaveLength(0)
      retained = close
    } } : {})
    const failure = await initializing.then(() => { throw Error('Expected original setup rejection') }, cause => cause)
    expect(faults.actualCapture).toBeDefined()
    expect(faults.heldAtFailure).toBe(true)
    expect(await readFile(join(faults.roots[0]!, 'source.jsonl'), 'utf8')).toContain('"sessionId":"source"')
    expect({ ...faults.attempts }).toEqual({ service: 1, nativeService: cleanupRefused ? 0 : 1, broker: 1, coordinator: 1 })
    if (!cleanupRefused) expect(failure).toBe(primary)
    else {
      expect(retained).toBeTypeOf('function')
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.cause).toBe(primary)
      expect(leaves(failure)).toEqual([primary, false])
    }
    faults.cleanupFailure = undefined
    if (retained) { await retained(); await retained() }
    expect({ ...faults.attempts }).toEqual({ service: cleanupRefused ? 2 : 1, nativeService: 1, broker: 1, coordinator: 1 })
    expect(faults.leases.length).toBeGreaterThan(0)
    expect(faults.leases.every(lease => !lease.held)).toBe(true)
    expect(faults.handles.every(handle => handle.fd < 0)).toBe(true)
  } catch (cause) { testFailure = { cause } }
  finally {
    faults.cleanupFailure = undefined
    await initializing?.catch(() => {})
    const cleanupFailures: unknown[] = []
    try { await retained?.() } catch (cause) { cleanupFailures.push(cause) }
    // Baseline qualification intentionally runs before the helper owns cleanup.
    // Join the same recorded original owners for test hygiene after leak proof;
    // this never counts as the failed helper acknowledging its resources.
    if (!retained && testFailure) {
      for (const owner of [...faults.services, ...faults.brokers, ...faults.coordinators]) {
        try { await owner.close() } catch (cause) { cleanupFailures.push(cause) }
      }
    }
    if (faults.leases.some(lease => lease.held) || faults.handles.some(handle => handle.fd >= 0)) cleanupFailures.push(Error('Actual native fixture resource remained open'))
    if (testFailure && !cleanupFailures.length) throw testFailure.cause
    if (cleanupFailures.length) throw new AggregateError([...(testFailure ? [testFailure.cause] : []), ...cleanupFailures], 'Actual partial fixture cleanup failed', { cause: testFailure?.cause })
  }
})
