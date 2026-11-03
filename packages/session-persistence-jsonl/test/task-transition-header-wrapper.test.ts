import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', mode: 'copy' as 'copy' | 'getter', wrapper: undefined as { handle: object } | undefined, original: undefined as object | undefined, swapped: false, getterCalls: 0 }))
vi.mock('../src/backend/session-io.ts', async original => {
  const real = await original<typeof import('../src/backend/session-io.ts')>()
  return { ...real, stageOwnedSessionFile(...args: Parameters<typeof real.stageOwnedSessionFile>) {
    const wrapper = real.stageOwnedSessionFile(...args)
    if (args[0] === fault.target) { fault.wrapper = wrapper; fault.original = wrapper.handle }
    return wrapper
  } }
})
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (fault.target && String(args[0]).startsWith(fault.target + '.') && args[1] === 'wx' && fault.wrapper && !fault.swapped) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync(); fault.swapped = true
        if (fault.mode === 'copy') fault.wrapper!.handle = { ...fault.original }
        else Object.defineProperty(fault.wrapper!, 'handle', { configurable: true, get() { fault.getterCalls++; return fault.original } })
      }
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { taskDocumentTransitionCleanupFor } from '../../session-persistence/src/coordinator/task-transition-association.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it.each(['copy', 'getter'] as const)('refuses a %s substitution of the original create header handle', async mode => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-header-wrapper-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = join(root, 'parent.jsonl'); fault.mode = mode; fault.swapped = false; fault.getterCalls = 0
  try {
    const result = await coordinator.create({ sessionId: 'parent' }).then(() => ({ error: undefined }), error => ({ error }))
    expect(result.error, 'a substituted wrapper must not publish a header').toBeDefined()
    expect(fault.swapped).toBe(true); expect(fault.getterCalls).toBe(0)
    await expect(readFile(fault.target)).rejects.toMatchObject({ code: 'ENOENT' })
    Object.defineProperty(fault.wrapper!, 'handle', { configurable: true, writable: true, enumerable: true, value: fault.original })
    expect(await taskDocumentTransitionCleanupFor(coordinator, result.error)!.retry()).toBe('committed')
  } finally { if (fault.wrapper) Object.defineProperty(fault.wrapper, 'handle', { configurable: true, writable: true, enumerable: true, value: fault.original }); fault.target = ''; fault.wrapper = undefined; fault.original = undefined; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses replacement of the retained predecessor upgrade handle', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-upgrade-wrapper-'))
  const path = join(root, 'parent.jsonl'), original = '{"sessionId":"parent","createdAt":"2026-10-30","formatVersion":5}\n'
  await writeFile(path, original)
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = path; fault.mode = 'copy'; fault.swapped = false; fault.getterCalls = 0
  try {
    const result = await coordinator.loadOwned('parent').then(() => ({ error: undefined }), error => ({ error }))
    expect(result.error).toBeDefined(); expect(fault.swapped).toBe(true); expect(await readFile(path, 'utf8')).toBe(original)
    Object.defineProperty(fault.wrapper!, 'handle', { configurable: true, writable: true, enumerable: true, value: fault.original })
    expect(await taskDocumentTransitionCleanupFor(coordinator, result.error)!.retry()).toBe('committed')
  } finally { if (fault.wrapper) Object.defineProperty(fault.wrapper, 'handle', { configurable: true, writable: true, enumerable: true, value: fault.original }); fault.target = ''; fault.wrapper = undefined; fault.original = undefined; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
