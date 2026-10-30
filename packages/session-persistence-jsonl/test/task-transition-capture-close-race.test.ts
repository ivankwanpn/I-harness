import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ prefix: '', active: false, assertHeld: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]).startsWith(fault.prefix) && fault.prefix && args[1] === 'wx') {
      const close = handle.close.bind(handle)
      handle.close = async () => { if (fault.active) throw false; await close() }
    }
    return handle
  } }
})
vi.mock('../src/backend/bootstrap-header.ts', async original => {
  const real = await original<typeof import('../src/backend/bootstrap-header.ts')>()
  return { ...real, createBootstrapHeaderBackend(...args: Parameters<typeof real.createBootstrapHeaderBackend>) {
    const backend = real.createBootstrapHeaderBackend(...args), track = backend.trackHeaderOwner
    backend.trackHeaderOwner = (id, held) => { fault.assertHeld = () => held.assertHeld(); track(id, held) }
    return backend
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { pair, guards } from '../../session-persistence/test/child-bootstrap-fixture.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('retains the borrowed capture claim when concurrent shutdown cannot settle the original task file', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-capture-close-race-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const other = createOwnership({ lockRoot: root }, { lock: { enabled: true }, acquireDeadlineMs: 50, acquireRetryMs: 5 })
  const { request, payload } = pair()
  fault.prefix = join(root, 'task-target.doc.jsonl.'); fault.active = true
  let competing: Awaited<ReturnType<typeof other.pinOwnership>> | undefined
  try {
    expect((await coordinator.bootstrapChildTargetWithCapture!(request, guards, async () => payload)).kind).toBe('blocked')
    await expect(readFile(join(root, 'target.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(coordinator.close()).rejects.toThrow()
    expect(() => fault.assertHeld!(), 'retained task resources still borrow the exact original claim').not.toThrow()
    competing = await other.pinOwnership('target').catch(() => undefined)
    expect(competing, 'task close debt must retain the original parent claim').toBeUndefined()
    fault.active = false
    await coordinator.close()
    competing = await other.pinOwnership('target')
    competing.assertHeld()
  } finally {
    fault.active = false; fault.prefix = ''; await competing?.release(); await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true })
  }
})
