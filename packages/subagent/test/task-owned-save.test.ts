import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const handoff = vi.hoisted(() => ({ cleanupPath: '', cleanupEntered: undefined as undefined | (() => void), cleanupGate: undefined as undefined | Promise<void>, closeEntered: undefined as undefined | (() => void), closeGate: undefined as undefined | Promise<void>, publications: 0, temps: 0, syncs: 0 }))
vi.mock('../../fs-lock/src/index.ts', async original => {
  const locks = await original<typeof import('../../fs-lock/src/index.ts')>()
  return { ...locks, async acquireSessionLock(options: import('../../fs-lock/src/index.ts').AcquireOptions) {
    const lock = await locks.acquireSessionLock(options)
    return { get held() { return lock.held }, async release() { if (options.lockPath === handoff.cleanupPath && handoff.cleanupGate) { handoff.cleanupEntered?.(); await handoff.cleanupGate }; await lock.release() } }
  } }
})
const fault = vi.hoisted(() => ({ afterRename: false, failFinalClose: false, finalOpens: 0, target: '', tempSynced: undefined as undefined | (() => Promise<void>), entered: undefined as undefined | (() => void), gate: undefined as undefined | Promise<void>, writeEntered: undefined as undefined | (() => void), writeGate: undefined as undefined | Promise<void> }))
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: async (...args: Parameters<typeof fs.open>) => { const handle = await fs.open(...args), close = handle.close.bind(handle), sync = handle.sync.bind(handle), write = handle.write.bind(handle); if (String(args[0]) === fault.target && args[1] === 'r+') { fault.finalOpens++; handle.sync = async () => { handoff.syncs++; await sync() }; handle.close = async () => { if (handoff.closeGate) { handoff.closeEntered?.(); await handoff.closeGate }; if (fault.failFinalClose) throw null; await close() } }; if (String(args[0]).startsWith(fault.target + '.') && args[1] === 'wx') { handoff.temps++; handle.sync = async () => { await sync(); await fault.tempSynced?.() }; handle.write = (async (buffer: Uint8Array, offset: number, length: number, position: number) => { if (fault.writeGate) { fault.writeEntered?.(); await fault.writeGate }; return write(buffer, offset, length, position) }) as typeof handle.write }; return handle }, rename: async (...args: Parameters<typeof fs.rename>) => { await fs.rename(...args); if (String(args[1]) === fault.target) handoff.publications++; if (String(args[1]) === fault.target && fault.gate) { fault.entered?.(); await fault.gate }; if (fault.afterRename && String(args[1]) === fault.target) throw new Error('lost response') } } })
import { createJsonlTaskDocumentCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'
import { TaskPersistence } from '../src/task/persistence.ts'
import { createTaskRegistry } from '../src/task/registry.ts'
import { lastOriginalTaskSave } from '../src/task/save-owner.ts'
import { SHIPPING_REPORT_POLICY } from '../src/report-policy.ts'
import { captureOwnedTaskContext } from '../src/task/owned-context.ts'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createMockClient } from '@i-harness/llm-mock'
import { registerExec } from '@i-harness/exec'
import { registerSubagent } from '../src/index.ts'
import { lockPathFor } from '../../fs-lock/src/index.ts'

it.each(['initial', 'retry'] as const)('rechecks the original %s save after awaiting finish', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-finish-continuation-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), probed = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; handoff.publications = handoff.temps = handoff.syncs = 0
    if (mode === 'retry') fault.failFinalClose = true
    else { handoff.cleanupPath = lockPathFor(root, 'doc:task-parent'); handoff.cleanupEntered = entered.resolve; handoff.cleanupGate = release.promise }
    const original = persistence.captureSave()!
    let completing = original.done; void completing.catch(() => {})
    if (mode === 'retry') {
      await expect(original.done).rejects.toBeNull(); fault.failFinalClose = false
      handoff.cleanupPath = lockPathFor(root, 'doc:task-parent'); handoff.cleanupEntered = entered.resolve; handoff.cleanupGate = release.promise
      completing = original.retry(); void completing.catch(() => {})
    }
    await entered.promise; const committed = original.outcome(); expect(committed?.kind).toBe('committed')
    // All file IO is settled at this native release gate. Keep one bounded
    // continuation queued ahead of the enclosing await's continuation; revoke
    // as soon as the genuine handle proves finish has completed its check.
    let turns = 0, revoked = false
    const probe = () => {
      try { original.assertHandoff() } catch { if (++turns < 128) { queueMicrotask(probe); return }; probed.resolve(); return }
      document.revokeNewWork(); revoked = true; probed.resolve()
    }
    queueMicrotask(probe); release.resolve(); await probed.promise
    expect(revoked).toBe(true); await expect(completing).rejects.toThrow(); await expect(persistence.flush()).rejects.toThrow()
    const after = original.outcome(); expect(after).toMatchObject({ kind: 'committed', cleanupPending: false }); if (committed?.kind === 'committed' && after?.kind === 'committed') expect(after.ack).toBe(committed.ack)
    expect({ publications: handoff.publications, temps: handoff.temps, syncs: handoff.syncs }).toEqual({ publications: 1, temps: 1, syncs: 1 })
  } finally { release.resolve(); fault.failFinalClose = false; fault.target = ''; handoff.cleanupPath = ''; handoff.cleanupGate = undefined; handoff.cleanupEntered = undefined; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['revoked', 'mutated', 'ready'] as const)('checks actual registry parent %s after committed save cleanup', async state => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-handoff-cleanup-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/child', description: 'work', prompt: 'prompt', agent: 'general', delivery: 'tool' }); await registry.flushPersistence()
    task.status = 'completed'; task.outcome = 'completed'; task.resultText = 'original result'
    fault.target = path; handoff.cleanupPath = lockPathFor(root, 'doc:task-parent'); handoff.cleanupEntered = entered.resolve; handoff.cleanupGate = release.promise
    handoff.publications = handoff.temps = handoff.syncs = 0
    const retaining = registry.retainResult(task.id); void retaining.catch(() => {}); await entered.promise
    const original = lastOriginalTaskSave(registry)!, committed = original.outcome(); expect(committed?.kind).toBe('committed')
    if (state === 'revoked') document.revokeNewWork()
    const mutation = state === 'mutated' ? coordinator.putDocumentStrict!('task-parent', { formatVersion: 1, tasks: [], notifications: [] }) : undefined
    release.resolve()
    if (state !== 'ready') {
      await expect(retaining).rejects.toThrow(); expect(task.retention).toBe('failed')
      await expect(original.retry()).rejects.toThrow(); expect(() => original.assertHandoff()).toThrow(); await expect(registry.flushPersistence()).rejects.toThrow()
    } else {
      await retaining; expect(task.retention).toBe('durable'); await original.retry(); original.assertHandoff(); await registry.flushPersistence()
    }
    const after = original.outcome(); expect(after).toMatchObject({ kind: 'committed', cleanupPending: false }); if (committed?.kind === 'committed' && after?.kind === 'committed') expect(after.ack).toBe(committed.ack)
    await mutation
    if (state === 'mutated') { document.assertReady(); expect(JSON.parse(await readFile(path, 'utf8')).tasks).toEqual([]) }
    else expect(JSON.parse(await readFile(path, 'utf8')).tasks).toMatchObject([{ id: task.id, resultText: 'original result' }])
    expect({ publications: handoff.publications, temps: handoff.temps, syncs: handoff.syncs }).toEqual({ publications: state === 'mutated' ? 2 : 1, temps: 1, syncs: 1 })
  } finally { release.resolve(); handoff.cleanupPath = ''; handoff.cleanupGate = undefined; handoff.cleanupEntered = undefined; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps a late committed save refused after external parent close and same-save retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-handoff-close-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; handoff.closeEntered = entered.resolve; handoff.closeGate = release.promise; handoff.publications = handoff.temps = handoff.syncs = 0
    const saving = persistence.save(); void saving.catch(() => {}); await entered.promise
    const closing = document.close(); void closing.catch(() => {}); release.resolve()
    await expect(saving).rejects.toThrow(); await closing
    const original = persistence.lastOwnedSave()!, committed = original.outcome(); expect(committed?.kind).toBe('committed')
    await expect(original.retry()).rejects.toThrow(); await expect(persistence.flush()).rejects.toThrow()
    const after = original.outcome(); expect(after).toMatchObject({ kind: 'committed', cleanupPending: false }); if (committed?.kind === 'committed' && after?.kind === 'committed') expect(after.ack).toBe(committed.ack)
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2)
    expect({ publications: handoff.publications, temps: handoff.temps, syncs: handoff.syncs }).toEqual({ publications: 1, temps: 1, syncs: 1 })
  } finally { release.resolve(); handoff.closeGate = undefined; handoff.closeEntered = undefined; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('checks the exact save again when the actual registry consumes its completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-handoff-consumer-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  let restore: (() => void) | undefined
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/child', description: 'work', prompt: 'prompt', agent: 'general', delivery: 'tool' }); await registry.flushPersistence()
    task.status = 'completed'; task.outcome = 'completed'; task.resultText = 'original result'
    const capture = TaskPersistence.prototype.captureSave
    // Register the competing continuation before the registry awaits this
    // genuine handle. Neither its operation nor its completion is replaced.
    const spy = vi.spyOn(TaskPersistence.prototype, 'captureSave').mockImplementation(function (this: TaskPersistence) {
      const original = Reflect.apply(capture, this, [])
      if (original) void original.done.then(() => document.revokeNewWork(), () => {})
      return original
    }); restore = () => spy.mockRestore()
    await expect(registry.retainResult(task.id)).rejects.toThrow(); expect(task.retention).toBe('failed')
    const original = lastOriginalTaskSave(registry)!; expect(original.outcome()?.kind).toBe('committed'); expect(() => original.assertHandoff()).toThrow()
  } finally { restore?.(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('saves the exact captured original snapshot through the real owned acknowledgment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-save-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, parent = operations.parent(document); operations.assertParentSession(parent, 'parent')
    expect(() => captureOwnedTaskContext(coordinator, document, document.view, 'other')).toThrow()
    const genuine = captureOwnedTaskContext(coordinator, document, document.view, 'parent')!
    const forged = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), { ...genuine })
    await expect(forged.save()).rejects.toThrow('Original task owner unavailable')
    const snapshot = { formatVersion: 2 as const, tasks: [], notifications: [] }, persistence = new TaskPersistence(coordinator, 'parent', true, () => snapshot, captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    const saving = persistence.save(); snapshot.formatVersion = 1 as 2; await saving; await persistence.flush()
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2)
    expect(persistence.lastOwnedSave()?.outcome()?.kind).toBe('committed')
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not let a later save or flush acknowledge the original unknown candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-unknown-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    let snapshot = { formatVersion: 2 as 1 | 2, tasks: [], notifications: [] }, persistence = new TaskPersistence(coordinator, 'parent', true, () => snapshot, captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; fault.afterRename = true; await expect(persistence.save()).rejects.toThrow(); const original = persistence.lastOwnedSave()!
    snapshot = { formatVersion: 1, tasks: [], notifications: [] }; await expect(persistence.save()).rejects.toThrow(); await expect(persistence.flush()).rejects.toThrow()
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2); fault.afterRename = false
    await original.retry(); expect(original.outcome()?.kind).toBe('committed'); await persistence.save(); await persistence.flush()
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(1)
  } finally { fault.afterRename = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('gates a newer already-queued snapshot behind the first uncertain save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-queued-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    let snapshot = { formatVersion: 2 as 1 | 2, tasks: [], notifications: [] }; const persistence = new TaskPersistence(coordinator, 'parent', true, () => snapshot, captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; fault.afterRename = true; fault.entered = entered.resolve; fault.gate = release.promise
    const first = persistence.save(); void first.catch(() => {}); await entered.promise
    const original = persistence.lastOwnedSave()!; snapshot = { formatVersion: 1, tasks: [], notifications: [] }; const second = persistence.save(); void second.catch(() => {})
    fault.gate = undefined; release.resolve(); await expect(first).rejects.toThrow(); await expect(second).rejects.toThrow(); await expect(persistence.flush()).rejects.toThrow()
    expect(persistence.lastOwnedSave()).toBe(original); expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2)
    fault.afterRename = false; await original.retry(); await persistence.flush()
  } finally { fault.gate = undefined; fault.entered = undefined; fault.afterRename = false; release.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not let a later invalid snapshot cancel an earlier queued original save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-invalid-queued-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    let snapshot: { formatVersion: 1 | 2; tasks: never[]; notifications: never[]; bad?: undefined } = { formatVersion: 2, tasks: [], notifications: [] }
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => snapshot, captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; fault.entered = entered.resolve; fault.gate = release.promise
    const first = persistence.save(); await entered.promise; snapshot = { formatVersion: 1, tasks: [], notifications: [], bad: undefined }
    const second = persistence.save(); void second.catch(() => {}); fault.gate = undefined; release.resolve()
    await first; await expect(second).rejects.toThrow(); await expect(persistence.flush()).rejects.toThrow()
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2)
  } finally { fault.gate = undefined; fault.entered = undefined; release.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses an absent task document without initializing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-absent-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent')
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    await expect(persistence.save()).rejects.toThrow(/absent/); await expect(persistence.flush()).rejects.toThrow()
    await expect(readFile(join(root, 'task-parent.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains the exact original save on the actual task registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-registry-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    const row = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/child', description: 'work', prompt: 'original prompt', agent: 'general', delivery: 'tool' })
    await registry.flushPersistence(); const doc = JSON.parse(await readFile(path, 'utf8'))
    expect(doc.tasks).toMatchObject([{ id: row.id, prompt: 'original prompt' }]); expect(lastOriginalTaskSave(registry)?.outcome()?.kind).toBe('committed')
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('uses the actual registerSubagent parent to construct its owned task saver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-register-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const context = createContext(), tools = createToolRegistry(context)
    const subagent = registerSubagent(context, tools, { parentSession: document.view, factOwner: document, parentModel: createMockClient([]), exec: registerExec(context), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), reportPolicy: SHIPPING_REPORT_POLICY, persist: { coordinator, stateId: 'parent', parentSessionId: 'parent' } })
    try {
      const row = subagent.tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/child', description: 'work', prompt: 'owned prompt', agent: 'general', delivery: 'tool' })
      await subagent.tasks.flushPersistence(); expect(JSON.parse(await readFile(path, 'utf8')).tasks).toMatchObject([{ id: row.id, prompt: 'owned prompt' }])
      expect(lastOriginalTaskSave(subagent.tasks)?.outcome()?.kind).toBe('committed')
    } finally { await subagent.dispose() }
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps a specific acknowledged save blocked until its original final handle closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-ack-debt-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; fault.finalOpens = 0; fault.failFinalClose = true
    await expect(persistence.save()).rejects.toBeNull(); const original = persistence.lastOwnedSave()!, outcome = original.outcome()
    expect(outcome).toMatchObject({ kind: 'committed', cleanupPending: true }); expect(fault.finalOpens).toBe(1); await expect(persistence.flush()).rejects.toThrow()
    fault.failFinalClose = false; await original.retry(); expect(fault.finalOpens).toBe(1); const after = original.outcome(); expect(after).toMatchObject({ kind: 'committed', cleanupPending: false }); if (outcome?.kind === 'committed' && after?.kind === 'committed') expect(after.ack).toBe(outcome.ack); await persistence.flush()
  } finally { fault.failFinalClose = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('closes a terminal conflicting save without allowing a later snapshot to replace it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-conflict-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const context = captureOwnedTaskContext(coordinator, document, document.view, 'parent')!, persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), context)
    fault.target = path; fault.tempSynced = async () => { fault.tempSynced = undefined; await writeFile(path, '{ "formatVersion":1,"tasks":[],"notifications":[] }') }
    await expect(persistence.save()).rejects.toThrow(); const original = persistence.lastOwnedSave()!; expect(original.outcome()?.kind).toBe('conflict')
    await expect(original.retry()).rejects.toThrow(); await expect(persistence.save()).rejects.toThrow(); await expect(persistence.flush()).rejects.toThrow()
    const fresh = await context.operations.begin(context.parent); await fresh.close()
  } finally { fault.tempSynced = undefined; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('preserves the original unknown write outcome after external revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-owned-revoke-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; fault.writeEntered = entered.resolve; fault.writeGate = release.promise
    const save = persistence.save(); void save.catch(() => {}); await entered.promise; const original = persistence.lastOwnedSave()!
    const other = coordinator.putDocumentStrict!('task-parent', { formatVersion: 1, tasks: [], notifications: [] }); fault.writeGate = undefined; release.resolve()
    await expect(save).rejects.toThrow(); await other; expect(original.outcome()?.kind).toBe('unknown'); await expect(persistence.flush()).rejects.toThrow()
  } finally { fault.writeGate = undefined; fault.writeEntered = undefined; release.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
