import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ path: '', active: false, closes: 0, failSync: false, syncs: 0, afterRename: false, closeOnlyWritable: false, entered: undefined as undefined | (() => void), gate: undefined as undefined | Promise<void>, syncEntered: undefined as undefined | (() => void), syncGate: undefined as undefined | Promise<void>, writeEntered: undefined as undefined | (() => void), writeGate: undefined as undefined | Promise<void> }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => { await fs.rename(...args); if (fault.afterRename && String(args[1]) === fault.path) throw new Error('publication response lost') }, open: async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === fault.path && fault.gate) { fault.entered?.(); await fault.gate }
    const handle = await fs.open(...args), close = handle.close.bind(handle), sync = handle.sync.bind(handle), write = handle.write.bind(handle)
    if (String(args[0]) === fault.path) { handle.close = async () => { fault.closes++; if (fault.active && (!fault.closeOnlyWritable || args[1] === 'r+')) throw null; await close() }; handle.sync = async () => { fault.syncs++; if (fault.syncGate) { fault.syncEntered?.(); await fault.syncGate }; if (fault.failSync) throw undefined; await sync() } }
    if (String(args[0]).startsWith(fault.path + '.') && args[1] === 'wx') handle.write = (async (buffer: Uint8Array, offset: number, length: number, position: number) => { if (fault.writeGate) { fault.writeEntered?.(); await fault.writeGate }; return write(buffer, offset, length, position) }) as typeof handle.write
    return handle
  } }
})

it('joins issue, reconcile and retry onto the same original write flight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-write-flight-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('missing')
    const write = operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] }); fault.writeEntered = entered.resolve; fault.writeGate = release.promise
    const issue = write.issue(); await entered.promise; expect(write.reconcile()).toBe(issue); expect(write.retry()).toBe(issue)
    fault.writeGate = undefined; release.resolve(); expect((await issue).kind).toBe('committed'); await operation.close()
  } finally { fault.writeGate = undefined; fault.writeEntered = undefined; release.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps the original write witness through an uncertain publication and same-candidate retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-write-retry-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('missing')
    const write = operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] }); fault.afterRename = true
    expect((await write.issue()).kind).toBe('unknown'); expect((await write.issue()).kind).toBe('unknown')
    await expect(coordinator.flush('parent')).rejects.toThrow(); fault.afterRename = false
    expect((await write.retry()).kind).toBe('committed'); await operation.close()
  } finally { fault.afterRename = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps committed write acknowledgment and process fence through original final close debt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-write-close-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('missing')
    const write = operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] }); fault.active = true; fault.closeOnlyWritable = true
    const committed = await write.issue(); expect(committed).toMatchObject({ kind: 'committed', cleanupPending: true }); expect(write.outcome()).toBe(committed)
    await expect(coordinator.flush('parent')).rejects.toThrow()
    await expect(coordinator.withProcessReadObservation!('parent', { documentKeys: ['task-parent'] }, async () => 1, async value => value)).rejects.toThrow()
    fault.active = false; fault.closeOnlyWritable = false; const retried = await write.retry(); expect(retried.kind).toBe('committed'); if (retried.kind === 'committed' && committed.kind === 'committed') expect(retried.ack).toBe(committed.ack)
    await operation.close()
  } finally { fault.active = false; fault.closeOnlyWritable = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses staging while original confirmation is in flight and prevents later preimage retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-confirm-gate-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('missing')
    fault.syncEntered = entered.resolve; fault.syncGate = release.promise
    const confirming = operation.confirm(observed.witness); await entered.promise
    expect(() => operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] })).toThrow()
    fault.syncGate = undefined; release.resolve(); expect((await confirming).kind).toBe('confirmed')
    const write = operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] })
    await expect(operation.retryConfirmation(observed.witness)).rejects.toThrow(); expect((await write.issue()).kind).toBe('committed'); await operation.close()
  } finally { fault.syncGate = undefined; fault.syncEntered = undefined; release.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses staging while an explicit original confirmation retry is in flight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-reconfirm-gate-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('missing')
    fault.failSync = true; expect((await operation.confirm(observed.witness)).kind).toBe('unknown'); fault.failSync = false
    fault.syncEntered = entered.resolve; fault.syncGate = release.promise; const retry = operation.retryConfirmation(observed.witness); await entered.promise
    expect(() => operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] })).toThrow()
    fault.syncGate = undefined; release.resolve(); expect((await retry).kind).toBe('confirmed')
    const write = operation.stageWrite(observed.witness, { formatVersion: 2, tasks: [], notifications: [] }); expect((await write.issue()).kind).toBe('committed'); await operation.close()
  } finally { fault.failSync = false; fault.syncGate = undefined; fault.syncEntered = undefined; release.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('joins a revoked observation suspended before its original file open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-open-gate-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent))
    fault.entered = entered.resolve; fault.gate = release.promise
    const observation = operation.observe(); void observation.catch(() => {}); await entered.promise
    let written = false; const write = coordinator.putDocumentStrict!('task-parent', { formatVersion: 2, tasks: [], notifications: [] }).then(() => { written = true })
    await Promise.resolve(); expect(written).toBe(false); fault.gate = undefined; release.resolve()
    await expect(observation).rejects.toThrow(); await write; expect(written).toBe(true)
  } finally { fault.gate = undefined; fault.entered = undefined; release.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('retries unknown confirmation only against its original raw witness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-confirm-retry-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{ "formatVersion":2,"tasks":[],"notifications":[] }')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    fault.failSync = true; expect((await operation.confirm(observed.witness)).kind).toBe('unknown')
    await expect(coordinator.flush('parent')).rejects.toThrow()
    const count = fault.syncs; expect((await operation.confirm(observed.witness)).kind).toBe('unknown'); expect(fault.syncs).toBe(count)
    fault.failSync = false; const [first, second] = await Promise.all([operation.retryConfirmation(observed.witness), operation.retryConfirmation(observed.witness)])
    expect(first.kind).toBe('confirmed'); expect(second).toEqual(first); await operation.close()
  } finally { fault.active = false; fault.failSync = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('preserves the original confirmed acknowledgement separately from failed close debt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-ack-debt-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent)), observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('missing')
    fault.active = true; const result = await operation.confirm(observed.witness)
    expect(result).toMatchObject({ kind: 'confirmed', cleanupPending: true }); expect(await operation.confirm(observed.witness)).toBe(result)
    await expect(operation.close()).rejects.toBeNull(); fault.active = false; await operation.retryClose()
  } finally { fault.active = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not retry a failed original file close in the same coordinator shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-shutdown-debt-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, operation = await operations.begin(operations.parent(parent))
    fault.active = true; await expect(operation.observe()).rejects.toBeNull(); const before = fault.closes
    await expect(coordinator.close()).rejects.toThrow(); expect(fault.closes).toBe(before + 1)
    fault.active = false; await coordinator.close(); expect(fault.closes).toBe(before + 2)
  } finally { fault.active = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskDocumentCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentOperationsFor } from '../../session-persistence/src/coordinator/task-document-association.ts'

it('retains a falsey file close debt and original locks until explicit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-task-debt-')), coordinator = createJsonlTaskDocumentCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' }); const parent = await coordinator.openManagedDocument('parent')
    fault.path = join(root, 'task-parent.doc.jsonl'); await writeFile(fault.path, '{"formatVersion":2,"tasks":[],"notifications":[]}')
    const operations = taskDocumentOperationsFor(coordinator)!, token = operations.parent(parent), operation = await operations.begin(token)
    fault.active = true; await expect(operation.observe()).rejects.toBeNull()
    const beforeFlush = fault.closes; await expect(coordinator.flush('parent')).rejects.toThrow(); expect(fault.closes).toBe(beforeFlush)
    const first = operation.close(); await expect(first).rejects.toBeNull(); const count = fault.closes
    expect(operation.close()).toBe(first); await expect(operation.close()).rejects.toBeNull(); expect(fault.closes).toBe(count)
    await expect(operations.begin(token)).rejects.toThrow()
    fault.active = false; await operation.retryClose(); expect(fault.closes).toBeGreaterThan(count)
    const next = await operations.begin(token); await next.close()
  } finally { fault.active = false; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
