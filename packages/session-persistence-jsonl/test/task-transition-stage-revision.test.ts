import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', active: false }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r') {
      const read = handle.read.bind(handle)
      handle.read = (async (...input: [Buffer, number, number, number]) => {
        const result = await read(...input)
        if (fault.active && result.bytesRead) {
          fault.active = false
          const bytes = await real.readFile(fault.target), writer = await real.open(fault.target, 'r+')
          try { await writer.write(bytes, 0, bytes.length, 0); await writer.sync(); await writer.utimes(new Date('2030-01-01'), new Date('2030-01-01')) } finally { await writer.close() }
        }
        return result
      }) as typeof handle.read
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { pair, guards } from '../../session-persistence/test/child-bootstrap-fixture.ts'
import { bootstrapPathsForRoute } from '../src/backend/bootstrap-stage.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('refuses a same-inode equal-size stage rewrite during the tracked read even when its bytes are unchanged', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-stage-revision-'))
  const { payload } = pair(), original = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  let documentBytes: Buffer | undefined
  // A ready bootstrap owns the task document, so the blocked resume below must
  // leave those exact bytes alone instead of proving the file never existed.
  try { expect((await original.bootstrapSemanticTarget(payload, guards)).kind).toBe('ready'); documentBytes = await readFile(join(root, 'task-target.doc.jsonl')) } finally { await original.close() }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = bootstrapPathsForRoute(join(root, 'target.jsonl'), { protocol: 'public', invocation: payload.invocation }).stage; fault.active = true
  let failure: unknown
  try {
    expect((await coordinator.resumeSemanticTarget(payload.invocation, guards)).kind).toBe('blocked')
    expect(await readFile(join(root, 'task-target.doc.jsonl'))).toEqual(documentBytes)
    expect((await coordinator.resumeSemanticTarget(payload.invocation, guards)).kind).toBe('already-ready')
  } catch (error) { failure = error } finally {
    fault.active = false; fault.target = ''
    // A close failure is real debt, but it must not hide the assertion that failed first.
    try { await coordinator.close() } catch (error) { if (failure === undefined) failure = error }
    await rm(root, { recursive: true, force: true })
  }
  if (failure !== undefined) throw failure
})
