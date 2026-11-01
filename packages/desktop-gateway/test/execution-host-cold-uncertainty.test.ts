import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, open: vi.fn(actual.open) } })
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createSessionService } from '@i-harness/session-executor'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createDesktopExecution } from '../src/execution.ts'
import { createExecutionHostObservation } from '../src/execution-host-observation.ts'
it('keeps a genuine uncertain cold append terminal for the old private lease without claiming post-write catch-up', async () => {
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'adapter-uncertain-cold-')), path = join(root, 's.jsonl'), fault = Object.freeze({ original: 'synced-close' })
  let armed = false, issues = 0
  vi.mocked(open).mockImplementation(async (...args) => { const handle = await native.open(...args); if (String(args[0]) !== path || args[1] !== 'r+') return handle; let wrote = false; return new Proxy(handle, { get(target, key) { if (key === 'write') return async (...values: Parameters<typeof target.write>) => { const result = await target.write(...values); wrote = true; issues++; return result }; if (key === 'close') return async () => { await target.close(); if (armed && wrote) { armed = false; throw fault } }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value } }) })
  const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract), service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root), owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({ sessionId: 's' }); await c.releaseOwnership('s')
    const notices: string[] = [], lease = await owner.subscribe('s', notice => notices.push(notice.kind)), before = await readFile(path)
    armed = true
    await expect(c.append('s', [{ type: 'plan/mode', mode: 'on' }])).rejects.toMatchObject({ cause: fault })
    const after = await readFile(path); expect(after.subarray(0, before.length)).toEqual(before); expect(after.length).toBeGreaterThan(before.length); expect(issues).toBe(1)
    expect(notices).toEqual(['retired']); await expect(lease.snapshot()).rejects.toThrow()
    await lease.close()
  } finally { armed = false; await owner.close(); await broker.close(); await service.close(); await c.close(); vi.mocked(open).mockImplementation(native.open); await rm(root, { recursive: true, force: true }) }
})
