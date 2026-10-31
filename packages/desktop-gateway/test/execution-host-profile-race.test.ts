import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, readFile: vi.fn(actual.readFile) } })
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createSessionService } from '@i-harness/session-executor'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createDesktopExecution } from '../src/execution.ts'
import { createExecutionHostObservation } from '../src/execution-host-observation.ts'
it.each(['revoked-success', 'undefined', 'false', 'archive', 'project', 'move', 'lease-close', 'adapter-close'] as const)('denies the held real retained profile and preserves %s precedence', async outcome => {
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'adapter-held-profile-')), path = join(root, 's.jsonl'), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let armed = false
  vi.mocked(readFile).mockImplementation(async (...args: any[]) => { const value = await (native.readFile as any)(...args); if (armed && String(args[0]) === path) { armed = false; entered.resolve(); await gate.promise; if (outcome === 'undefined' || outcome === 'false') throw outcome === 'undefined' ? undefined : false }; return value })
  const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root, undefined, { assertIdle: async () => {} }), owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({ sessionId: 's' }); await c.releaseOwnership('s')
    const lease = await owner.subscribe('s', () => {}), source = vi.spyOn(service, 'liveAssembly'), snapshot = vi.spyOn(c as typeof c & { snapshot: NonNullable<typeof c.snapshot> }, 'snapshot')
    armed = true; const reading = lease.snapshot(); void reading.catch(() => {}); await entered.promise
    source.mockClear(); snapshot.mockClear()
    const changing = outcome === 'archive' ? c.updateMeta('s', { archived: true }) : outcome === 'project' ? broker.sync([]) : outcome === 'move' ? broker.move('s', undefined, undefined) : outcome === 'lease-close' ? lease.close() : outcome === 'adapter-close' ? owner.close() : broker.configureReferences([]); void changing.catch(() => {})
    await expect(lease.snapshot()).rejects.toThrow()
    gate.resolve()
    if (outcome !== 'undefined' && outcome !== 'false') await expect(reading).rejects.toThrow()
    else await expect(reading).rejects.toBe(outcome === 'undefined' ? undefined : false)
    expect(source).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
    await changing
    if (outcome === 'adapter-close' || outcome === 'archive') return
    const fresh = await owner.subscribe('s', () => {}); expect((await fresh.snapshot()).kind).toBe('snapshot'); expect(fresh.epoch).not.toBe(lease.epoch); await fresh.close()
  } finally { armed = false; gate.resolve(); await owner.close(); await broker.close(); await service.close(); await c.close(); vi.mocked(readFile).mockImplementation(native.readFile); await rm(root, { recursive: true, force: true }) }
})
