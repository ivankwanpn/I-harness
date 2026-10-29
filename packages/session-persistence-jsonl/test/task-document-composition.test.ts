import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskDocumentCoordinator } from '../src/task-document-factory.ts'
import { compileSemanticSeed, type TaskDocumentWitness } from '@i-harness/session-persistence'
import { taskDocumentOperationsFor } from '../../session-persistence/src/coordinator/task-document-association.ts'

it('constructs the original coordinator, Documents owner and JSONL task witness together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-compose-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!; expect(taskDocumentOperationsFor({ ...coordinator })).toBeUndefined()
    const parentToken = operations.parent(parent)
    await expect(operations.begin({ ...parentToken })).rejects.toThrow()
    const operation = await operations.begin(parentToken)
    await expect(operations.begin(parentToken)).rejects.toThrow()
    const observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    expect((await operation.confirm(observed.witness)).kind).toBe('confirmed'); await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains one immutable replacement from the genuine observed document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-write-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    const snapshot = { formatVersion: 2, tasks: [], notifications: [] }, write = operation.stageWrite(observed.witness, snapshot)
    snapshot.formatVersion = 1
    const first = await write.issue(); expect(first.kind).toBe('committed'); expect(await write.issue()).toEqual(first)
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2)
    await coordinator.withProcessReadObservation!('parent', { documentKeys: ['task-parent'] }, async observation => { expect(await write.retry()).toEqual(first); observation.assertCurrent(); return true }, async (value, observation) => { observation.assertCurrent(); return value })
    await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('invalidates an original process reader on the same actual task write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-write-latch-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    const write = operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] })
    await expect(coordinator.withProcessReadObservation!('parent', { documentKeys: ['task-parent'] }, async o => {
      expect((await write.issue()).kind).toBe('committed'); try { o.assertCurrent() } catch {} return 'discard'
    }, async value => value)).rejects.toThrow()
    await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses stage validator self mutations before they poison admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-write-self-')); let staging = false, attempts: Promise<unknown>[] = []
  let coordinator: ReturnType<typeof createJsonlTaskDocumentCoordinator>, parent: Awaited<ReturnType<typeof coordinator.openManagedDocument>>
  const validator = { validate(value: unknown) { taskDocumentStorageContract.validate(value); if (staging) { attempts = [coordinator.putDocumentStrict!('task-parent', value), parent.metadata.admit({ type: 'plan/mode', mode: 'on' }), coordinator.close()]; for (const attempt of attempts) void attempt.catch(() => {}) } } }
  coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, validator)
  try {
    await coordinator.create({ sessionId: 'parent' }); parent = await coordinator.openManagedDocument('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('missing')
    staging = true; const write = operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] }); staging = false
    for (const attempt of attempts) await expect(attempt).rejects.toThrow()
    expect((await write.issue()).kind).toBe('committed'); await operation.close()
    expect((await parent.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('rejects non-JSON snapshots and recursive staging before any candidate is issued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-stage-data-')); let staging = false, recursiveRejected = false
  let operation: Awaited<ReturnType<NonNullable<ReturnType<typeof taskDocumentOperationsFor>>['begin']>>, witness: TaskDocumentWitness
  const validator = { validate(value: unknown) { taskDocumentStorageContract.validate(value); if (staging) { try { operation.stageWrite(witness, value) } catch { recursiveRejected = true } } } }
  const coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, validator)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!; operation = await operations.begin(operations.parent(parent)); const observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('missing'); witness = observed.witness
    const base = () => ({ formatVersion: 2, tasks: [] as unknown[], notifications: [] as unknown[] })
    const sparse = base(); sparse.tasks.length = 1
    const hidden = base(); Object.defineProperty(hidden, 'hidden', { value: 1 })
    const symbol = base(); Object.defineProperty(symbol, Symbol('x'), { value: 1 })
    const cyclic = base(); cyclic.tasks.push(cyclic)
    const accessor = base(); Object.defineProperty(accessor, 'x', { enumerable: true, get() { throw new Error('getter executed') } })
    for (const value of [{ ...base(), bad: undefined }, sparse, hidden, symbol, cyclic, accessor, new Proxy(base(), {})]) expect(() => operation.stageWrite(witness, value)).toThrow()
    staging = true; const write = operation.stageWrite(witness, base()); staging = false; expect(recursiveRejected).toBe(true)
    await expect(write.reconcile()).rejects.toThrow(); expect((await write.issue()).kind).toBe('committed')
    const ack = await write.retry(); expect(ack.kind).toBe('committed'); await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('coordinator close revokes an idle task operation and retires its original lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-close-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    await coordinator.close(); await expect(operation.confirm(observed.witness)).rejects.toThrow(); await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('rejects actual managed self-admission and coordinator close from validator without poisoning the parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-self-managed-'))
  let parent: Awaited<ReturnType<ReturnType<typeof createJsonlTaskDocumentCoordinator>['openManagedDocument']>>, attempted: Promise<unknown>[] = []
  let coordinator: ReturnType<typeof createJsonlTaskDocumentCoordinator>
  const validator = { validate(value: unknown) { taskDocumentStorageContract.validate(value); attempted = [parent.metadata.admit({ type: 'plan/mode', mode: 'on' }), coordinator.close()]; for (const item of attempted) void item.catch(() => {}) } }
  coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, validator)
  try {
    await coordinator.create({ sessionId: 'parent' }); parent = await coordinator.openManagedDocument('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe()
    for (const item of attempted) await expect(item).rejects.toThrow()
    if (observed.kind !== 'present') throw new Error('missing')
    expect((await operation.confirm(observed.witness)).kind).toBe('confirmed'); await operation.close()
    expect((await parent.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([1, 2])('observes absent then validates a literal v%s document in a fresh original operation', async formatVersion => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-version-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent'), operations = taskDocumentOperationsFor(coordinator)!, token = operations.parent(parent)
    const absent = await operations.begin(token); expect(await absent.observe()).toEqual({ kind: 'absent' }); await absent.close()
    await writeFile(join(root, 'task-parent.doc.jsonl'), JSON.stringify({ formatVersion, tasks: [], notifications: [] }))
    const operation = await operations.begin(token), result = await operation.observe(); expect(result.kind).toBe('present')
    if (result.kind === 'present') expect((await operation.confirm(result.witness)).kind).toBe('confirmed')
    await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('rejects an invalid task value without exposing a witness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-invalid-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":3,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent))
    await expect(operation.observe()).rejects.toThrow(); await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not treat a tombstoned task document as absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-tomb-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    const digest = createHash('sha256').update('task-parent').digest('hex'); await writeFile(join(root, `desktop-deleted-document-${digest}.tombstone`), 'parent')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent))
    await expect(operation.observe()).rejects.toThrow(); await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('revoking the original managed parent fences and drains its idle task operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-parent-revoke-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    parent.revokeNewWork(); await expect(operation.confirm(observed.witness)).rejects.toThrow()
    await coordinator.putDocumentStrict!('task-parent', { formatVersion: 2, tasks: [], notifications: [] })
    await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('uses the actual bootstrap READY parent without freezing its later ordinary growth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-bootstrap-parent-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const invocation = { version: 1 as const, operationId: 'task-parent', targetSessionId: 'parent', createdAt: new Date().toISOString(), requestDigest: 'a'.repeat(64) }
  const never = async (): Promise<never> => { throw new Error('no dependency') }
  try {
    const outcome = await coordinator.bootstrapSemanticTarget({ invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'import' }, seed: compileSemanticSeed({ kind: 'none' }) }, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } })
    if (outcome.kind !== 'ready') throw new Error('bootstrap did not reach READY')
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(outcome.document)), observed = await operation.observe()
    expect((await outcome.document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
    if (observed.kind !== 'present') throw new Error('missing')
    expect((await operation.confirm(observed.witness)).kind).toBe('confirmed'); await operation.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('revokes and drains the original operation when its genuine signal aborts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-abort-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent'), operations = taskDocumentOperationsFor(coordinator)!, token = operations.parent(parent)
    await writeFile(join(root, 'task-parent.doc.jsonl'), '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const controller = new AbortController(), operation = await operations.begin(token, { signal: controller.signal }), observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    controller.abort(); await expect(operation.confirm(observed.witness)).rejects.toThrow(); await operation.close()
    const next = await operations.begin(token); await next.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses an equal JSON value with different original bytes and expires copied witnesses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-bytes-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    await expect(operation.confirm({ ...observed.witness })).rejects.toThrow()
    await writeFile(path, '{ "formatVersion":2,"tasks":[],"notifications":[] }')
    expect((await operation.confirm(observed.witness)).kind).toBe('conflict'); await operation.close()
    await expect(operation.confirm(observed.witness)).rejects.toThrow()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
