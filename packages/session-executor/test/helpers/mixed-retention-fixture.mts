import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, relative, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import type { TaskResultStore, TaskProtocolDocument } from '@i-harness/subagent'
import type { ContextOutputService } from '@i-harness/context-output'

assert(process.env.IH_CONFIG_DIR, 'IH_CONFIG_DIR must be isolated before imports')
export const evidence = resolve(process.env.IH_MIXED_RETENTION_EVIDENCE_ROOT ?? '.tmp/r4am-tests')
if (existsSync(join(evidence, 'evidence-seal.json')) || existsSync(resolve(evidence, '../../../evidence-seal.json'))) throw new Error('Mixed retention fixture evidence is sealed')
await fs.mkdir(evidence, { recursive: true })
export const { createSessionCoordinator } = await import('@i-harness/session-persistence')
export const { createJsonlBackend } = await import('@i-harness/session-persistence-jsonl')
export const { contextWorkspaceLocation, loadContextOutputConfiguration, createContextOutputService } = await import('@i-harness/context-output')
const { createProjectScopeBroker } = await import('../../../desktop-gateway/src/project-scope.ts')
const { createNativeContextRuntime } = await import('../../../desktop-gateway/src/context-runtime.ts')
const { acquireAssemblyResultStore } = await import('../../src/lifecycle/result-store.ts')
const { createTaskResultRetention } = await import('../../src/lifecycle/task-result-retention.ts')
const { createTaskRegistry, SHIPPING_REPORT_POLICY, taskDocKey } = await import('@i-harness/subagent')
export const { sessionArtifactManifest } = await import('../../../desktop-gateway/src/session-artifacts.ts')
export const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export type Inventory = Record<string, { bytes: number; sha256: string; text?: string }>
export async function inventory(root: string): Promise<Inventory> {
  const rows: Inventory = {}
  async function walk(path: string) {
    let entries
    try { entries = await fs.readdir(path, { withFileTypes: true }) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      const target = join(path, entry.name)
      if (entry.isDirectory()) await walk(target)
      else {
        assert(entry.isFile(), 'independent inventory refuses links')
        const bytes = await fs.readFile(target)
        rows[relative(root, target).replaceAll('\\','/')] = { bytes: bytes.length, sha256: sha(bytes), ...(entry.name.endsWith('.json') || entry.name.endsWith('.pending') ? { text: bytes.toString() } : {}) }
      }
    }
  }
  await walk(root); return rows
}
export const total = (rows: Inventory) => Object.values(rows).reduce((n,row)=>n+row.bytes,0)
export async function save(root: string, name: string, value: unknown) { await fs.writeFile(join(root, name + '.json'), JSON.stringify(value, null, 2)) }
export async function readManaged(service: ContextOutputService, sessionId: string, ref: ManagedArtifactRef, expected: Buffer) {
  let offset = 0; const parts: Buffer[] = [], pages: { offset: number; bytes: number; nextOffset: number | null }[] = []
  for (;;) {
    const page = await service.readResult({ sessionId }, { ref, offset, maxBytes: 8192 })
    assert(page.data.kind === 'text'); const bytes = Buffer.from(page.data.text)
    assert(Buffer.byteLength(JSON.stringify(page)) <= 8192); assert.equal(page.offset, offset); assert.deepEqual(page.ref, ref)
    parts.push(bytes); pages.push({ offset, bytes: bytes.length, nextOffset: page.nextOffset })
    if (page.eof) { assert.equal(page.nextOffset, null); break }
    assert(page.nextOffset! > offset); offset = page.nextOffset!
  }
  const actual = Buffer.concat(parts); assert.deepEqual(actual, expected); assert.equal(actual.length, ref.encodedBytes); assert.equal(sha(actual), ref.contentDigest)
  return { bytes: actual.length, sha256: sha(actual), pages }
}

/** One real supplied native service; a supplied executor lease owns no lifetime. */
export async function nativeFixture(label: string) {
  const root = await fs.mkdtemp(join(evidence, label + '-')), sessions = join(root, 's'), settings = join(root, 'settings.json')
  await fs.mkdir(sessions)
  const location = await contextWorkspaceLocation(root, sessions)
  const ownedRoot = join(location.serviceRoot, 'context-output', sha(location.workspaceKey)), managed = join(ownedRoot, 'managed-v1')
  const projects = ['project-a','project-b'].map(id=>({ id, name: id, roots: [root], primaryRoot: root }))
  let settingsWrites = 0
  async function settingsFor(maxDiskBytes: number, retentionDays = 7.8) {
    const bytes=Buffer.from(JSON.stringify({ contextSubsystems: { contextOutput: { enabled: false, maxDiskBytes: 8388608, retentionDays: 2 }, workspaceOverrides: { [location.workspaceKey]: { contextOutput: { enabled: true, maxDiskBytes, maxCaptureBytes: 1048576, retentionDays } } } } }))
    await fs.writeFile(settings,bytes);await fs.writeFile(join(root,'saved-settings-'+(++settingsWrites)+'.bin'),bytes)
  }
  await settingsFor(2097152)
  let coordinator!: ReturnType<typeof createSessionCoordinator>, broker!: ReturnType<typeof createProjectScopeBroker>, runtime!: Awaited<ReturnType<typeof createNativeContextRuntime>>
  const components: { retire(): Promise<void> }[] = []
  const registries = new Map<string, { tasks: ReturnType<typeof createTaskRegistry>; activate(observation: Observation): void; retire(): Promise<void> }>()
  type Observation = { current: boolean; counts: { captures: number; sourceBindings: number; settles: number; callbacks: number; resultReads: number; errorReads: number }; settlements: Promise<unknown>[]; callback(): void }
  let open = false
  let retirements = 0
  async function mount(fresh = false, confirm = true) {
    assert(!open); coordinator = createSessionCoordinator(createJsonlBackend(sessions), { lock: { enabled: true } })
    if (!fresh) { await coordinator.create({ sessionId: 'a' }); await coordinator.create({ sessionId: 'b' }) }
    broker = createProjectScopeBroker(coordinator, root)
    if (confirm) for (const project of projects) await broker.configure(project)
    if (!fresh) { await broker.bind('a', 'project-a'); await broker.bind('b', 'project-b') }
    const config = await loadContextOutputConfiguration(location.workspaceKey, settings)
    runtime = await createNativeContextRuntime({ workspace: root, storageRoot: join(coordinator.storageRoot!, 'native-context'), coordinator, projectFor: broker.nativeScopeFor, contextConfig: config })
    assert.deepEqual(runtime.contextOutput.status().config, config); assert.equal(runtime.workspaceKey, location.workspaceKey)
    assert.deepEqual(await contextWorkspaceLocation(root, coordinator.storageRoot!), location)
    open = true
    return config
  }
  await mount()
  async function retire() {
    if (!open) return
    for (const component of components) await component.retire()
    await runtime.close(); await broker.close(); await coordinator.close(); open = false
    assert.equal(runtime.contextOutput.status().activeJobs,0);assert.equal(runtime.codeRetrieval.status().activeJobs,0)
    await save(root, 'retirement-'+(++retirements), { nativeCloseResolved: true, brokerCloseResolved: true, coordinatorCloseResolved: true, suppliedReleaseNoop: true, contextStatus:runtime.contextOutput.status(),codeStatus:runtime.codeRetrieval.status() })
  }
  async function task(sessionId: 'a'|'b', label: string, length: number, staged = false) {
    const stateId = sessionId, documentId = taskDocKey(stateId)
    const counts = { captures: 0, sourceBindings: 0, settles: 0, callbacks: 0, resultReads: 0, errorReads: 0 }
    const settlements: Promise<unknown>[] = []
    let callback!: () => void; const terminal = new Promise<void>(done=>{callback=done})
    const observation: Observation = { current: true, counts, settlements, callback }
    let registry = registries.get(sessionId)
    if (!registry) {
      let active = observation
      const observations = new Set<Observation>()
      const lease = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId, contextOutput: runtime.contextOutput, contextOutputSourceFor: runtime.sourceFor, contextOutputSettingsPath: settings })
      assert.equal(lease.service, runtime.contextOutput); assert.equal(lease.sourceFor, runtime.sourceFor)
      const observe = (store: TaskResultStore, selected?: Observation): TaskResultStore => ({ ...store,
        ...(store.forSource ? { async forSource(...args: Parameters<NonNullable<TaskResultStore['forSource']>>) { const original = active; original.counts.sourceBindings++; return observe(await store.forSource!(...args), original) } } : {}),
        capture(...args) { const original = selected ?? active; original.counts.captures++; const capture = store.capture(...args); return { settle() { original.counts.settles++; const pending = capture.settle(); original.settlements.push(pending); return pending } } },
      })
      const callbacks = new Map<string, Observation>()
      const tasks = createTaskRegistry({ coordinator, stateId, reportPolicy: SHIPPING_REPORT_POLICY, results: observe(createTaskResultRetention(lease.service, lease.sourceFor, sessionId, stateId)), onTerminalized(task) { const original = callbacks.get(task.id)!; original.counts.callbacks++; original.callback() } })
      const submit = tasks.submit.bind(tasks)
      tasks.submit = (...args) => { const task = submit(...args); callbacks.set(task.id, active); return task }
      registry = { tasks, activate(next) { active = next; observations.add(next) }, async retire() { for (const original of observations) original.current = false; await tasks.flushPersistence(); await lease.release() } }
      registries.set(sessionId, registry); components.push(registry)
    }
    registry.activate(observation)
    const { tasks } = registry
    const submitted = tasks.submit({ identity: { parentSessionId: sessionId, toolCallId: label }, agentPath: 'root/' + label, description: label, prompt: label, agent: 'general', delivery: 'tool' })
    assert(tasks.claim(submitted.id)); await tasks.flushPersistence(); await tasks.prepareResult(submitted.id, undefined, () => observation.current)
    const baseline = structuredClone(await coordinator.getDocument(documentId)) as TaskProtocolDocument
    assert.equal(baseline.formatVersion,2); assert.equal(baseline.tasks.find(row=>row.id===submitted.id)!.status,'running')
    const baselineBytes = await fs.readFile(join(sessions, documentId + '.doc.jsonl'))
    const transitions: unknown[] = []; let injected = 0
    const nativeRename = fs.rename
    if (staged) {
      fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
        const destination = resolve(String(args[1]))
        const originalDirectory = submitted.result ? join(managed,'ctxv1_'+sha(JSON.stringify([location.workspaceKey,sessionId,submitted.id,submitted.result.revision]))) : undefined
        const selected = originalDirectory !== undefined && dirname(dirname(destination)) === originalDirectory
        const text = selected && basename(dirname(destination)) === 'pins' ? await fs.readFile(String(args[0]), 'utf8') : undefined
        await nativeRename(...args)
        if (text && JSON.parse(text).documentId === documentId) {
          injected++; transitions.push({ destination, transaction: String(args[0]), text, nativeRenameSucceeded: true, acknowledgement: 'lost' })
          throw new Error('controlled first-pin post-native acknowledgement lost')
        }
      }) as typeof fs.rename
      syncBuiltinESMExports()
    }
    const expected = Buffer.from('{"resultText":"' + (sessionId === 'a' ? 'x' : 'y').repeat(length) + '","error":"literal mixed diagnostic"}')
    try {
      assert(tasks.terminalize({ taskId: submitted.id, outcome: 'completed', get resultText() { counts.resultReads++; return (sessionId === 'a' ? 'x' : 'y').repeat(length) }, get error() { counts.errorReads++; return 'literal mixed diagnostic' } }))
      await terminal; await Promise.all(settlements); await tasks.flushPersistence()
    } finally { if (staged) { fs.rename = nativeRename; syncBuiltinESMExports() } }
    const rows = await inventory(managed)
    const selected = Object.entries(rows).find(([path,row])=>path.endsWith('/operation.json') && JSON.parse(row.text!).owner.callId === submitted.id && JSON.parse(row.text!).owner.sessionId === sessionId)!
    assert(selected); const operation = JSON.parse(selected[1].text!)
    assert.equal(operation.owner.documentId, documentId); assert.equal(operation.owner.operationId, submitted.result!.revision)
    const own = await inventory(join(managed, operation.id))
    assert.deepEqual(await fs.readFile(join(managed, operation.id, 'body')), expected)
    assert.equal(sha(expected), operation.ref.contentDigest)
    assert.equal(operation.phase, staged ? 'staged' : 'committed')
    assert.deepEqual(counts, { captures: 1, sourceBindings: 1, settles: 1, callbacks: 1, resultReads: 1, errorReads: 1 })
    if (staged) {
      assert.equal(injected,1); assert.equal(submitted.result!.kind,'pending')
      assert.deepEqual(await fs.readFile(join(sessions, documentId + '.doc.jsonl')), baselineBytes)
      assert.deepEqual(await coordinator.getDocument(documentId),baseline)
      assert.equal(Object.keys(own).filter(path=>path.startsWith('pins/')).length,1)
      observation.current = false
      await registry.retire() // invalidate original component sources and join its no-op supplied lease, without retry
    } else {
      assert.equal(submitted.result!.kind,'retained'); assert.equal(Object.keys(own).filter(path=>path.startsWith('pins/')).length,2)
    }
    await save(root, label, { operation, own, baseline, baselineBase64: baselineBytes.toString('base64'), actualTask: tasks.list(), counts, transitions, expected: { bytes: expected.length, sha256: sha(expected) }, originalAttemptJoined: true, publicationRetry: false })
    return { sessionId, documentId, task: submitted, operation, ref: operation.ref as ManagedArtifactRef, expected, counts, baseline, own }
  }
  return { root, sessions, settings, location, ownedRoot, managed, projects, settingsFor, mount, retire, task,
    get coordinator() { return coordinator }, get broker() { return broker }, get runtime() { return runtime }, get service() { return runtime.contextOutput },
    async legacy(sessionId: 'a'|'b', callId: string, text: string) { return runtime.contextOutput.capture({ sessionId, callId, label: callId, text, complete: true, source: await runtime.sourceFor(sessionId) }) },
    async close() { await retire(); await save(root,'cleanup',{nativeCloseResolved:true,brokerCloseResolved:true,coordinatorCloseResolved:true,open:false,retirements,activeContextJobs:runtime.contextOutput.status().activeJobs,activeCodeJobs:runtime.codeRetrieval.status().activeJobs,activeResourceTypes:process.getActiveResourcesInfo()}) },
  }
}
