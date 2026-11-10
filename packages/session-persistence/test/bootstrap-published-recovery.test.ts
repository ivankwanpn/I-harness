import { createJsonlProcessReadCapability } from '../../session-persistence-jsonl/src/backend/process-read.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../src/coordinator/task-document-scope.ts'
import { artifactPathsFor } from '../src/coordinator/artifact-path-association.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { decodeFactBatch, EMPTY_SEMANTIC_DEPENDENCY_DIGEST, encodeFactBatch, exportConversationSeed, legacyPrefixDigest } from '@i-harness/core-session'
import { buildBootstrapHeader, captureBootstrapRequest } from '../src/coordinator/bootstrap-header.ts'
import { bootstrapPaths } from '../../session-persistence-jsonl/src/backend/bootstrap-header.ts'
import { readBootstrapFactJournal } from '@i-harness/core-session/internal/bootstrap'
import { createSessionCoordinator, createControlledJsonlBackend, backendControls, ownedControls } from './helpers/composed.ts'
import { pair, guards } from './child-bootstrap-fixture.ts'
import { captureChildBootstrapCaptureRequest, createChildBootstrapRequestIntent, compileSemanticSeed, parseBootstrapHeaderStage, rawHeaderDigest } from '../src/index.ts'
import { bootstrapPathsForRoute } from '../../session-persistence-jsonl/src/backend/bootstrap-stage.ts'

const confirmation = vi.hoisted(() => ({ stages: new Map<string, number>(), path: '', unknown: false, before: undefined as (() => Promise<void>) | undefined }))
vi.mock('../../session-persistence-jsonl/src/backend/task-document-observation.ts', async load => {
  const api = await load<typeof import('../../session-persistence-jsonl/src/backend/task-document-observation.ts')>()
  return { ...api, createTaskDocumentObservation: (...args: Parameters<typeof api.createTaskDocumentObservation>) => {
    const original = api.createTaskDocumentObservation(...args)
    return Object.freeze({
      observe: original.observe.bind(original),
      async confirm(witness: Parameters<typeof original.confirm>[0]) {
        if (args[1] === confirmation.path) {
          const before = confirmation.before; confirmation.before = undefined
          await before?.()
          if (confirmation.unknown) return { kind: 'unknown' as const, cleanupPending: false }
        }
        return original.confirm(witness)
      },
      stageWrite: (...values: Parameters<typeof original.stageWrite>) => { confirmation.stages.set(args[1], (confirmation.stages.get(args[1]) ?? 0) + 1); return original.stageWrite(...values) },
      stageInitialize: (...values: Parameters<typeof original.stageInitialize>) => { confirmation.stages.set(args[1], (confirmation.stages.get(args[1]) ?? 0) + 1); return original.stageInitialize(...values) },
      settleResources: original.settleResources.bind(original),
    })
  } }
})
const roots: string[] = [], actors: ReturnType<typeof createSessionCoordinator>[] = []
afterEach(async () => {
  confirmation.path = ''; confirmation.unknown = false; confirmation.before = undefined
  const errors: unknown[] = []
  for (const actor of actors.splice(0).reverse()) try { await actor.close() } catch (error) { errors.push(error) }
  for (const root of roots.splice(0)) try {
    const allowed = ['bootstrap-published-', 'bootstrap-existing-published-', 'bootstrap-native-crash-']
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !allowed.some(prefix => basename(root).startsWith(prefix))) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  } catch (error) { errors.push(error) }
  confirmation.stages.clear()
  if (errors.length) throw new AggregateError(errors, 'Original bootstrap fixture cleanup failed')
})
function actor(root: string) {
  const backend = createControlledJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true }, acquireDeadlineMs: 100, acquireRetryMs: 5 })
  actors.push(coordinator); return { backend, coordinator }
}
async function partial(seed = false) {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-published-')); roots.push(root)
  const initial = actor(root)
  let { request, payload } = pair(), retired = false
  if (seed) {
    await initial.coordinator.create({ sessionId: 'parent' })
    await initial.coordinator.append('parent', [{ type: 'turn/start' }, { type: 'user/message', text: 'durable original seed' }, { type: 'turn/end' }])
    const exported = exportConversationSeed((await initial.coordinator.snapshot!('parent')).session, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
    if (exported.kind !== 'seed') throw new Error('Original durable seed required')
    const core = { ...request.core, history: { selection: { kind: 'all' as const }, source: { kind: 'session' as const, sessionId: 'parent' } } }
    const intent = createChildBootstrapRequestIntent(core, { kind: 'unmanaged' })
    request = captureChildBootstrapCaptureRequest({ ...request, core, requestIntent: intent.intent, invocation: { ...request.invocation, requestDigest: intent.requestDigest } })
    payload = { ...payload, invocation: request.invocation, seed: compileSemanticSeed(exported) }
    const append = ownedControls(initial.backend).originalAppend
    ownedControls(initial.backend).append = async (...args) => { const result = await append(...args); if (args[3].key.batchId.endsWith(':seed')) retired = true; return result }
  } else {
    const prepare = backendControls(initial.backend).original.prepareBootstrapHeader!
    backendControls(initial.backend).methods.prepareBootstrapHeader = async (...args) => { const result = await prepare(...args); retired = result.kind === 'committed'; return result }
  }
  const result = await initial.coordinator.bootstrapChildTargetWithCapture!(request, { ...guards, assertCurrent() { if (retired) throw new Error('Source retired after original durable phase') } }, async () => payload)
  expect(result.kind).toBe('blocked'); expect(retired).toBe(true)
  await initial.coordinator.close()
  const path = join(root, 'target.jsonl'), task = join(root, 'task-target.doc.jsonl'), stage = bootstrapPathsForRoute(path, { protocol: 'child-v1', request }).stage
  expect(JSON.parse(await readFile(task, 'utf8'))).toEqual({ formatVersion: 2, tasks: [], notifications: [] })
  return { root, request, payload, path, task, stage }
}
async function optionalTask(path: string) {
  try { return await readFile(path) } catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; throw error }
}
function journal(bytes: Buffer) {
  const end = bytes.indexOf(10), header = JSON.parse(bytes.subarray(0, end).toString())
  return { header, decoded: readBootstrapFactJournal(bytes.subarray(end + 1), header.journal, header.formatVersion, header), headerBytes: bytes.subarray(0, end + 1) }
}
async function existingPartial(seed: boolean, cut: 'header' | 'seed') {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-existing-published-')); roots.push(root)
  const initial = actor(root), base = pair().payload
  await initial.coordinator.create({ sessionId: 'target', createdAt: base.invocation.createdAt, title: 'original empty target' })
  const old = await readFile(join(root, 'target.jsonl'))
  expect(old.indexOf(10)).toBe(old.length - 1)
  let payload = { ...base, invocation: { ...base.invocation, operationId: 'existing-published' }, target: { kind: 'existing-empty' as const, expectedHeaderDigest: rawHeaderDigest(old), expectedPrefix: { eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0, new Uint8Array()) } } }
  if (seed) {
    await initial.coordinator.create({ sessionId: 'parent' })
    await initial.coordinator.append('parent', [{ type: 'turn/start' }, { type: 'user/message', text: 'existing-empty original seed' }, { type: 'turn/end' }])
    const exported = exportConversationSeed((await initial.coordinator.snapshot!('parent')).session, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
    if (exported.kind !== 'seed') throw new Error('Original source required')
    payload = { ...payload, seed: compileSemanticSeed(exported) }
  }
  let retired = false
  if (cut === 'seed') {
    const append = ownedControls(initial.backend).originalAppend
    ownedControls(initial.backend).append = async (...args) => { const result = await append(...args); if (args[3].key.batchId.endsWith(':seed')) retired = true; return result }
  } else {
    const prepare = backendControls(initial.backend).original.prepareBootstrapHeader!
    backendControls(initial.backend).methods.prepareBootstrapHeader = async (...args) => { const result = await prepare(...args); retired = result.kind === 'committed'; return result }
  }
  const opening = await initial.coordinator.bootstrapSemanticTarget(payload, { ...guards, assertCurrent() { if (retired) throw new Error('Original published cut') } })
  expect(opening.kind).toBe('blocked')
  expect(retired).toBe(true); await initial.coordinator.close()
  return { root, payload, path: join(root, 'target.jsonl'), task: join(root, 'task-target.doc.jsonl'), ...bootstrapPaths(join(root, 'target.jsonl'), payload.invocation) }
}
function completionKey(input: ReturnType<typeof pair>['payload'], stage: ReturnType<typeof parseBootstrapHeaderStage>) {
  const payload = captureBootstrapRequest(input)
  const seed = payload.seed.records.length ? encodeFactBatch('bootstrap:' + stage.invocation.operationId + ':seed', legacyPrefixDigest(0, new Uint8Array()), payload.seed.records) : undefined
  const previous = seed ? decodeFactBatch(seed.bytes).prefixDigest : legacyPrefixDigest(0, new Uint8Array())
  const initial = buildBootstrapHeader(payload, stage).initial!
  const complete = { type: 'session/bootstrap' as const, version: 1 as const, seq: stage.seed.seedLength, operationId: stage.invocation.operationId, manifestDigest: JSON.parse(stage.headerBytes).semanticSeed.manifestDigest, dependencyClosureDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, seedLength: stage.seed.seedLength, initialInputId: stage.initial!.inputId, initialStartedAt: stage.initial!.startedAt, initialExpiresAt: stage.initial!.expiresAt }
  return encodeFactBatch('bootstrap:' + stage.invocation.operationId + ':complete', previous, [complete, { ...initial, seq: stage.seed.seedLength + 1 }]).key
}
it.each([{ seed: false, cut: 'header' as const }, { seed: true, cut: 'header' as const }, { seed: true, cut: 'seed' as const }])('recovers original existing-empty published seed=$seed cut=$cut without refreshing initial tuple or batch key', async ({ seed, cut }) => {
  const f = await existingPartial(seed, cut), before = await readFile(f.path), task = await readFile(f.task), stageBytes = await readFile(f.stage), stage = parseBootstrapHeaderStage(stageBytes), cold = actor(f.root)
  const result = await cold.coordinator.resumeSemanticTarget(f.payload.invocation, guards, f.payload)
  expect(['ready', 'already-ready']).toContain(result.kind)
  if (result.kind !== 'ready' && result.kind !== 'already-ready') throw new Error('Original existing-empty birth did not recover')
  expect(result.receipt.initial).toEqual({ inputId: 'input', seq: f.payload.seed.records.length + 1, startedAt: 1, expiresAt: 11 })
  expect(result.receipt.completion.key).toEqual(completionKey(f.payload, stage))
  expect((await readFile(f.path)).subarray(0, before.length)).toEqual(before)
  expect(await readFile(f.stage)).toEqual(stageBytes); expect(await readFile(f.task)).toEqual(task)
  expect(journal(await readFile(f.path)).decoded.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
})
it('refuses an altered existing-empty publication marker without repairing unrelated bytes', async () => {
  const f = await existingPartial(false, 'header'), marker = Buffer.from(parseBootstrapHeaderStage(await readFile(f.stage)).headerBytes), changed = Buffer.from(marker), before = await readFile(f.path), task = await readFile(f.task), cold = actor(f.root)
  // The reader also supports a retained, exact original publication copy.
  await writeFile(f.publish, marker)
  changed[5] = changed[5] === 120 ? 121 : 120
  await writeFile(f.publish, changed)
  expect((await cold.coordinator.resumeSemanticTarget(f.payload.invocation, guards, f.payload)).kind).toBe('refused')
  expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.task)).toEqual(task); expect(await readFile(f.publish)).toEqual(changed)
  await writeFile(f.publish, marker)
  expect(['ready', 'already-ready']).toContain((await cold.coordinator.resumeSemanticTarget(f.payload.invocation, guards, f.payload)).kind)
})
it.each([false, true])('recovers an actual current published partial birth with original seed=%s', async seed => {
  const f = await partial(seed), before = await readFile(f.path), task = await readFile(f.task), stage = await readFile(f.stage), cold = actor(f.root)
  const result = await cold.coordinator.resumeChildTarget!(f.request, guards, f.payload)
  expect(['ready', 'already-ready']).toContain(result.kind)
  expect((await readFile(f.path)).subarray(0, before.length)).toEqual(before)
  expect(await readFile(f.task)).toEqual(task); expect(await readFile(f.stage)).toEqual(stage)
  const restored = journal(await readFile(f.path)).decoded.events
  expect(restored.filter(event => event.type === 'session/bootstrap')).toHaveLength(1)
  expect(restored.filter(event => event.type === 'agent/input/admitted')).toEqual([expect.objectContaining({ inputId: 'input', text: 'original prompt' })])
})
it.each(['missing', 'nonempty', 'foreign-seed', 'mixed-frame', 'changed-header'] as const)('refuses %s published proof without rewriting durable data', async mode => {
  const f = await partial(mode === 'foreign-seed' || mode === 'mixed-frame')
  if (mode === 'missing') await unlink(f.task)
  if (mode === 'nonempty') await writeFile(f.task, JSON.stringify({ formatVersion: 2, tasks: [], notifications: [{ id: 'note', submissionId: 'task', parentSessionId: 'target', messageId: 'message', state: 'completed', description: 'durable', text: 'preserve', status: 'pending', attempts: 0, timeCreated: 1 }] }) + '\n')
  if (mode === 'changed-header') {
    const { header, decoded } = journal(await readFile(f.path)); header.createdAt = 'different'
    await writeFile(f.path, Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), ...decoded.frames.map(frame => Buffer.from(frame.batch.bytes))]))
  }
  if (mode === 'foreign-seed') {
    const { headerBytes } = journal(await readFile(f.path))
    const foreign = encodeFactBatch('foreign-seed', legacyPrefixDigest(0, new Uint8Array()), f.payload.seed.records)
    await writeFile(f.path, Buffer.concat([headerBytes, Buffer.from(foreign.bytes)]))
  }
  if (mode === 'mixed-frame') {
    const prefix = journal(await readFile(f.path)).decoded.prefix
    await appendFile(f.path, encodeFactBatch('foreign-suffix', prefix.prefixDigest, [{ type: 'plan/mode', seq: prefix.eventCount, mode: 'on' }]).bytes)
  }
  const before = await readFile(f.path), stage = await readFile(f.stage), task = await optionalTask(f.task), cold = actor(f.root)
  const result = await cold.coordinator.resumeChildTarget!(f.request, guards, f.payload)
  expect(['ready', 'already-ready']).not.toContain(result.kind)
  expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.stage)).toEqual(stage)
  expect(await optionalTask(f.task)).toEqual(task)
})
it('keeps original ownership through unknown Task confirmation and resumes without recreating Task data', async () => {
  const f = await partial(), before = await readFile(f.path), task = await readFile(f.task), cold = actor(f.root)
  const stages = confirmation.stages.get(f.task)
  confirmation.path = f.task; confirmation.unknown = true
  expect((await cold.coordinator.resumeChildTarget!(f.request, guards, f.payload)).kind).toBe('blocked')
  expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.task)).toEqual(task)
  const other = actor(f.root)
  await expect(other.coordinator.adoptOwnership('target')).rejects.toThrow()
  confirmation.unknown = false
  expect(['ready', 'already-ready']).toContain((await cold.coordinator.resumeChildTarget!(f.request, guards, f.payload)).kind)
  expect(await readFile(f.task)).toEqual(task); expect(confirmation.stages.get(f.task)).toBe(stages)
})
it('rechecks the original namespace after Task confirmation before any missing batch can issue', async () => {
  const f = await partial(), before = await readFile(f.path), task = await readFile(f.task), cold = actor(f.root)
  const foreign = bootstrapPathsForRoute(f.path, { protocol: 'child-v1', request: { ...f.request, invocation: { ...f.request.invocation, operationId: 'foreign' } } }).stage
  confirmation.path = f.task; confirmation.before = () => writeFile(foreign, Buffer.from('foreign namespace'))
  const result = await cold.coordinator.resumeChildTarget!(f.request, guards, f.payload)
  expect(['ready', 'already-ready']).not.toContain(result.kind)
  expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.task)).toEqual(task)
})

async function crashed(phase: 'seed' | 'complete') {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-native-crash-')); roots.push(root)
  const here = dirname(fileURLToPath(import.meta.url)), workspace = resolve(here, '../../..')
  const child = spawn(process.execPath, [join(workspace, 'node_modules/tsx/dist/cli.mjs'), join(here, 'helpers/crash-bootstrap-frame.mts'), root, phase], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => { stdout += String(value) }); child.stderr.on('data', value => { stderr += String(value) })
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Original native crash did not settle: ' + stdout + stderr)) }, 15000)
    child.once('error', error => { clearTimeout(timer); fail(error) })
    child.once('close', code => { clearTimeout(timer); if (code === 0 && stdout.includes('ORIGINAL_DURABLE_PARTIAL ' + phase)) done(); else fail(new Error('Original native crash failed: ' + code + stdout + stderr)) })
  })
  const input = JSON.parse(await readFile(join(root, 'original-crash-request.json'), 'utf8')) as { request: ReturnType<typeof pair>['request']; payload: ReturnType<typeof pair>['payload'] }
  return { root, ...input, path: join(root, 'target.jsonl'), task: join(root, 'task-target.doc.jsonl') }
}
it.each(['seed', 'complete'] as const)('rejects same-length foreign torn %s bytes before and during actual recovery, then reconciles the original syscall prefix', async phase => {
  const f = await crashed(phase), original = await readFile(f.path), decoded = journal(original)
  expect(decoded.decoded.torn).toBe(true)
  const start = decoded.headerBytes.length + decoded.decoded.prefix.bodyBytes
  const foreign = Buffer.from(original)
  foreign[start + 5] = foreign[start + 5] === 120 ? 121 : 120
  expect(foreign.length).toBe(original.length)
  const task = await readFile(f.task)
  for (const timing of ['before', 'during'] as const) {
    await writeFile(f.path, timing === 'before' ? foreign : original)
    const cold = actor(f.root), append = ownedControls(cold.backend).originalAppend
    let appends = 0
    ownedControls(cold.backend).append = (...args) => { appends++; return append(...args) }
    if (timing === 'during') { confirmation.path = f.task; confirmation.before = () => writeFile(f.path, foreign) }
    const result = await cold.coordinator.resumeChildTarget!(f.request, guards, f.payload)
    expect(['ready', 'already-ready']).not.toContain(result.kind)
    expect(appends).toBe(0); expect(await readFile(f.path)).toEqual(foreign); expect(await readFile(f.task)).toEqual(task)
    await cold.coordinator.close()
  }
  confirmation.path = ''; confirmation.before = undefined
  await writeFile(f.path, original)
  const cold = actor(f.root), append = ownedControls(cold.backend).originalAppend
  let appends = 0
  ownedControls(cold.backend).append = (...args) => { appends++; return append(...args) }
  expect(['ready', 'already-ready']).toContain((await cold.coordinator.resumeChildTarget!(f.request, guards, f.payload)).kind)
  const restored = journal(await readFile(f.path)).decoded
  expect(restored.torn).toBe(false); expect(restored.frames).toHaveLength(2)
  expect(restored.events.filter(event => event.type === 'session/bootstrap')).toHaveLength(1)
  expect(restored.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
  expect(appends).toBe(phase === 'seed' ? 2 : 1)
  expect((await readFile(f.path)).subarray(0, start)).toEqual(original.subarray(0, start))
  expect(await readFile(f.task)).toEqual(task)
// Real child crash plus three independent native proof/reconcile lifetimes.
}, 20000)
it('does not lend a published-prefix byte proof to absence or full-history writers', async () => {
  const f = await partial(), backend = createControlledJsonlBackend(f.root), ownership = createOwnership(backend, { lock: { enabled: true } })
  const claim = await ownership.pinOwnership('target'), original = artifactPathsFor(backend)!
  try {
    const scope = issueHeldTaskDocumentScope(ownership, 'target', claim, { assertActive() { claim.assertHeld() } })
    const capability = createJsonlProcessReadCapability({ root: f.root, file: id => join(f.root, id + '.jsonl'), document: key => join(f.root, key + '.doc.jsonl'), assertOriginal() { original.assertOriginal() }, async checkNamespace() {}, async checkDeleted() {} })
    const proof = await capability.observePublishedTaskParent(scope, async () => 'untrusted data cannot confer writer authority')
    await proof.assertCurrent()
    expect(() => capability.assertFreshOwner(proof, scope)).toThrow()
    expect(() => capability.originalHistory(proof, scope)).toThrow()
    expect(capability.qualifiedHistoryPrefix(proof)).toBeUndefined()
  } finally { await claim.release() }
})

it('rejects a changed observed Task witness without erasing the new durable notification', async () => {
  const f = await partial(), before = await readFile(f.path), cold = actor(f.root)
  const next = Buffer.from(JSON.stringify({ formatVersion: 2, tasks: [], notifications: [{ id: 'changed', submissionId: 'task', parentSessionId: 'target', messageId: 'message', state: 'completed', description: 'durable', text: 'keep', status: 'pending', attempts: 0, timeCreated: 1 }] }) + '\n')
  const append = ownedControls(cold.backend).originalAppend; let appends = 0
  ownedControls(cold.backend).append = (...args) => { appends++; return append(...args) }
  confirmation.path = f.task; confirmation.before = () => writeFile(f.task, next)
  expect(['ready', 'already-ready']).not.toContain((await cold.coordinator.resumeChildTarget!(f.request, guards, f.payload)).kind)
  expect(appends).toBe(0); expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.task)).toEqual(next)
})
