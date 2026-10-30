import { it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createDesktopExecution } from '../src/execution.ts'
import { createExecutionHostObservation } from '../src/execution-host-observation.ts'

it('reads a genuine cold binding, reports writes, retires on project fence, and stays idle', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'host-observe-'))
  const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
  const broker = createProjectScopeBroker(c, root)
  const service = { liveAssembly: () => undefined, onExecutionSurfaceLifecycle: () => () => {} }
  const owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({ sessionId: 's' }); await c.releaseOwnership('s')
    const notices: string[] = []
    const lease = await owner.subscribe('s', notice => notices.push(notice.kind))
    expect((await lease.snapshot()).kind).toBe('snapshot')
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(600000); vi.useRealTimers()
    expect(notices).toEqual([])
    await c.append('s', [{ type: 'plan/mode', mode: 'on' }])
    await expect(lease.snapshot()).rejects.toThrow()
    expect(notices).toContain('retired')
    await lease.close()
  } finally { vi.useRealTimers(); await owner.close(); await broker.close(); await c.close(); await rm(root, { recursive: true, force: true }) }
})


it('coalesces real source change callbacks and fences a replaced source', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'host-source-'))
  const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
  const broker = createProjectScopeBroker(c, root)
  let changed = () => {}, lifecycle: (event: any) => void = () => {}
  const assembly = { session: { events: [] }, onExecutionSurfaceChanged: (listener: () => void) => { changed = listener; return () => { changed = () => {} } } }
  let current: any = assembly
  const service: any = { liveAssembly: () => current, onExecutionSurfaceLifecycle: (listener: (event: any) => void) => { lifecycle = listener; listener({ sessionId: 's', assembly, kind: 'published' }); return () => {} } }
  const owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({ sessionId: 's' }); await c.releaseOwnership('s')
    const notices: string[] = []; const lease = await owner.subscribe('s', notice => notices.push(notice.kind))
    expect((await lease.snapshot()).kind).toBe('snapshot')
    changed(); changed(); await Promise.resolve()
    expect(notices).toEqual(['invalidate'])
    current = undefined; lifecycle({ sessionId: 's', assembly, kind: 'removed' })
    expect(notices).toEqual(['invalidate', 'retired'])
    await expect(lease.snapshot()).rejects.toThrow()
    await lease.close()
  } finally { await owner.close(); await broker.close(); await c.close(); await rm(root, { recursive: true, force: true }) }
})
