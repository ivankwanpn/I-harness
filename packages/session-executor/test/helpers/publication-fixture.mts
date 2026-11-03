import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ResultFinalization } from '@i-harness/core-tools'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import type { TaskProtocolDocument, TaskResultStore } from '@i-harness/subagent'
import type { ResultArtifactScope, ResultArtifactSink } from '@i-harness/context-output'
import { hash } from './publication-native.mts'

export const parent = 'publication-parent'
export const literalError = 'fixed original diagnostic'
export const bodyLength = 262144
export const expectedBody = (length = bodyLength) => Buffer.from('{"resultText":"' + 'x'.repeat(length) + '","error":"fixed original diagnostic"}')
export interface InventoryRow { bytes: number; sha256: string; text?: string }
export type Inventory = Record<string, InventoryRow>
export async function inventory(directory: string): Promise<Inventory> {
  const files: Inventory = {}
  async function visit(path: string) {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.i-harness-locks') continue
      const target = join(path, entry.name)
      if (entry.isDirectory()) { await visit(target); continue }
      assert(entry.isFile(), 'test inventory refuses links')
      const bytes = await readFile(target)
      files[relative(directory, target).replaceAll('\\', '/')] = { bytes: bytes.length, sha256: hash(bytes), ...(entry.name.endsWith('.json') || entry.name.endsWith('.pending') ? { text: bytes.toString('utf8') } : {}) }
    }
  }
  await visit(directory); return files
}
export function originalOperation(files: Inventory) {
  const rows = Object.entries(files).filter(([path]) => path.endsWith('/operation.json'))
  assert.equal(rows.length, 1)
  const [path, row] = rows[0]!
  const operation = JSON.parse(row.text!) as { id: string; phase: string; encodedBytes: number; reason?: string; owner: { operationId: string; sessionId: string; callId: string; documentId: string; source: { sourceId: string } }; ref?: ManagedArtifactRef; manifest?: unknown }
  return { path, operation }
}
export function assertPins(files: Inventory, taskDocument: string, cutIndex: number) {
  const pins = Object.entries(files).filter(([path]) => path.includes('/pins/')).map(([, row]) => JSON.parse(row.text!) as { documentId: string; sessionId: string; operationId: string; revision: string; state: string })
  const access = Object.entries(files).filter(([path]) => path.includes('/access/')).map(([, row]) => JSON.parse(row.text!) as { sessionId: string; revision: string; pinId: string })
  const operation = originalOperation(files).operation
  assert.deepEqual(pins.map(pin => pin.documentId).sort(), (cutIndex >= 8 ? [taskDocument, parent] : cutIndex >= 5 ? [taskDocument] : []).sort())
  assert.equal(access.length, cutIndex >= 6 ? 1 : 0)
  for (const pin of pins) {
    assert.equal(pin.state, 'pending'); assert.equal(pin.sessionId, parent)
    assert.equal(pin.operationId, operation.owner.operationId); assert.equal(pin.revision, operation.ref!.revision)
  }
  if (access[0]) {
    assert.equal(access[0].sessionId, parent); assert.equal(access[0].revision, operation.ref!.revision)
    assert.equal(access[0].pinId, hash(cutIndex >= 9 ? parent : taskDocument))
  }
}
export async function readAll(service: NonNullable<Awaited<ReturnType<typeof createFixture>>['lease']['service']>, ref: ManagedArtifactRef, expected: Buffer) {
  const chunks: Buffer[] = [], pages: { offset: number; nextOffset: number | null; bytes: number }[] = []
  let offset = 0
  for (;;) {
    const page = await service.readResult({ sessionId: parent }, { ref, offset, maxBytes: 16384 })
    assert.equal(page.offset, offset); assert.deepEqual(page.ref, ref); assert.equal(page.data.kind, 'text')
    assert(page.data.kind === 'text')
    const chunk = Buffer.from(page.data.text)
    assert(chunk.length <= 16384); chunks.push(chunk); pages.push({ offset, nextOffset: page.nextOffset, bytes: chunk.length })
    if (page.eof) { assert.equal(page.nextOffset, null); break }
    assert(typeof page.nextOffset === 'number' && page.nextOffset > offset); offset = page.nextOffset
  }
  const bytes = Buffer.concat(chunks)
  assert.deepEqual(bytes, expected); assert.equal(hash(bytes), ref.contentDigest); assert.equal(bytes.length, ref.encodedBytes)
  assert(pages.length > 1)
  return { pages, bytes: bytes.length, sha256: hash(bytes) }
}
export async function createFixture(root: string, length = bodyLength, maxDiskBytes?: number) {
  assert(process.env.IH_CONFIG_DIR, 'gate config before runtime imports')
  const { createSessionCoordinator } = await import('@i-harness/session-persistence')
  const { createJsonlBackend } = await import('@i-harness/session-persistence-jsonl')
  const { createTaskRegistry, taskDocKey, SHIPPING_REPORT_POLICY } = await import('@i-harness/subagent')
  const { acquireAssemblyResultStore } = await import('../../src/lifecycle/result-store.ts')
  const { createTaskResultRetention } = await import('../../src/lifecycle/task-result-retention.ts')
  const { contextWorkspaceLocation } = await import('@i-harness/context-output')
  const store = join(root, 'sessions'), settings = join(process.env.IH_CONFIG_DIR!, 'settings.json')
  await mkdir(store, { recursive: true })
  if (maxDiskBytes !== undefined) await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { maxDiskBytes } } }))
  const coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
  const created = await coordinator.create({ sessionId: parent }); assert.equal(created.id, parent)
  const taskDocument = taskDocKey(parent), documentPath = join(store, taskDocument + '.doc.jsonl')
  let componentOpen = true
  const current = () => componentOpen && coordinator.ownerOf(parent)
  assert(current())
  const lease = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: parent, contextOutputSettingsPath: settings, executionCallerAvailable: current })
  assert(lease.service && lease.sourceFor)
  const count = { captures: 0, resultTextReads: 0, errorReads: 0, terminalCallbacks: 0, sourceBindings: 0 }
  const authority = { registrations: 0, begins: 0, sameScope: true, sameSink: true, codec: '' }
  let scope: ResultArtifactScope | undefined, sink: ResultArtifactSink | undefined
  const register = lease.service.registerResultScope.bind(lease.service), begin = lease.service.beginResult.bind(lease.service)
  lease.service.registerResultScope = (...args) => {
    authority.registrations++
    const actual = register(...args)
    if (scope && scope !== actual) authority.sameScope = false
    scope = actual; return actual
  }
  lease.service.beginResult = async (...args) => {
    authority.begins++; authority.sameScope &&= args[0] === scope; authority.codec = args[1]
    const actual = await begin(...args)
    if (sink && sink !== actual) authority.sameSink = false
    sink = actual; return actual
  }
  let capture: ResultFinalization | undefined, operationId: string | undefined, capturedBody: object | undefined
  const captures: ResultFinalization[] = []
  let terminalizedResolve!: () => void
  const terminalized = new Promise<void>(accept => { terminalizedResolve = accept })
  const observe = (store: TaskResultStore): TaskResultStore => ({ ...store,
    ...(store.forSource ? { async forSource(...args: Parameters<NonNullable<TaskResultStore['forSource']>>) { count.sourceBindings++; return observe(await store.forSource!(...args)) } } : {}),
    capture(...args) { count.captures++; operationId = args[2]; capturedBody = args[1]; capture = store.capture(...args); captures.push(capture); return capture },
  })
  const results = observe(createTaskResultRetention(lease.service, lease.sourceFor, parent))
  const tasks = createTaskRegistry({ coordinator, stateId: parent, reportPolicy: SHIPPING_REPORT_POLICY, results, onTerminalized() { count.terminalCallbacks++; terminalizedResolve() } })
  const task = tasks.submit({ identity: { parentSessionId: parent, toolCallId: 'original-component-call' }, agentPath: 'root/publication', description: 'original publication', prompt: 'fixed component result', agent: 'general', delivery: 'tool' })
  assert(tasks.claim(task.id)); await tasks.flushPersistence(); await tasks.prepareResult(task.id, undefined, current)
  const baseline = structuredClone(await coordinator.getDocument(taskDocument)) as TaskProtocolDocument
  assert.equal(baseline?.formatVersion, 2); assert.equal(baseline.tasks.length, 1)
  assert.equal(baseline.tasks[0]!.id, task.id); assert.equal(baseline.tasks[0]!.status, 'running')
  assert.equal(baseline.tasks[0]!.outcome, undefined); assert.equal(baseline.tasks[0]!.result, undefined)
  const baselineBytes = await readFile(documentPath)
  assert.deepEqual(JSON.parse(baselineBytes.toString()), baseline)
  await writeFile(join(root, 'baseline.bin'), baselineBytes)
  const location = await contextWorkspaceLocation(root, store)
  return { root, store, settings, coordinator, taskDocument, documentPath, lease, tasks, task, count, authority, captures, terminalized, baseline, baselineBytes, location, expected: expectedBody(length),
    get capture() { return capture }, get operationId() { return operationId }, get capturedBody() { return capturedBody }, current,
    terminalize() {
      assert(tasks.terminalize({ taskId: task.id, outcome: 'completed', get resultText() { count.resultTextReads++; return 'x'.repeat(length) }, get error() { count.errorReads++; return literalError } }))
    },
    closeComponent() { componentOpen = false },
    async assertBaseline() { assert.deepEqual(await coordinator.getDocument(taskDocument), baseline); assert.deepEqual(await readFile(documentPath), baselineBytes) },
    async close() { componentOpen = false; await tasks.flushPersistence(); await lease.release(); await coordinator.close() },
  }
}
