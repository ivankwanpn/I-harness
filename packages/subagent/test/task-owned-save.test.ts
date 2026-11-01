import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
const handoff = vi.hoisted(() => ({ cleanupPath: '', cleanupEntered: undefined as undefined | (() => void), cleanupGate: undefined as undefined | Promise<void>, closeEntered: undefined as undefined | (() => void), closeGate: undefined as undefined | Promise<void>, publications: 0, temps: 0, syncs: 0, releases:0, closeCalls:0, acquireFails:'', heldFails:'', releaseFails:'' }))
vi.mock('../../fs-lock/src/index.ts', async original => {
  const locks = await original<typeof import('../../fs-lock/src/index.ts')>()
  return { ...locks, async acquireSessionLock(options: import('../../fs-lock/src/index.ts').AcquireOptions) {
    if(options.lockPath===handoff.acquireFails)throw null
    const lock = await locks.acquireSessionLock(options)
    return { get held() { if(options.lockPath===handoff.heldFails)throw 0; return lock.held }, async release() { if(options.lockPath===handoff.cleanupPath){handoff.releases++;if(options.lockPath===handoff.releaseFails)throw false}; if (options.lockPath === handoff.cleanupPath && handoff.cleanupGate) { handoff.cleanupEntered?.(); await handoff.cleanupGate }; await lock.release() } }
  } }
})
const fault = vi.hoisted(() => ({ afterRename: false, failFinalClose: false, finalOpens: 0, target: '', tempSynced: undefined as undefined | (() => Promise<void>), entered: undefined as undefined | (() => void), gate: undefined as undefined | Promise<void>, writeEntered: undefined as undefined | (() => void), writeGate: undefined as undefined | Promise<void> }))
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: async (...args: Parameters<typeof fs.open>) => { const handle = await fs.open(...args), close = handle.close.bind(handle), sync = handle.sync.bind(handle), write = handle.write.bind(handle); if (String(args[0]) === fault.target && args[1] === 'r+') { fault.finalOpens++; handle.sync = async () => { handoff.syncs++; await sync() }; handle.close = async () => { handoff.closeCalls++; if (handoff.closeGate) { handoff.closeEntered?.(); await handoff.closeGate }; if (fault.failFinalClose) throw null; await close() } }; if (String(args[0]).startsWith(fault.target + '.') && args[1] === 'wx') { handoff.temps++; handle.sync = async () => { await sync(); await fault.tempSynced?.() }; handle.write = (async (buffer: Uint8Array, offset: number, length: number, position: number) => { if (fault.writeGate) { fault.writeEntered?.(); await fault.writeGate }; return write(buffer, offset, length, position) }) as typeof handle.write }; return handle }, rename: async (...args: Parameters<typeof fs.rename>) => { await fs.rename(...args); if (String(args[1]) === fault.target) handoff.publications++; if (String(args[1]) === fault.target && fault.gate) { fault.entered?.(); await fault.gate }; if (fault.afterRename && String(args[1]) === fault.target) throw new Error('lost response') } } })
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'
import { TaskPersistence } from '../src/task/persistence.ts'
import { createTaskRegistry } from '../src/task/registry.ts'
import { createSpawnSource } from '../src/tools/spawn-source.ts'
import { createNondurableFactOwner, createSession } from '@i-harness/core-session'
import { lastOriginalTaskSave } from '../src/task/save-owner.ts'
import { SHIPPING_REPORT_POLICY } from '../src/report-policy.ts'
import { captureOwnedTaskContext } from '../src/task/owned-context.ts'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createMockClient } from '@i-harness/llm-mock'
import { registerExec } from '@i-harness/exec'
import { registerSubagent } from '../src/index.ts'
import { lockPathFor } from '../../fs-lock/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { artifactPathsFor } from '../../session-persistence/src/coordinator/artifact-path-association.ts'

// Select the actual temporary lease for fault injection, retaining the original native hooks.
function taskLeasePath(root: string): string {
  const capture = artifactPathsFor(createJsonlBackend(root))!.document('task-parent')
  if (capture.kind !== 'ready') throw new Error('Task fixture document directory is unavailable')
  return lockPathFor(root, 'artifact-document-lease:' + capture.key)
}

it.each(['initial', 'retry'] as const)('rechecks the original %s save after awaiting finish', async mode => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-finish-continuation-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), probed = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; handoff.publications = handoff.temps = handoff.syncs = 0
    if (mode === 'retry') fault.failFinalClose = true
    else { handoff.cleanupPath = taskLeasePath(root); handoff.cleanupEntered = entered.resolve; handoff.cleanupGate = release.promise }
    const original = persistence.captureSave()!
    let completing = original.done; void completing.catch(() => {})
    if (mode === 'retry') {
      await expect(original.done).rejects.toBeNull(); fault.failFinalClose = false
      handoff.cleanupPath = taskLeasePath(root); handoff.cleanupEntered = entered.resolve; handoff.cleanupGate = release.promise
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
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-handoff-cleanup-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    await registry.ready
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/child', description: 'work', prompt: 'prompt', agent: 'general', delivery: 'tool' }); await registry.flushPersistence()
    task.status = 'completed'; task.outcome = 'completed'; task.resultText = 'original result'
    fault.target = path; handoff.cleanupPath = taskLeasePath(root); handoff.cleanupEntered = entered.resolve; handoff.cleanupGate = release.promise
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
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-handoff-close-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
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
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-handoff-consumer-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  let restore: (() => void) | undefined
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    await registry.ready
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
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-save-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
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
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-unknown-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    let snapshot = { formatVersion: 2 as 1 | 2, tasks: [], notifications: [] }, persistence = new TaskPersistence(coordinator, 'parent', true, () => snapshot, captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; fault.afterRename = true; await expect(persistence.save()).rejects.toThrow(); const original = persistence.lastOwnedSave()!
    snapshot = { formatVersion: 1, tasks: [], notifications: [] }; const blocked = persistence.captureSave()!; await expect(blocked.done).rejects.toThrow(); await expect(persistence.flush()).rejects.toThrow()
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2); fault.afterRename = false
    await original.retry(); expect(original.outcome()?.kind).toBe('committed'); await blocked.retry(); await persistence.flush()
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(1)
  } finally { fault.afterRename = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('gates a newer already-queued snapshot behind the first uncertain save', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-queued-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    let snapshot = { formatVersion: 2 as 1 | 2, tasks: [], notifications: [] }; const persistence = new TaskPersistence(coordinator, 'parent', true, () => snapshot, captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; fault.afterRename = true; fault.entered = entered.resolve; fault.gate = release.promise
    const first = persistence.save(); void first.catch(() => {}); await entered.promise
    const original = persistence.lastOwnedSave()!; snapshot = { formatVersion: 1, tasks: [], notifications: [] }; const second = persistence.captureSave()!; void second.done.catch(() => {})
    fault.gate = undefined; release.resolve(); await expect(first).rejects.toThrow(); await expect(second.done).rejects.toThrow(); await expect(persistence.flush()).rejects.toThrow()
    expect(persistence.lastOwnedSave()).toBe(original); expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2)
    fault.afterRename = false; await original.retry(); await second.retry(); await persistence.flush()
  } finally { fault.gate = undefined; fault.entered = undefined; fault.afterRename = false; release.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not let a later invalid snapshot cancel an earlier queued original save', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-invalid-queued-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
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
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-absent-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'); await unlink(join(root, 'task-parent.doc.jsonl'))
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: 2, tasks: [], notifications: [] }), captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    await expect(persistence.save()).rejects.toThrow(/absent/); await expect(persistence.flush()).rejects.toThrow()
    await expect(readFile(join(root, 'task-parent.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains the exact original save on the actual task registry', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-registry-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    await registry.ready
    const row = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/child', description: 'work', prompt: 'original prompt', agent: 'general', delivery: 'tool' })
    await registry.flushPersistence(); const doc = JSON.parse(await readFile(path, 'utf8'))
    expect(doc.tasks).toMatchObject([{ id: row.id, prompt: 'original prompt' }]); expect(lastOriginalTaskSave(registry)?.outcome()?.kind).toBe('committed')
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('uses the actual registerSubagent parent to construct its owned task saver', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-register-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const context = createContext(), tools = createToolRegistry(context)
    const subagent = registerSubagent(context, tools, { parentSession: document.view, factOwner: document, parentModel: createMockClient([]), exec: registerExec(context), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), reportPolicy: SHIPPING_REPORT_POLICY, persist: { coordinator, stateId: 'parent', parentSessionId: 'parent' } })
    try {
      await subagent.ready
      const row = subagent.tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/child', description: 'work', prompt: 'owned prompt', agent: 'general', delivery: 'tool' })
      await subagent.tasks.flushPersistence(); expect(JSON.parse(await readFile(path, 'utf8')).tasks).toMatchObject([{ id: row.id, prompt: 'owned prompt' }])
      expect(lastOriginalTaskSave(subagent.tasks)?.outcome()?.kind).toBe('committed')
    } finally { await subagent.dispose() }
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps a specific acknowledged save blocked until its original final handle closes', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-ack-debt-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
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
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-conflict-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
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
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-owned-revoke-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
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

it('resumes three original captures in writer order after cleanup debt', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-task-ordered-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    let version: 1 | 2 = 2
    const persistence = new TaskPersistence(coordinator, 'parent', true, () => ({ formatVersion: version, tasks: [], notifications: [] }), captureOwnedTaskContext(coordinator, document, document.view, 'parent'))
    fault.target = path; fault.failFinalClose = true; handoff.publications = handoff.temps = handoff.syncs = 0
    const first = persistence.captureSave()!; void first.done.catch(() => {})
    version = 1; const second = persistence.captureSave()!; void second.done.catch(() => {})
    version = 2; const third = persistence.captureSave()!; void third.done.catch(() => {})
    await expect(first.done).rejects.toBeNull(); await expect(second.done).rejects.toThrow(); await expect(third.done).rejects.toThrow()
    await expect(third.retry()).rejects.toThrow(); expect(handoff.publications).toBe(1)
    fault.failFinalClose = false; await first.retry(); first.assertHandoff()
    await expect(third.retry()).rejects.toThrow(); expect(handoff.publications).toBe(1)
    version = 2; await second.retry(); second.assertHandoff()
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(1)
    await third.retry(); third.assertHandoff(); await persistence.flush()
    expect(JSON.parse(await readFile(path, 'utf8')).formatVersion).toBe(2)
    expect(handoff.publications).toBe(3)
  } finally { fault.failFinalClose = false; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['terminal-before', 'terminal-after'] as const)('foreground route CAS chooses one original route: %s', async timing => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-route-cas-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    await registry.ready
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/a', description: 'work', prompt: 'prompt', agent: 'general', delivery: 'tool' }); await registry.flushPersistence()
    const begin = registry.bindForegroundHandoff(task.id)
    if (timing === 'terminal-before') registry.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'done' })
    const route = begin(); expect(begin()).toBe(route)
    if (timing === 'terminal-after') {
      expect(route.kind).toBe('parent'); registry.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'done' })
      if (route.kind === 'parent') { await route.save.done; route.save.assertHandoff(); route.save.release() }
      await vi.waitFor(() => expect(registry.notifications()).toHaveLength(1))
      expect(registry.notifications()[0]?.submissionId).toBe(task.id)
    } else { expect(route.kind).toBe('ready'); expect(registry.notifications()).toHaveLength(0) }
    await registry.flushPersistence()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps terminal snapshot behind the original held foreground handoff save', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-route-gate-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    await registry.ready
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/a', description: 'work', prompt: 'prompt', agent: 'general', delivery: 'tool' }); await registry.flushPersistence()
    fault.target = path; handoff.closeEntered = entered.resolve; handoff.closeGate = release.promise
    const route = registry.bindForegroundHandoff(task.id)(); if (route.kind !== 'parent') throw new Error('expected parent')
    await entered.promise; registry.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'original terminal' })
    expect(registry.notifications()).toHaveLength(1); expect(task.retention).not.toBe('durable')
    handoff.closeGate = undefined; release.resolve(); await route.save.done; route.save.assertHandoff(); route.save.release()
    await vi.waitFor(() => expect(task.retention).toBe('durable')); await registry.flushPersistence()
    const saved = JSON.parse(await readFile(path, 'utf8')); expect(saved.tasks[0]).toMatchObject({ delivery: 'parent', outcome: 'completed', resultText: 'original terminal' }); expect(saved.notifications).toHaveLength(1)
  } finally { release.resolve(); handoff.closeGate = undefined; handoff.closeEntered = undefined; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('resumes the original terminal save after the handoff close debt clears', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-route-debt-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    await registry.ready
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/a', description: 'work', prompt: 'prompt', agent: 'general', delivery: 'tool' }); await registry.flushPersistence()
    fault.target = path; fault.failFinalClose = true; handoff.closeEntered = entered.resolve; handoff.closeGate = release.promise
    const route = registry.bindForegroundHandoff(task.id)(); if (route.kind !== 'parent') throw new Error('expected parent'); void route.save.done.catch(() => {})
    await entered.promise; registry.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'terminal body' }); handoff.closeGate = undefined; release.resolve()
    await expect(route.save.done).rejects.toBeNull(); expect(task.retention).not.toBe('durable')
    expect(registry.notifications()).toHaveLength(1); expect(() => route.save.assertHandoff()).toThrow()
    await vi.waitFor(() => expect(task.retention).toBe('failed'))
    fault.failFinalClose = false; await route.save.retry(); route.save.assertHandoff()
    const terminalSave = lastOriginalTaskSave(registry)!
    expect(terminalSave).not.toBe(route.save)
    await expect(terminalSave.retry()).rejects.toThrow('Earlier owned task save requires resolution')
    expect(JSON.parse(await readFile(path, 'utf8')).tasks[0].outcome).toBeUndefined()
    route.save.release()
    await registry.retainResult(task.id); expect(task.retention).toBe('durable'); await registry.flushPersistence()
    const saved = JSON.parse(await readFile(path, 'utf8')); expect(saved.tasks[0]).toMatchObject({ delivery: 'parent', outcome: 'completed', resultText: 'terminal body' }); expect(saved.notifications).toHaveLength(1)
  } finally { release.resolve(); fault.failFinalClose = false; handoff.closeGate = undefined; handoff.closeEntered = undefined; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('original spawn source retains its delivery guard until both handoff and terminal saves settle', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-source-barrier-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let source: ReturnType<typeof createSpawnSource> | undefined
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    await registry.ready
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/a', description: 'work', prompt: 'prompt', agent: 'general', delivery: 'tool' }); await registry.flushPersistence()
    let signals = 0
    const retained = { beforeRead: vi.fn(), observed: vi.fn(), progress: vi.fn(), unavailable: vi.fn(), requireRecovery: vi.fn(), ready: vi.fn() }
    source = createSpawnSource(createNondurableFactOwner(createSession()), undefined, retained, false, () => { signals++ })
    source.bindTask(task.id, () => registry.retainResult(task.id)); source.bindHandoff(registry.bindForegroundHandoff(task.id))
    await source.start({ type: 'subagent/start', version: 1, taskId: task.id, parentSessionId: 'parent', agentPath: 'root/a', role: 'general', description: 'work' })
    source.published({ path: 'root/a', jobId: 'job-a' }); registry.claim(task.id, 'child', undefined, 'job-a'); await registry.flushPersistence()
    fault.target = path; handoff.closeEntered = entered.resolve; handoff.closeGate = release.promise
    const handed = source.handoffToParent(); void handed.catch(() => {}); await entered.promise
    registry.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'terminal body' }); source.settling()
    const ending = source.prepareEnd(async () => ({ event: { type: 'subagent/end', version: 1, taskId: task.id, outcome: 'completed' } })); void ending.catch(() => {})
    expect(signals).toBe(0); source.recoverPublished(new Error('held handoff')); expect(retained.unavailable).toHaveBeenCalled(); expect(retained.ready).not.toHaveBeenCalled(); handoff.closeGate = undefined; release.resolve()
    expect(await handed).toBe('parent'); source.assertHandoff(); source.consumeHandoff(); await ending
    expect(signals).toBe(1); expect(registry.notifications()).toHaveLength(1)
  } finally { source?.finish(); release.resolve(); handoff.closeGate = undefined; handoff.closeEntered = undefined; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('joins original terminal retention while a later writer capture is queued', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-terminal-consumer-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
    await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const registry = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ownedTask: captureOwnedTaskContext(coordinator, document, document.view, 'parent') })
    await registry.ready
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/a', description: 'work', prompt: 'prompt', agent: 'general', delivery: 'parent' }); await registry.flushPersistence()
    task.status = 'completed'; task.outcome = 'completed'; task.resultText = 'original terminal'
    fault.target = path; handoff.cleanupPath = taskLeasePath(root); handoff.cleanupEntered = entered.resolve; handoff.cleanupGate = release.promise
    handoff.publications = 0
    const retaining = registry.retainResult(task.id); void retaining.catch(() => {}); await entered.promise
    const original = lastOriginalTaskSave(registry)!
    task.description = 'later captured mutation'
    const later = registry.save(); void later.catch(() => {})
    // The source and announcement both ask to retain the same result. They
    // must join its consumer, not flush a subsequent snapshot over its ack.
    const joining = registry.retainResult(task.id)
    void joining.catch(() => {})
    expect(task.retention).toBe('pending'); expect(handoff.publications).toBe(1)
    handoff.cleanupGate = undefined; release.resolve()
    await retaining; await joining; await later; await registry.flushPersistence()
    expect(task.retention).toBe('durable')
    expect(original.outcome()).toMatchObject({ kind: 'committed', cleanupPending: false })
    expect(JSON.parse(await readFile(path, 'utf8')).tasks[0]).toMatchObject({ resultText: 'original terminal', description: 'later captured mutation' })
    expect(handoff.publications).toBe(2)
  } finally { release.resolve(); fault.target = ''; handoff.cleanupPath = ''; handoff.cleanupGate = undefined; handoff.cleanupEntered = undefined; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
import { createSpawnTool } from '../src/tools/spawn.ts'
import { createRoleRegistry } from '../src/roles.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { createAgentRegistry } from '@i-harness/core-agent'
import { receivedInputsFor } from '../../session-executor/src/lifecycle/received-inputs.ts'
import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'

async function foregroundFixture(owned: boolean, custom = false, deadline = false) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-actual-handoff-'))
  const base = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const coordinator = custom ? { ...base } : base
  await coordinator.create({ sessionId: 'parent' })
  const document = await coordinator.openManagedDocument('parent'), path = join(root, 'task-parent.doc.jsonl')
  if (owned) await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
  const tasks = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, ...(owned ? { ownedTask: captureOwnedTaskContext(base, document, document.view, 'parent') } : {}) })
  if (!custom) await tasks.ready
  const context = createContext(), tools = createToolRegistry(context), table = createAgentTable(), roles = createRoleRegistry()
  roles.register({ name: 'probe', description: '', systemPrompt: 'probe', tools: [] })
  const received = receivedInputsFor(document, 'parent')
  await received.inbox.admit({ inputId: 'human', text: 'launch original', intent: 'user', delivery: 'queue', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })
  const action = document.beginAction()
  const out = await action.facts.tools.call({ type: 'tool/call', callId: 'original', name: 'spawn_agent', args: { background: false } })
  const { committedFactSeqs } = await import('@i-harness/core-session')
  const [callSeq] = committedFactSeqs(out)
  committedFactSeqs(await action.facts.tools.dispatch('original', { kind: 'prior', seq: callSeq!, expectedType: 'tool/call' }))
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  let launches = 0, hints = 0, unregisters = 0, bound = 0
  let source: { reconcileTerminal(): Promise<void> } | undefined
  const spawn = createSpawnTool({ generationFactoryFor: fixtureGenerationFor, tasks, table, roles, jobs: createJobRegistry(), parentCtx: context, parentRegistry: tools,
    parentSession: document.view, factOwner: document, childSessions: { coordinator, parentSessionId: 'parent' }, agents: createAgentRegistry(), exec: {} as import('@i-harness/exec').ExecService,
    parentModel: controlledModel(async function* () { launches++; started.resolve(); await finish.promise; yield { type: 'text/chunk', text: 'actual original terminal' }; yield { type: 'end' } }),
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), notificationNamespace: 'original', ...(deadline ? { foregroundWaitMs: 0 } : {}),
    parentNotify: { admit: async () => {}, wake() {}, async prepareTaskDelivery(input) { const result = await received.delivery.prepareLaunch(input.namespace, input.taskId, input.callSeq); if (result.kind === 'bound') bound++; return result } },
    registerDeliverySource(_id, original) { source = original; return () => { unregisters++ } }, onTaskTerminalCommitted() { hints++ },
  })
  return { root, path, document, tasks, table, started, finish, received, counts: () => ({ launches, hints, unregisters, bound }), source: () => source!,
    run: (code = false) => spawn.execute({ task_name: 'held', message: 'original', agent_type: 'probe', background: false }, { session: document.view, sessionId: 'parent', callEventSeq: callSeq!, callId: 'original', ...(code ? { resultConsumer: 'code' as const } : {}) }),
    async close() { finish.resolve(); for (const entry of table.entries().values()) await entry.followupChain?.catch(() => {}); action.finish(); await coordinator.close(); await context.scope.unmount(); await rm(root, { recursive: true, force: true }) },
  }
}

it.each([{ custom: false, deadline: false }, { custom: false, deadline: true }, { custom: true, deadline: false }, { custom: true, deadline: true }])('actual bound unsupported foreground preserves manual ID return $custom/$deadline', async ({ custom, deadline }) => {
  const f = await foregroundFixture(false, custom, deadline)
  const running = f.run(); void running.catch(() => {})
  try {
    await f.started.promise
    if (!deadline) await f.received.inbox.admit({ inputId: 'steer', text: 'refocus', intent: 'user', delivery: 'steer', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })
    expect(await running).toMatchObject({ task_id: 'task-1', agent_path: 'root/held', timed_out: deadline, ...(!deadline ? { yielded: true, yield_reason: 'user-steer' } : {}) })
    expect(f.counts()).toMatchObject({ launches: 1, bound: 1 })
    expect(f.tasks.get('task-1')).toMatchObject({ delivery: 'tool' }); expect(f.tasks.get('task-1')!.outcome).toBeUndefined()
    f.finish.resolve(); await f.table.get('root/held')!.followupChain
    expect(f.tasks.get('task-1')).toMatchObject({ delivery: 'tool', outcome: 'completed', resultText: 'actual original terminal' }); expect(f.tasks.notifications()).toEqual([])
  } finally { f.finish.resolve(); await running.catch(() => {}); await f.close() }
})

it('actual nested code foreground remains unbound and returns its original deadline IDs', async () => {
  const f = await foregroundFixture(false, true, true)
  try { expect(await f.run(true)).toMatchObject({ task_id: 'task-1', timed_out: true }); await f.started.promise; expect(f.counts()).toMatchObject({ bound: 0, launches: 1 }); expect(f.tasks.get('task-1')!.delivery).toBe('tool') }
  finally { await f.close() }
})

it('actual spawn reconciliation resumes pre-terminal preparation after original handoff debt', async () => {
  const f = await foregroundFixture(true)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const running = f.run(); void running.catch(() => {})
  try {
    await f.started.promise; await f.tasks.flushPersistence()
    fault.target = f.path; fault.failFinalClose = true; handoff.closeEntered = entered.resolve; handoff.closeGate = release.promise
    await f.received.inbox.admit({ inputId: 'steer', text: 'refocus', intent: 'user', delivery: 'steer', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })
    await entered.promise; f.finish.resolve()
    await vi.waitFor(() => expect(f.tasks.get('task-1')!.outcome).toBe('completed'))
    handoff.closeGate = undefined; release.resolve()
    await expect(running).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(f.table.get('root/held')!.followupChain).rejects.toThrow('Earlier owned task save requires resolution')
    expect(f.document.view.events.filter(e => e.type === 'subagent/end')).toHaveLength(0)
    expect(f.tasks.notifications()).toHaveLength(1); expect(f.counts()).toMatchObject({ hints: 0, unregisters: 0, launches: 1 })
    fault.failFinalClose = false
    await f.source().reconcileTerminal()
    expect(f.document.view.events.filter(e => e.type === 'subagent/end')).toEqual([expect.objectContaining({ taskId: 'task-1', outcome: 'completed', resultText: 'actual original terminal' })])
    expect(f.tasks.get('task-1')!.retention).toBe('durable'); expect(f.tasks.notifications()).toHaveLength(1)
    expect(f.counts()).toMatchObject({ hints: 1, unregisters: 1, launches: 1 })
    await f.source().reconcileTerminal()
    expect(f.counts()).toMatchObject({ hints: 1, unregisters: 1, launches: 1 })
  } finally { release.resolve(); fault.failFinalClose = false; fault.target = ''; handoff.closeGate = undefined; handoff.closeEntered = undefined; await f.close() }
})

it('retires a binding consumer after acknowledgement even after parent revocation', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(), 'ih-binding-retire-')), coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId:'parent' }); const document = await coordinator.openManagedDocument('parent')
    await writeFile(join(root,'task-parent.doc.jsonl'), '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const persistence = new TaskPersistence(coordinator,'parent',false,()=>({formatVersion:2,tasks:[],notifications:[]}),captureOwnedTaskContext(coordinator,document,document.view,'parent'))
    const held = persistence.captureBindingSave()!; await held.done; document.revokeNewWork()
    await held.retireConsumer(); expect(() => held.release()).toThrow(); expect(() => held.assertHandoff()).toThrow(); await persistence.flush()
  } finally { await coordinator.close(); await rm(root,{recursive:true,force:true}) }
})

it('retirement releases a clean queue and checks receiver and repeated consumption', async () => {
  const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(),'ih-binding-queue-')), coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
  try {
    await coordinator.create({sessionId:'parent'}); const doc=await coordinator.openManagedDocument('parent')
    const p=new TaskPersistence(coordinator,'parent',true,()=>({formatVersion:2,tasks:[],notifications:[]}),captureOwnedTaskContext(coordinator,doc,doc.view,'parent'))
    const held=p.captureBindingSave(); await held.done; const later=p.save(); await held.retireConsumer(); await held.retireConsumer(); await later; await p.flush()
    await expect(held.retireConsumer.call({})).rejects.toThrow('receiver'); expect(()=>held.release()).toThrow(); expect(()=>held.assertHandoff()).toThrow()
  } finally { await coordinator.close(); await rm(root,{recursive:true,force:true}) }
})
it('retirement retains unknown original write debt and releases the parked queue', async () => {
  const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(),'ih-binding-unknown-')), coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
  try {
    await coordinator.create({sessionId:'parent'}); const doc=await coordinator.openManagedDocument('parent'), path=join(root,'task-parent.doc.jsonl')
    const p=new TaskPersistence(coordinator,'parent',true,()=>({formatVersion:2,tasks:[],notifications:[]}),captureOwnedTaskContext(coordinator,doc,doc.view,'parent'))
    fault.target=path; fault.afterRename=true; handoff.publications=0
    const held=p.captureBindingSave(); await expect(held.done).rejects.toThrow(); const queued=p.save(); void queued.catch(()=>{})
    await expect(held.retireConsumer()).rejects.toThrow(); await expect(queued).rejects.toThrow(); await expect(p.flush()).rejects.toThrow(); expect(handoff.publications).toBe(1); expect(p.lastOwnedSave()).toBe(held)
  } finally { fault.afterRename=false; fault.target=''; await coordinator.close().catch(()=>{}); await rm(root,{recursive:true,force:true}) }
})
it('retirement retries only original close and retains its failure history', async () => {
  const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(),'ih-binding-close-')), coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
  try {
    await coordinator.create({sessionId:'parent'}); const doc=await coordinator.openManagedDocument('parent'), path=join(root,'task-parent.doc.jsonl')
    const p=new TaskPersistence(coordinator,'parent',true,()=>({formatVersion:2,tasks:[],notifications:[]}),captureOwnedTaskContext(coordinator,doc,doc.view,'parent'))
    fault.target=path; fault.failFinalClose=true; handoff.publications=0
    const held=p.captureBindingSave(); await expect(held.done).rejects.toBeNull(); fault.failFinalClose=false
    await held.retireConsumer(); await p.flush(); expect(handoff.publications).toBe(1); expect(()=>held.release()).toThrow()
  } finally { fault.failFinalClose=false; fault.target=''; await coordinator.close().catch(()=>{}); await rm(root,{recursive:true,force:true}) }
})

it.each(['before','after'] as const)('repair non-strict binding debt fences later save queued %s retirement',async timing=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'binding-nonstrict-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await coordinator.create({sessionId:'parent'});const doc=await coordinator.openManagedDocument('parent'),path=join(root,'task-parent.doc.jsonl');let version:1|2=2
 const p=new TaskPersistence(coordinator,'parent',false,()=>({formatVersion:version,tasks:[],notifications:[]}),captureOwnedTaskContext(coordinator,doc,doc.view,'parent'));fault.target=path;fault.afterRename=true;handoff.publications=handoff.temps=0
 const held=p.captureBindingSave();await expect(held.done).rejects.toThrow();version=1
 let later:Promise<void>|undefined;if(timing==='before'){later=p.save();void later.catch(()=>{})}await expect(held.retireConsumer()).rejects.toThrow();later??=p.save();void later.catch(()=>{});const flush=p.flush();void flush.catch(()=>{})
 await expect(later).rejects.toThrow();await expect(flush).rejects.toThrow();expect(handoff.publications).toBe(1);expect(handoff.temps).toBe(1);expect(JSON.parse(await readFile(path,'utf8')).formatVersion).toBe(2);expect(p.lastOwnedSave()).toBe(held);expect(()=>held.assertHandoff()).toThrow();expect(()=>held.release()).toThrow()
 }finally{fault.afterRename=false;fault.target='';await coordinator.close().catch(()=>{});await rm(root,{recursive:true,force:true})}
})
it.each(['retry-first','retire-first'] as const)('repair exact clean head retirement is single-owner for %s',async order=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'binding-concurrent-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await coordinator.create({sessionId:'parent'});const doc=await coordinator.openManagedDocument('parent'),path=join(root,'task-parent.doc.jsonl');let version:1|2=2
 const p=new TaskPersistence(coordinator,'parent',false,()=>({formatVersion:version,tasks:[],notifications:[]}),captureOwnedTaskContext(coordinator,doc,doc.view,'parent'));fault.target=path;handoff.publications=handoff.temps=0
 const held=p.captureBindingSave();await held.done;version=1;const later=p.save();void later.catch(()=>{});const retry=order==='retry-first'?held.retry():undefined,retiring=held.retireConsumer(),recovery=retry??held.retry();const flush=p.flush();void flush.catch(()=>{})
 await recovery;await retiring;await later;await flush;expect(handoff.publications).toBe(2);expect(()=>held.release()).toThrow();expect(()=>held.assertHandoff()).toThrow();await held.retireConsumer()
 }finally{fault.target='';await coordinator.close();await rm(root,{recursive:true,force:true})}
})

async function repairBinding(snapshot?:()=>import('../src/task/types.ts').TaskProtocolDocument){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'binding-matrix-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'parent'});const doc=await coordinator.openManagedDocument('parent'),path=join(root,'task-parent.doc.jsonl');let version:1|2=2
 const p=new TaskPersistence(coordinator,'parent',false,snapshot??(()=>({formatVersion:version,tasks:[],notifications:[]})),captureOwnedTaskContext(coordinator,doc,doc.view,'parent'))
 fault.target=path;handoff.cleanupPath=taskLeasePath(root);handoff.publications=handoff.temps=handoff.syncs=handoff.releases=handoff.closeCalls=0;fault.finalOpens=0
 return{root,coordinator,doc,path,p,version(v:1|2){version=v},async close(){fault.afterRename=fault.failFinalClose=false;fault.target='';fault.writeGate=fault.gate=undefined;fault.writeEntered=fault.entered=undefined;handoff.closeGate=handoff.cleanupGate=undefined;handoff.closeEntered=handoff.cleanupEntered=undefined;handoff.acquireFails=handoff.heldFails=handoff.releaseFails='';await coordinator.close().catch(()=>{});await rm(root,{recursive:true,force:true})}}
}
it.each(['write','close','release'] as const)('repair retirement joins held original %s once before queued save/flush',async phase=>{
 const f=await repairBinding(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 try{if(phase==='write'){fault.writeEntered=entered.resolve;fault.writeGate=release.promise}else if(phase==='close'){handoff.closeEntered=entered.resolve;handoff.closeGate=release.promise}else{handoff.cleanupEntered=entered.resolve;handoff.cleanupGate=release.promise}
 const held=f.p.captureBindingSave();void held.done.catch(()=>{});await entered.promise;f.version(1);const later=f.p.save();void later.catch(()=>{});const retiring=held.retireConsumer();expect(held.retireConsumer()).toBe(retiring);let settled=false;void retiring.then(()=>{settled=true});const flush=f.p.flush();await Promise.resolve();expect(settled).toBe(false);expect(()=>held.release()).toThrow();release.resolve();await held.done;await retiring;await later;await flush;expect(handoff.publications).toBe(2);expect(handoff.temps).toBe(2);expect(fault.finalOpens).toBe(2);expect(()=>held.assertHandoff()).toThrow()
 }finally{release.resolve();await f.close()}
})
it.each(['retry-first','retire-first'] as const)('repair concurrent close debt recovery/retirement %s preserves original acknowledgement',async order=>{
 const f=await repairBinding()
 try{fault.failFinalClose=true;const held=f.p.captureBindingSave();await expect(held.done).rejects.toBeNull();const before=held.outcome();fault.failFinalClose=false;f.version(1);const later=f.p.save();void later.catch(()=>{});const retry=order==='retry-first'?held.retry():undefined,retiring=held.retireConsumer(),recovery=retry??held.retry();await recovery;await retiring;await expect(later).rejects.toThrow('Earlier owned task save requires resolution');const queued=f.p.lastOwnedSave()!;expect(queued).not.toBe(held);await queued.retry();await f.p.flush();const after=held.outcome();if(before?.kind==='committed'&&after?.kind==='committed')expect(after.ack).toBe(before.ack);else throw Error('lost original ack');expect(handoff.publications).toBe(2);expect(handoff.temps).toBe(2);expect(()=>held.assertHandoff()).toThrow();expect(()=>held.release()).toThrow()
 }finally{await f.close()}
})
it('repair failed cleanup after revoked parent recovers only original resources',async()=>{
 const f=await repairBinding()
 try{fault.failFinalClose=true;const held=f.p.captureBindingSave();await expect(held.done).rejects.toBeNull();const original=held.outcome(),initialCloses=handoff.closeCalls;f.doc.revokeNewWork();await expect(held.retireConsumer()).rejects.toBeNull();await expect(f.p.flush()).rejects.toThrow();expect(f.p.lastOwnedSave()).toBe(held);fault.failFinalClose=false;await held.retry();await f.p.flush();expect(handoff.publications).toBe(1);expect(handoff.temps).toBe(1);expect(fault.finalOpens).toBe(1);expect(handoff.closeCalls).toBe(initialCloses+2);const after=held.outcome();if(original?.kind==='committed'&&after?.kind==='committed')expect(after.ack).toBe(original.ack);else throw Error('lost ack');expect(()=>held.release()).toThrow();expect(()=>held.assertHandoff()).toThrow()
 }finally{await f.close()}
})
it.each([null,undefined,0,false] as const)('repair failed snapshot retains original falsey cause %s and exact receivers',async cause=>{
 const f=await repairBinding(()=>{throw cause})
 try{const held=f.p.captureBindingSave();await expect(held.done).rejects.toBe(cause);expect(held.outcome()).toBeUndefined();await expect(held.retireConsumer()).rejects.toBe(cause);await expect(held.retry()).rejects.toBe(cause);expect(()=>held.release()).toThrow();expect(()=>held.assertHandoff()).toThrow();await expect(held.retireConsumer.call({})).rejects.toThrow('receiver');await expect(held.retry.call({})).rejects.toThrow('receiver');for(const method of [held.release,held.assertHandoff,held.outcome])expect(()=>method.call({})).toThrow('receiver');const later=f.p.save();await expect(later).rejects.toBe(cause);await expect(f.p.flush()).rejects.toMatchObject({cause});expect(handoff.publications).toBe(0);expect(handoff.temps).toBe(0);expect(f.p.lastOwnedSave()).toBe(held)
 }finally{await f.close()}
})
it.each(['validation','acquire','acquire-cleanup'] as const)('repair %s refusal retains original operation/cleanup without publication',async failure=>{
 const f=await repairBinding(failure==='validation'?()=>({formatVersion:3,tasks:[],notifications:[]}):undefined)
 try{if(failure==='acquire')handoff.acquireFails=handoff.cleanupPath;if(failure==='acquire-cleanup'){handoff.heldFails=handoff.cleanupPath;handoff.releaseFails=handoff.cleanupPath}
 const held=f.p.captureBindingSave();const error=await held.done.then(()=>{throw Error('unexpected success')},e=>e);expect(held.outcome()).toBeUndefined();if(failure==='acquire')expect(error.cause).toBeNull();if(failure==='acquire-cleanup'){expect(error.cause).toBe(0);expect(error.cleanupCause).toBe(false)}
 await expect(held.retireConsumer()).rejects.toBeDefined();f.doc.revokeNewWork();handoff.acquireFails=handoff.heldFails=handoff.releaseFails='';await expect(held.retry()).rejects.toBe(error);await expect(f.p.flush()).rejects.toThrow();expect(held.outcome()).toBeUndefined();expect(handoff.publications).toBe(0);expect(handoff.temps).toBe(0);expect(()=>held.assertHandoff()).toThrow();await expect(held.retry.call({})).rejects.toThrow('receiver')
 }finally{await f.close()}
})
it('repair queued non-strict save during original unknown publication retains exact candidate through explicit retry',async()=>{
 const f=await repairBinding(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 try{fault.afterRename=true;fault.entered=entered.resolve;fault.gate=release.promise;const held=f.p.captureBindingSave();void held.done.catch(()=>{});await entered.promise;f.version(1);const later=f.p.save();void later.catch(()=>{});const retiring=held.retireConsumer();void retiring.catch(()=>{});const flush=f.p.flush();void flush.catch(()=>{});release.resolve();await expect(held.done).rejects.toThrow();await expect(retiring).rejects.toThrow();await expect(later).rejects.toThrow();await expect(flush).rejects.toThrow();expect(f.p.lastOwnedSave()).toBe(held);expect(handoff.publications).toBe(1);expect(handoff.temps).toBe(1);fault.afterRename=false;await held.retry();expect(handoff.publications).toBe(1);expect(handoff.temps).toBe(1);const queued=f.p.lastOwnedSave()!;expect(queued).not.toBe(held);await queued.retry();await f.p.flush();expect(handoff.publications).toBe(2);expect(()=>held.release()).toThrow();expect(()=>held.assertHandoff()).toThrow()
 }finally{release.resolve();await f.close()}
})
it.each(['unknown-revoked','conflict'] as const)('repair abandoned %s never grants handoff or a replacement snapshot',async kind=>{
 const f=await repairBinding()
 try{if(kind==='unknown-revoked')fault.afterRename=true;else fault.tempSynced=async()=>{fault.tempSynced=undefined;await writeFile(f.path,'{ "formatVersion":2,"tasks":[],"notifications":[] }')}
 const held=f.p.captureBindingSave();await expect(held.done).rejects.toThrow();const original=held.outcome();expect(original?.kind).toBe(kind==='conflict'?'conflict':'unknown');f.doc.revokeNewWork();await expect(held.retireConsumer()).rejects.toThrow();fault.afterRename=false;await expect(held.retry()).rejects.toBeDefined();const later=f.p.save();await expect(later).rejects.toBeDefined();await expect(f.p.flush()).rejects.toThrow();expect(held.outcome()).toEqual(original);expect(handoff.publications).toBe(kind==='conflict'?0:1);expect(handoff.temps).toBe(1);await expect(held.retry.call({})).rejects.toThrow('receiver');for(const method of [held.release,held.assertHandoff,held.outcome])expect(()=>method.call({})).toThrow('receiver');expect(()=>held.release()).toThrow();expect(()=>held.assertHandoff()).toThrow()
 }finally{fault.tempSynced=undefined;await f.close()}
})
it('repair completed head retirement remains clean when a later capture records its own debt',async()=>{
 let invalid=false;const f=await repairBinding(()=>({formatVersion:invalid?3:2,tasks:[],notifications:[]}))
 try{const held=f.p.captureBindingSave();await held.done;invalid=true;const later=f.p.save();void later.catch(()=>{});const retry=held.retry(),retirement=held.retireConsumer();await retry;await retirement;await expect(later).rejects.toThrow();await expect(f.p.flush()).rejects.toThrow();expect(f.p.lastOwnedSave()).not.toBe(held);expect(handoff.publications).toBe(1);expect(()=>held.assertHandoff()).toThrow()
 }finally{await f.close()}
})
