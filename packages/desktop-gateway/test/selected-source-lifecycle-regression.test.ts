import { it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, open, rename, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createSelectedResultsIntent, readSelectedResultsCore, readSelectedResultsOperation } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { selectedBootstrapPaths } from '../../session-persistence-jsonl/src/backend/selected-results-route-path.ts'

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) }
})

async function fixture(operationId: string) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'selected-lifecycle-'))
  const workspace = join(root, 'workspace'), sessions = join(root, 'sessions')
  await mkdir(workspace)
  const backend = createJsonlBackend(sessions), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'source' })
  await coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'original' }, { type: 'turn/end' }])
  const projects = createProjectScopeBroker(coordinator, workspace)
  const runtime = await createNativeContextRuntime({ workspace, storageRoot: join(root, 'native'), coordinator,
    projectFor: projects.nativeScopeFor, resultReadScopeFor: projects.resultReadScopeFor,
    withBindingObservation: projects.withBindingObservation, retainSelectedProjectRead: projects.retainSelectedBindingRead,
    contextConfig: { enabled: true } })
  const core = readSelectedResultsCore({ version: 2, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {}, results: 'selected-results-v1' })
  const { intent, requestDigest } = createSelectedResultsIntent(core, { kind: 'unassigned' })
  const invocation = { version: 1 as const, operationId, targetSessionId: 'target', createdAt: '2026-10-28T00:00:00.000Z', requestDigest }
  const operation = readSelectedResultsOperation({ version: 2, kind: 'session-fork-operation', prepared: { version: 2, kind: 'session-fork-prepared', core, requestIntent: intent, requestDigest }, invocation })
  const holder = runtime.createSelectedSourceHolder(operation), targetPath = join(sessions, 'target.jsonl')
  const paths = selectedBootstrapPaths(targetPath, { protocol: 'public-results-v1', request: { invocation, core, requestIntent: intent } })
  return { holder, targetPath, paths, coordinator,
    async close() { await holder.close(); await runtime.close(); await projects.close(); await coordinator.close() } }
}

it('does not confirm a foreign equal header after original stage promotion but before target header issuance', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), f = await fixture('stage-only')
  let promoted = false, headerWrites = 0
  vi.mocked(rename).mockImplementation(async (from, to) => {
    await fs.rename(from, to)
    if (from === f.paths.promote) { promoted = true; throw Object.assign(Error('uncertain promotion'), { code: 'EIO' }) }
  })
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (path === f.targetPath && flags !== 'r') headerWrites++
    return fs.open(path, flags, mode)
  })
  try {
    const captured = await f.holder.captureFirst()
    expect(captured.kind).toBe('captured'); if (captured.kind !== 'captured') throw Error('capture unavailable')
    expect(promoted).toBe(true); expect(headerWrites).toBe(0)
    expect(await readFile(f.paths.stage, 'utf8')).toBe(captured.stageBytes)
    await expect(readFile(f.targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(f.targetPath, captured.headerBytes)
    expect((await f.holder.reconcilePassive()).kind).toBe('unknown')
  } finally { vi.mocked(rename).mockImplementation(fs.rename); vi.mocked(open).mockImplementation(fs.open); await f.close() }
})

it('reconciles the original header after its real target sync reports uncertainty', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), f = await fixture('header-issued')
  let headerWrites = 0
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode)
    if (path === f.targetPath && flags === 'wx') {
      headerWrites++
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementationOnce(async () => { await sync(); throw Object.assign(Error('uncertain target sync'), { code: 'EIO' }) })
    }
    return handle
  })
  try {
    const captured = await f.holder.captureFirst()
    expect(captured.kind).toBe('captured'); if (captured.kind !== 'captured') throw Error('capture unavailable')
    expect(headerWrites).toBe(1); expect(await readFile(f.targetPath, 'utf8')).toBe(captured.headerBytes)
    expect((await f.holder.reconcilePassive()).kind).toBe('committed')
    const flush = vi.spyOn(f.coordinator, 'flush')
    expect(await f.holder.captureWarm()).toBe(captured)
    expect(flush).not.toHaveBeenCalled(); expect(headerWrites).toBe(1)
    flush.mockRestore()
  } finally { vi.mocked(open).mockImplementation(fs.open); await f.close() }
})

it('rejects self-close from a passive callback and then drains the original holder externally', async () => {
  const f = await fixture('passive-close')
  let selfClose: Promise<string> | undefined
  try {
    await f.holder.captureFirst()
    const flush = vi.spyOn(f.coordinator, 'flush')
    await f.holder.passive(async handoff => {
      expect('source' in handoff).toBe(false)
      selfClose = f.holder.close().then(() => 'closed', error => error.message as string)
      const result = await Promise.race([selfClose, new Promise<string>(resolve => setImmediate(() => resolve('self-close blocked')))])
      expect(result).toBe('Selected handoff self-close')
    })
    expect(flush).not.toHaveBeenCalled(); flush.mockRestore()
    await f.holder.close()
    expect(() => f.holder.reconcilePassive()).toThrow('retired')
  } finally { await selfClose; await f.close() }
})
