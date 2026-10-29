import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ path: '', active: false, closes: 0, failSync: false, syncs: 0, entered: undefined as undefined | (() => void), gate: undefined as undefined | Promise<void> }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === fault.path && fault.gate) { fault.entered?.(); await fault.gate }
    const handle = await fs.open(...args), close = handle.close.bind(handle), sync = handle.sync.bind(handle)
    if (String(args[0]) === fault.path) { handle.close = async () => { fault.closes++; if (fault.active) throw null; await close() }; handle.sync = async () => { fault.syncs++; if (fault.failSync) throw undefined; await sync() } }
    return handle
  } }
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
