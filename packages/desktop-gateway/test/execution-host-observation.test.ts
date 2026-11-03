import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createDesktopExecution } from '../src/execution.ts'
import { createExecutionHostObservation } from '../src/execution-host-observation.ts'

it('reads a genuine cold binding, retires on the original project fence', async () => {
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
    expect(notices).toEqual([])
    await c.append('s', [{ type: 'plan/mode', mode: 'on' }])
    await expect(lease.snapshot()).rejects.toThrow()
    expect(notices).toContain('retired')
    await lease.close()
  } finally { await owner.close(); await broker.close(); await c.close(); await rm(root, { recursive: true, force: true }) }
})


it('refuses missing custom source reliability rather than returning a live snapshot', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'host-source-'))
  const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
  const broker = createProjectScopeBroker(c, root)
  const assembly = { session: { events: [] }, onExecutionSurfaceChanged: () => () => {} }
  const service: any = { liveAssembly: () => assembly, onExecutionSurfaceLifecycle: (listener: (event: any) => void) => { listener({ sessionId: 's', assembly, kind: 'published' }); return () => {} } }
  const owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({ sessionId: 's' }); await c.releaseOwnership('s')
    await expect(owner.subscribe('s', () => {})).rejects.toThrow('unavailable')
  } finally { await owner.close(); await broker.close(); await c.close(); await rm(root, { recursive: true, force: true }) }
})

it('forwards an actual managed code fact from service into a retained host snapshot', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'host-managed-source-'))
  const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
  const broker = createProjectScopeBroker(c, root)
  const { createSessionService } = await import('@i-harness/session-executor')
  const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' })
  const owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({sessionId:'s'})
    const assembly = await service.assemblyFor('s')
    const notices: string[] = []; const lease = await owner.subscribe('s', notice => { notices.push(notice.kind) })
    expect((await lease.snapshot()).kind).toBe('snapshot')
    const action = assembly.managedDocument!.beginAction()
    expect((await action.facts.code.record({type:'code/cell',cellId:'cell',state:'started'})).kind).toBe('committed')
    await Promise.resolve(); expect(notices).toContain('invalidate')
    const result = await lease.snapshot()
    expect(result.kind).toBe('snapshot')
    if (result.kind === 'snapshot') expect(result.value.cells[0]?.id).toBe('cell')
    action.finish(); await lease.close()
  } finally { await owner.close(); await service.close(); await broker.close(); await c.close(); await rm(root,{recursive:true,force:true}) }
})
