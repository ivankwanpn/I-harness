import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
const state = vi.hoisted(() => ({ target: '', releases: 0, fail: true, profilePath: '', profileFail: false }))
vi.mock('@i-harness/fs-lock', async original => { const actual = await original<any>(); return { ...actual, async acquireSessionLock(options: any) { const raw = await actual.acquireSessionLock(options); if (options.lockPath !== state.target) return raw; return { get held() { return raw.held }, async release() { state.releases++; if (state.fail) { state.fail = false; throw false }; await raw.release() } } } } })
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, async readFile(...args: any[]) { if (state.profileFail && String(args[0]) === state.profilePath) { state.profileFail = false; throw undefined }; return (actual.readFile as any)(...args) } } })
import { lockPathFor } from '@i-harness/fs-lock'
import { artifactPathsFor } from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createSessionService } from '@i-harness/session-executor'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createDesktopExecution } from '../src/execution.ts'
import { createRetainedCleanupOperation, finishRetainedCleanupOperation, closeCoordinatorWithRetainedCleanupOperation } from '@i-harness/session-persistence/internal/retained-inspection'
import { createExecutionHostObservation } from '../src/execution-host-observation.ts'
function selectedProjectLeasePath(backend: ReturnType<typeof createJsonlBackend>, root: string, id: string) {
  const key = 'desktop-session-project-' + createHash('sha256').update(id).digest('hex')
  const capture = artifactPathsFor(backend)!.document(key)
  if (capture.kind !== 'ready') throw new Error('Original project document parent unavailable')
  capture.assertCurrent()
  return lockPathFor(root, 'artifact-document-lease:' + capture.key)
}
it('retains exact original native release debt while independent leases dispose, then explicitly retries once', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'adapter-native-debt-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const backend = createJsonlBackend(root)
  const c = composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract), foreign = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), options, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root), owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    for (const id of ['s', 't']) { await c.create({ sessionId: id }); await c.releaseOwnership(id) }
    state.target = selectedProjectLeasePath(backend, root, 's'); state.releases = 0; state.fail = true; state.profileFail = false
    const s = await owner.subscribe('s', () => {}), t = await owner.subscribe('t', () => {})
    await expect(owner.close()).rejects.toThrow()
    expect(state.releases).toBe(1)
    await expect(s.snapshot()).rejects.toThrow(); await expect(t.snapshot()).rejects.toThrow()
    await expect(foreign.adoptOwnership('s')).rejects.toThrow()
    await foreign.adoptOwnership('t'); await foreign.releaseOwnership('t')
    await owner.close(); expect(state.releases).toBe(2)
    await foreign.adoptOwnership('s'); await foreign.releaseOwnership('s')
    await owner.close(); expect(state.releases).toBe(2)
  } finally { state.fail = false; await owner.close(); await broker.close(); await service.close(); await c.close(); await foreign.close(); await rm(root, { recursive: true, force: true }) }
})


it('retains partial genuine acquisition cleanup debt without an implicit retry before reporting the failure', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'adapter-partial-native-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const backend = createJsonlBackend(root)
  const c = composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract), foreign = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), options, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root), owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({ sessionId: 's' }); await c.releaseOwnership('s')
    state.target = selectedProjectLeasePath(backend, root, 's'); state.releases = 0; state.fail = true; state.profilePath = join(root, 's.jsonl'); state.profileFail = true
    let failure: unknown
    try { await owner.subscribe('s', () => {}) } catch (error) { failure = error }
    const flatten = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error]
    expect(flatten(failure)).toContain(undefined); expect(flatten(failure)).toContain(false)
    expect(state.releases).toBe(1)
    await expect(foreign.adoptOwnership('s')).rejects.toThrow()
    state.fail = true
    const operation = createRetainedCleanupOperation()
    try {
      await expect(owner.close(operation)).rejects.toThrow(); expect(state.releases).toBe(2)
      await expect(closeCoordinatorWithRetainedCleanupOperation(c, operation)).rejects.toThrow(); expect(state.releases).toBe(2)
    } finally { finishRetainedCleanupOperation(operation) }
    await owner.close(); expect(state.releases).toBe(3)
    await foreign.adoptOwnership('s'); await foreign.releaseOwnership('s')
    await owner.close(); expect(state.releases).toBe(3)
  } finally { state.profileFail = false; state.fail = false; await owner.close(); await broker.close(); await service.close(); await c.close(); await foreign.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([
  ['broker', 'fulfilled', 'owner'], ['broker', 'undefined', 'owner'], ['broker', 'false', 'owner'], ['broker', 'settled-false', 'owner'],
  ['reference', 'fulfilled', 'owner'], ['reference', 'undefined', 'owner'], ['reference', 'false', 'owner'], ['reference', 'settled-false', 'owner'],
  ['broker', 'fulfilled', 'lease'], ['broker', 'false', 'lease'],
] as const)('joins natural %s retirement notice (%s) from an independent %s close', async (trigger, outcome, boundary) => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'adapter-natural-notice-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const backend = createJsonlBackend(root)
  const c = composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract), foreign = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), options, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root), owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let calls = 0, otherCalls = 0, retiring: Promise<unknown> | undefined, closing: Promise<unknown> | undefined
  try {
    for (const id of ['s', 't']) { await c.create({ sessionId: id }); await c.releaseOwnership(id) }
    state.target = selectedProjectLeasePath(backend, root, 's'); state.releases = 0; state.fail = false; state.profileFail = false
    const lease = await owner.subscribe('s', async notice => { if (notice.kind === 'retired') { calls++; entered.resolve(); await gate.promise } })
    await owner.subscribe('t', notice => { if (notice.kind === 'retired') otherCalls++ })
    // No lease.close precedes this original producer retirement.
    retiring = trigger === 'broker' ? broker.configureReferences([]) : c.releaseOwnership('s'); void retiring.catch(() => {})
    await entered.promise
    // Foreign native ownership proves original resources have actually gone,
    // while the asynchronous notice and its initiating operation remain held.
    await foreign.adoptOwnership('s'); await foreign.releaseOwnership('s'); expect(state.releases).toBe(1)
    if (outcome === 'settled-false') { gate.reject(false); await Promise.allSettled([retiring]) }
    let closed = false
    closing = (boundary === 'lease' ? lease.close() : owner.close()).then(() => { closed = true }, error => { closed = true; throw error }); void closing.catch(() => {})
    await new Promise(resolve => setImmediate(resolve)); if (outcome !== 'settled-false') expect(closed).toBe(false)
    await foreign.adoptOwnership('t'); await foreign.releaseOwnership('t')
    await expect(lease.snapshot()).rejects.toThrow()
    if (outcome === 'fulfilled') gate.resolve()
    else gate.reject(outcome === 'undefined' ? undefined : false)
    const results = await Promise.allSettled([retiring, closing])
    const flatten = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error]
    if (outcome === 'fulfilled') expect(results.every(result => result.status === 'fulfilled')).toBe(true)
    else for (const result of results) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') expect(flatten(result.reason)).toContain(outcome === 'undefined' ? undefined : false) }
    expect(calls).toBe(1); expect(otherCalls).toBe(1); expect(state.releases).toBe(1)
    await owner.close(); expect(calls).toBe(1); expect(state.releases).toBe(1)
  } finally {
    gate.resolve(); await Promise.allSettled([retiring, closing].filter(Boolean) as Promise<unknown>[])
    state.fail = false; state.profileFail = false
    await owner.close(); await broker.close(); await service.close(); await c.close(); await foreign.close(); await rm(root, { recursive: true, force: true })
  }
})
