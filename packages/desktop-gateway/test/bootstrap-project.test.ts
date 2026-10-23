import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as persistence from '@i-harness/session-persistence'
import { createBootstrapRequestIntent } from '../../session-persistence/src/coordinator/bootstrap-intent.ts'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createProjectScopeBroker } from '../src/project-scope.ts'

const cleanup: (() => Promise<void>)[] = []
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, realpath: vi.fn(fs.realpath) } })
afterEach(async () => { vi.mocked(realpath).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).realpath); for (const close of cleanup.splice(0).reverse()) await close() })
const bindingKey = (id: string) => 'desktop-session-project-' + createHash('sha256').update(id).digest('hex')
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-project-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'); await mkdir(workspace)
  const coordinator = persistence.createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  cleanup.push(() => coordinator.close())
  await coordinator.create({ sessionId: 'source' })
  const broker = createProjectScopeBroker(coordinator, workspace); cleanup.push(() => broker.close())
  const project = { id: 'p1', name: 'Project', roots: [workspace], primaryRoot: workspace }
  await broker.configure(project); await broker.bind('source', 'p1')
  return { root, workspace, coordinator, broker, project }
}
function request(project: any = { kind: 'project', projectId: 'p1' }) {
  const { intent, requestDigest } = createBootstrapRequestIntent({ action: 'fork', selection: 'all' }, project)
  const invocation = { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest }
  const request: persistence.BootstrapRequest = { invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed: persistence.compileSemanticSeed({ kind: 'none' }) }
  return { request, intent, invocation }
}
const dependencies = { async confirm() { throw new Error('empty confirm') }, async reconcile() { throw new Error('empty reconcile') } }
function capture(r: ReturnType<typeof request>) { return { invocation: r.invocation, requestIntent: r.intent, sourceSessionId: 'source', sourceAvailable: () => true, assertNewWorkCurrent() {}, targetAvailable: () => true } }
async function reserve(coordinator: persistence.SessionCoordinator, r = request()) {
  const outcome = await coordinator.bootstrapSemanticTarget(r.request, { assertCurrent() {}, dependencies, targetPreparation: {
    async confirm() { return { kind: 'blocked', reason: 'unavailable' } }, async reconcile() { return { kind: 'blocked', reason: 'unavailable' } }, assertTargetCurrent() {},
  } })
  if (outcome.kind !== 'blocked' || !('manifestDigest' in outcome.token)) throw new Error('Expected actual reserved target')
  return { r, phase: { invocation: r.invocation, manifestDigest: outcome.token.manifestDigest } }
}
function gate() {
  let enter!: () => void, release!: () => void
  return { started: new Promise<void>(resolve => { enter = resolve }), wait: new Promise<void>(resolve => { release = resolve }), enter: () => enter(), release: () => release() }
}

it('prepares genuine reserved JSONL authority without exposing the public incomplete target', async () => {
  const { coordinator, broker, project, root } = await setup()
  expect(typeof (broker as any).prepareBootstrapInheritance).toBe('function')
  const r = request(), preparation = (broker as any).prepareBootstrapInheritance(capture(r))
  expect(preparation.targetScope).toThrow(); expect(preparation.assertSourceCurrent).toThrow()
  const port = preparation.targetPreparation
  const outcome = await coordinator.bootstrapSemanticTarget(r.request, { assertCurrent() {}, dependencies, targetPreparation: {
    ...port, async confirm(input, current) {
      await expect(coordinator.profile('target')).rejects.toThrow()
      const result = await port.confirm(input, current)
      expect(result).toEqual({ kind: 'confirmed' }); expect(preparation.targetScope().scope).toEqual(project)
      await expect(coordinator.profile('target')).rejects.toThrow()
      return result
    },
  } })
  expect(outcome.kind).toBe('ready')
  expect(await coordinator.getDocument(bindingKey('target'))).toEqual({ version: 1, projectId: 'p1' })
  expect((await readFile(join(root, 'sessions', 'target.jsonl'), 'utf8')).trimEnd().split('\n')).toHaveLength(2)
  const scope = preparation.targetScope(); scope.scope.roots.push('mutated')
  expect(preparation.targetScope().scope).toEqual(project)
  preparation.close(); expect(preparation.targetScope).toThrow()
})

it('recovers landed binding after lost response without source runtime reads or another write', async () => {
  const { coordinator, workspace, project } = await setup(), { r, phase } = await reserve(coordinator)
  let writes = 0, sourceCalls = 0, profiles = 0
  const broker = createProjectScopeBroker({ ...coordinator, async putDocument(key, value) { writes++; await coordinator.putDocument(key, value); throw new Error('response lost') }, async profile(id) { profiles++; return coordinator.profile(id) } }, workspace)
  cleanup.push(() => broker.close()); await broker.configure(project)
  const preparation = broker.prepareBootstrapInheritance({ ...capture(r), sourceAvailable() { sourceCalls++; return true } })
  expect(await preparation.targetPreparation.confirm(phase, () => true)).toEqual({ kind: 'blocked', reason: 'unavailable' })
  expect(await coordinator.getDocument(bindingKey('target'))).toEqual({ version: 1, projectId: 'p1' })
  sourceCalls = profiles = 0; const beforeWrites = writes
  expect(await preparation.targetPreparation.reconcile(phase)).toEqual({ kind: 'confirmed' })
  expect(preparation.targetScope().scope).toEqual(project)
  expect({ sourceCalls, profiles, writes }).toEqual({ sourceCalls: 0, profiles: 0, writes: beforeWrites })
  const cold = createProjectScopeBroker({ ...coordinator, async profile() { throw new Error('passive profile forbidden') }, async putDocument() { throw new Error('passive write forbidden') } }, workspace)
  cleanup.push(() => cold.close()); await cold.configure(project)
  const passive = cold.prepareBootstrapInheritance({ ...capture(r), sourceAvailable() { throw new Error('source callback forbidden') }, assertNewWorkCurrent() { throw new Error('source action forbidden') } })
  expect(await passive.targetPreparation.reconcile(phase)).toEqual({ kind: 'confirmed' })
  expect(passive.targetScope().scope).toEqual(project); expect(passive.assertSourceCurrent).toThrow()
})

it.each(['missing', 'foreign', 'unassigned', 'malformed'])('passive %s binding cannot confirm or create target authority', async mode => {
  const { coordinator, broker } = await setup(), { r, phase } = await reserve(coordinator)
  if (mode !== 'missing') await coordinator.putDocument(bindingKey('target'), mode === 'foreign' ? { version: 1, projectId: 'p2' } : mode === 'unassigned' ? { version: 1 } : { version: 1, projectId: 'p1', roots: [] })
  const preparation = broker.prepareBootstrapInheritance({ ...capture(r), sourceAvailable() { throw new Error('passive source callback') }, assertNewWorkCurrent() { throw new Error('passive source action') } })
  expect((await preparation.targetPreparation.reconcile(phase)).kind).toBe('blocked')
  expect(preparation.targetScope).toThrow()
  expect(await coordinator.getDocument(bindingKey('target'))).toEqual(mode === 'missing' ? undefined : mode === 'foreign' ? { version: 1, projectId: 'p2' } : mode === 'unassigned' ? { version: 1 } : { version: 1, projectId: 'p1', roots: [] })
})

it('requires full original invocation and manifest, actual source selection and current action before publication', async () => {
  const { coordinator, broker, project } = await setup(), { r, phase } = await reserve(coordinator)
  const preparation = broker.prepareBootstrapInheritance(capture(r))
  for (const request of [{ ...phase, manifestDigest: 'f'.repeat(64) }, { ...phase, invocation: { ...r.invocation, createdAt: '2026-10-23T01:00:00.000Z' } }, { ...phase, invocation: { ...r.invocation, operationId: 'other' } }]) {
    expect(await preparation.targetPreparation.confirm(request, () => true)).toMatchObject({ kind: 'blocked', reason: 'conflict' })
    expect(await coordinator.getDocument(bindingKey('target'))).toBeUndefined()
  }
  expect((await preparation.targetPreparation.confirm(phase, () => false)).kind).toBe('blocked')
  await coordinator.create({ sessionId: 'other-source' }); await broker.configure({ ...project, id: 'p2' }); await broker.bind('other-source', 'p2')
  const wrong = broker.prepareBootstrapInheritance({ ...capture(r), sourceSessionId: 'other-source' })
  expect((await wrong.targetPreparation.confirm(phase, () => true)).kind).toBe('blocked')
  expect(await coordinator.getDocument(bindingKey('target'))).toBeUndefined()
  expect(await preparation.targetPreparation.confirm(phase, () => true)).toEqual({ kind: 'confirmed' })
})

it.each(['unassigned', 'project'])('allows explicit admitted import %s intent without inventing a source session', async kind => {
  const { coordinator, broker } = await setup(), r = request(kind === 'project' ? { kind, projectId: 'p1' } : { kind })
  r.request.lineage = { origin: 'import' }
  const { phase } = await reserve(coordinator, r), { sourceSessionId: _, ...input } = capture(r)
  const preparation = broker.prepareBootstrapInheritance(input)
  expect(await preparation.targetPreparation.confirm(phase, () => true)).toEqual({ kind: 'confirmed' })
  expect(preparation.targetScope().projectId).toBe(kind === 'project' ? 'p1' : undefined)
  expect(await coordinator.getDocument(bindingKey('target'))).toEqual(kind === 'project' ? { version: 1, projectId: 'p1' } : { version: 1 })
})

it('keeps target passive authority independent of source availability and freezes its first revision across ABA', async () => {
  const { coordinator, broker, project } = await setup(), { r, phase } = await reserve(coordinator)
  let source = true
  const preparation = broker.prepareBootstrapInheritance({ ...capture(r), sourceAvailable: () => source })
  expect(await preparation.targetPreparation.confirm(phase, () => true)).toEqual({ kind: 'confirmed' })
  preparation.assertSourceCurrent(); source = false
  expect(preparation.assertSourceCurrent).toThrow(); expect(preparation.targetScope().scope).toEqual(project)
  expect(await preparation.targetPreparation.reconcile(phase)).toEqual({ kind: 'confirmed' })
  await broker.revoke('p1'); await broker.configure(project)
  expect(preparation.targetScope).toThrow()
  expect((await preparation.targetPreparation.reconcile(phase)).kind).toBe('blocked')
  source = true
  expect((await preparation.targetPreparation.confirm(phase, () => true)).kind).toBe('blocked')
  const fresh = broker.prepareBootstrapInheritance({ ...capture(r), sourceAvailable: () => false })
  expect(await fresh.targetPreparation.reconcile(phase)).toEqual({ kind: 'confirmed' })
})

it.each(['put', 'readback', 'scope'])('invalidates an attempt permanently when reconfiguration crosses its %s await', async window => {
  const { coordinator, workspace, project } = await setup(), { r, phase } = await reserve(coordinator), cut = gate()
  let wrote = false, pause = true
  const broker = createProjectScopeBroker({ ...coordinator,
    async putDocument(key, value) { await coordinator.putDocument(key, value); wrote = true; if (window === 'put' && pause) { pause = false; cut.enter(); await cut.wait } },
    async getDocument(key) { const value = await coordinator.getDocument(key); if (window === 'readback' && wrote && pause) { pause = false; cut.enter(); await cut.wait } return value },
  }, workspace)
  cleanup.push(() => broker.close()); await broker.configure(project)
  if (window === 'scope') {
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(realpath).mockImplementation(async (...args: Parameters<typeof realpath>) => { const value = await native.realpath(...args); if (pause) { pause = false; cut.enter(); await cut.wait } return value })
  }
  const preparation = broker.prepareBootstrapInheritance(capture(r)), confirming = preparation.targetPreparation.confirm(phase, () => true)
  await cut.started; const change = broker.configure(project); cut.release()
  expect((await confirming).kind).toBe('blocked'); await change
  expect((await preparation.targetPreparation.reconcile(phase)).kind).toBe('blocked')
  const fresh = broker.prepareBootstrapInheritance({ ...capture(r), sourceAvailable: () => false })
  expect(await fresh.targetPreparation.reconcile(phase)).toEqual({ kind: 'confirmed' })
})

it('never treats void put completion or failed readback as a confirmed binding', async () => {
  const { coordinator, workspace, project } = await setup(), { r, phase } = await reserve(coordinator)
  const broker = createProjectScopeBroker({ ...coordinator, async putDocument() {} }, workspace)
  cleanup.push(() => broker.close()); await broker.configure(project)
  const preparation = broker.prepareBootstrapInheritance(capture(r))
  expect(await preparation.targetPreparation.confirm(phase, () => true)).toMatchObject({ kind: 'blocked' })
  expect(preparation.targetScope).toThrow(); expect(await coordinator.getDocument(bindingKey('target'))).toBeUndefined()
})

it('captures closed host input synchronously and rejects unmanaged intent and hidden callback fields', async () => {
  const { broker } = await setup(), r = request()
  let reads = 0
  const input = capture(r), preparation = broker.prepareBootstrapInheritance(input)
  input.targetAvailable = () => false
  expect(() => broker.prepareBootstrapInheritance(Object.defineProperty(capture(r), 'sourceAvailable', { enumerable: true, get() { reads++; return () => true } }))).toThrow()
  expect(() => broker.prepareBootstrapInheritance(Object.defineProperty(capture(r), 'hidden', { value: 1 }))).toThrow()
  expect(() => broker.prepareBootstrapInheritance(capture(request({ kind: 'unmanaged' })))).toThrow()
  expect(() => broker.prepareBootstrapInheritance({ ...capture(r), requestIntent: { ...r.intent, project: { kind: 'unassigned' } } })).toThrow()
  expect(reads).toBe(0); preparation.close()
})

it.each(['project', 'references'])('refuses first authority while %s canonicalization is still pending', async kind => {
  const { coordinator, broker, project } = await setup(), { r, phase } = await reserve(coordinator), cut = gate()
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let pause = true
  vi.mocked(realpath).mockImplementation(async (...args: Parameters<typeof realpath>) => { const value = await native.realpath(...args); if (pause) { pause = false; cut.enter(); await cut.wait } return value })
  const configuring = kind === 'project' ? broker.configure(project) : broker.configureReferences(project.roots)
  await cut.started
  const preparation = broker.prepareBootstrapInheritance(capture(r))
  const outcome = await preparation.targetPreparation.confirm(phase, () => true)
  cut.release(); await configuring
  expect(outcome.kind).toBe('blocked')
  expect(await coordinator.getDocument(bindingKey('target'))).toBeUndefined()
})

it.each(['put', 'readback', 'scope'].flatMap(window => ['close', 'target-gone', 'revoke'].map(action => ({ window, action }))))('denies $action during real target $window and never exposes completed authority', async ({ window, action }) => {
  const { coordinator, workspace, project } = await setup(), { r, phase } = await reserve(coordinator), cut = gate()
  let wrote = false, pause = true
  const broker = createProjectScopeBroker({ ...coordinator,
    async putDocument(key, value) { await coordinator.putDocument(key, value); wrote = true; if (window === 'put' && pause) { pause = false; cut.enter(); await cut.wait } },
    async getDocument(key) { const value = await coordinator.getDocument(key); if (window === 'readback' && wrote && pause) { pause = false; cut.enter(); await cut.wait } return value },
  }, workspace)
  cleanup.push(() => broker.close()); await broker.configure(project)
  if (window === 'scope') {
    const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(realpath).mockImplementation(async (...args: Parameters<typeof realpath>) => { const value = await native.realpath(...args); if (pause) { pause = false; cut.enter(); await cut.wait } return value })
  }
  let target = true
  const preparation = broker.prepareBootstrapInheritance({ ...capture(r), targetAvailable: () => target }), confirming = preparation.targetPreparation.confirm(phase, () => true)
  await cut.started
  const closing = action === 'close' ? broker.close() : action === 'revoke' ? broker.revoke('p1') : Promise.resolve()
  if (action === 'target-gone') target = false
  cut.release(); expect((await confirming).kind).toBe('blocked'); await closing
  target = true
  expect(preparation.targetScope).toThrow(); expect((await preparation.targetPreparation.reconcile(phase)).kind).toBe('blocked')
})

it('separately rechecks genuine source binding revision after target preparation', async () => {
  const { coordinator, workspace, project } = await setup(), r = request(); r.request.lineage = { origin: 'import' }
  const { phase } = await reserve(coordinator, r)
  const broker = createProjectScopeBroker(coordinator, workspace, undefined, { async assertIdle() {} }); cleanup.push(() => broker.close())
  await broker.configure(project); await broker.configure({ ...project, id: 'p2' })
  const preparation = broker.prepareBootstrapInheritance(capture(r))
  expect(await preparation.targetPreparation.confirm(phase, () => true)).toEqual({ kind: 'confirmed' })
  preparation.assertSourceCurrent()
  expect((await coordinator.bootstrapSemanticTarget(r.request, { assertCurrent() {}, dependencies, targetPreparation: preparation.targetPreparation })).kind).toBe('ready')
  await broker.move('source', 'p1', 'p2')
  expect(preparation.assertSourceCurrent).toThrow()
  expect(preparation.targetScope().scope).toEqual(project)
  expect(await preparation.targetPreparation.reconcile(phase)).toEqual({ kind: 'confirmed' })
})

it.each(['malformed', 'readback', 'scope'])('withdraws acquired target authority after %s failure is observed', async failure => {
  const { coordinator, workspace, project } = await setup(), { r, phase } = await reserve(coordinator)
  let failRead = false
  const broker = createProjectScopeBroker({ ...coordinator, async getDocument(key) { if (failRead) throw new Error('readback unavailable'); return coordinator.getDocument(key) } }, workspace)
  cleanup.push(() => broker.close()); await broker.configure(project)
  const preparation = broker.prepareBootstrapInheritance(capture(r))
  expect(await preparation.targetPreparation.confirm(phase, () => true)).toEqual({ kind: 'confirmed' })
  if (failure === 'malformed') await coordinator.putDocument(bindingKey('target'), { version: 1, projectId: 'p1', foreign: true })
  if (failure === 'readback') failRead = true
  if (failure === 'scope') await rename(workspace, workspace + '-moved')
  expect((await preparation.targetPreparation.reconcile(phase)).kind).toBe('blocked')
  expect(preparation.targetScope).toThrow()
  if (failure === 'malformed') await coordinator.putDocument(bindingKey('target'), { version: 1, projectId: 'p1' })
  if (failure === 'scope') await rename(workspace + '-moved', workspace)
  failRead = false
  expect((await preparation.targetPreparation.reconcile(phase)).kind).toBe('blocked')
})
