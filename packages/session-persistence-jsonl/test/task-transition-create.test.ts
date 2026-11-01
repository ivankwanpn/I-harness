import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { taskDocumentTransitionCleanupFor } from '../../session-persistence/src/task-document-internal.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import * as factory from '../src/task-document-factory.ts'
const { createJsonlTaskTransitionCoordinator } = factory as unknown as { createJsonlTaskTransitionCoordinator: typeof factory.createJsonlTaskDocumentCoordinator }

it('initializes an actual new parent task document before creating its header', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-create-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' })
    expect(JSON.parse(await readFile(join(root, 'task-parent.doc.jsonl'), 'utf8'))).toEqual({ formatVersion: 2, tasks: [], notifications: [] })
    expect(JSON.parse((await readFile(join(root, 'parent.jsonl'), 'utf8')).split('\n')[0]!).sessionId).toBe('parent')
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses a cold orphan task instead of adopting it for a fresh parent', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-orphan-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    const original = '{"formatVersion":1,"tasks":[],"notifications":[]}\n'
    await writeFile(join(root, 'task-parent.doc.jsonl'), original)
    let failure: unknown; try { await coordinator.create({ sessionId: 'parent' }); expect.fail('expected collision') } catch (error) { failure = error }
    expect(await taskDocumentTransitionCleanupFor(coordinator, failure)!.retry()).toBe('not-committed')
    expect(await readFile(join(root, 'task-parent.doc.jsonl'), 'utf8')).toBe(original)
    await expect(readFile(join(root, 'parent.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('rejects actual validator self-mutation without poisoning the original transition', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-self-'))
  let coordinator: ReturnType<typeof createJsonlTaskTransitionCoordinator>, attempted: Promise<unknown> | undefined
  const validator = { empty: taskDocumentStorageContract.empty, consistency: taskDocumentStorageContract.consistency, validate(value: unknown) {
    taskDocumentStorageContract.validate(value)
    attempted = coordinator.putDocumentStrict!('task-p', value); void attempted.catch(() => {})
  } }
  coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, validator)
  try {
    await coordinator.create({ sessionId: 'p' }); await expect(attempted).rejects.toThrow()
    expect(JSON.parse(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8'))).toEqual({ formatVersion: 2, tasks: [], notifications: [] })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses a preexisting parent before creating a missing task document', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-parent-collision-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await writeFile(join(root, 'p.jsonl'), 'foreign\n')
    await expect(coordinator.create({ sessionId: 'p' })).rejects.toThrow()
    expect(await readFile(join(root, 'p.jsonl'), 'utf8')).toBe('foreign\n')
    await expect(readFile(join(root, 'task-p.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('preserves ancestor self-admission guards through a nested other-parent transition', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-ancestor-'))
  let coordinator: ReturnType<typeof createJsonlTaskTransitionCoordinator>, calls = 0, nested: Promise<unknown> | undefined, attempt: Promise<unknown> | undefined
  const validator = { empty: taskDocumentStorageContract.empty, consistency: taskDocumentStorageContract.consistency, validate(value: unknown) {
    taskDocumentStorageContract.validate(value)
    if (++calls === 1) { nested = coordinator.create({ sessionId: 'q' }); void nested.catch(() => {}) }
    else { attempt = coordinator.putDocumentStrict!('task-p', value); void attempt.catch(() => {}) }
  } }
  coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, validator)
  try { await coordinator.create({ sessionId: 'p' }); await nested; await expect(attempt).rejects.toThrow() }
  finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('rejects a late descendant of the finished validator context', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-expired-'))
  const gate = Promise.withResolvers<void>()
  let coordinator: ReturnType<typeof createJsonlTaskTransitionCoordinator>, late: Promise<unknown> | undefined
  const validator = { empty: taskDocumentStorageContract.empty, consistency: taskDocumentStorageContract.consistency, validate(value: unknown) {
    taskDocumentStorageContract.validate(value)
    late = (async () => { await gate.promise; return coordinator.putDocumentStrict!('task-p', value) })(); void late.catch(() => {})
  } }
  coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, validator)
  try {
    await coordinator.create({ sessionId: 'p' }); gate.resolve(); await expect(late).rejects.toThrow()
    expect(JSON.parse(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8'))).toEqual({ formatVersion: 2, tasks: [], notifications: [] })
  } finally { gate.resolve(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('rejects a noncanonical injected empty document before task or parent publication', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bad-empty-'))
  const validator = { ...taskDocumentStorageContract, empty() { return { formatVersion: 1 as const, tasks: [], notifications: [] } } }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, validator)
  try {
    await expect(coordinator.create({ sessionId: 'p' })).rejects.toThrow()
    await expect(readFile(join(root, 'p.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'task-p.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('composes the full candidate only from the original JSONL backend', async () => {
  const { createJsonlBackend, composeJsonlTaskTransitionCoordinator } = await import('../src/backend-factory.ts')
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-original-backend-'))
  const backend = createJsonlBackend(root)
  expect(() => composeJsonlTaskTransitionCoordinator({ ...backend }, { lock: { enabled: true } }, taskDocumentStorageContract)).toThrow()
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try { await coordinator.create({ sessionId: 'p' }); expect(JSON.parse(await readFile(join(root,'task-p.doc.jsonl'),'utf8')).formatVersion).toBe(2) }
  finally { await coordinator.close(); await rm(root,{recursive:true,force:true}) }
})
