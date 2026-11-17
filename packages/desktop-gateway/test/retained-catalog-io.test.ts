import { expect, it, vi } from 'vitest'
const measured = vi.hoisted(() => ({ enabled: false, paths: new Set<string>(), fullReads: [] as string[], windows: [] as { path: string; requested: number; returned: number }[], artifactReads: 0 }))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native,
    readFile: async (...args: Parameters<typeof native.readFile>) => { if (measured.enabled && measured.paths.has(String(args[0]))) measured.fullReads.push(String(args[0])); return native.readFile(...args) },
    open: async (...args: Parameters<typeof native.open>) => {
      const handle = await native.open(...args), path = String(args[0])
      if (!measured.enabled) return handle
      if (/[\\/]managed-v1[\\/].*[\\/]body$/.test(path)) measured.artifactReads++
      if (!measured.paths.has(path)) return handle
      return new Proxy(handle, { get(target, key) {
        if (key === 'read') return async (...params: any[]) => { const result = await (target.read as any)(...params); measured.windows.push({ path, requested: params[2], returned: result.bytesRead }); return result }
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
      } })
    },
  }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService, createDurableSessionLoader, createUnmanagedTaskChildHost } from '@i-harness/session-executor'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createDesktopSubagents } from '../src/session-subagents.ts'
import { dispatchOwned } from './helpers/native-consumer-fixture.ts'

it('a fresh retained catalog uses bounded real header windows independent of marked child transcript size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marked-child-catalog-io-'))
  let coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }), sends = 0
  await coordinator.create({ sessionId: 'parent' })
  const service = createSessionService({ workspace: root, coordinator, prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }), approveAll: true, sessionFor: createDurableSessionLoader(coordinator), model: controlledModel(async function* () { yield { type: 'text/chunk', text: 'x'.repeat(++sends === 1 ? 65536 : 1_048_576) }; yield { type: 'end' } }) })
  let catalog: ReturnType<typeof createDesktopSubagents> | undefined, cold: ReturnType<typeof createSessionService> | undefined
  try {
    const assembly = await service.assemblyFor('parent')
    for (const name of ['small', 'large']) {
      const spawned = await dispatchOwned(assembly, 'spawn_agent', { task_name: name, agent_type: 'explore', message: 'An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),\nallow (ask the user first), or deny (never execute).\n<request>x</request>\n<recent_context>x</recent_context>\nOutput STRICT JSON only', background: false }) as any
      const entry = assembly.subagentState().agentTable.find(row => row.path === spawned.agent_path)!
      measured.paths.add(join(root, `${entry.sessionId}.jsonl`))
      await dispatchOwned(assembly, 'close_agent', { target: spawned.agent_path })
    }
    await service.close(); await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    if (!coordinator.snapshot) throw new Error('Actual coordinator snapshot capability unavailable')
    const snapshots = vi.spyOn(coordinator as typeof coordinator & { snapshot: NonNullable<typeof coordinator.snapshot> }, 'snapshot'), assemble = vi.fn()
    // The catalog is built over the ORIGINAL service for this coordinator; its
    // live-assembly readers are then substituted so any live fallback fails the
    // count. A hand-built service shape is not an admissible owner.
    cold = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }) })
    vi.spyOn(cold, 'liveAssembly').mockReturnValue(undefined)
    vi.spyOn(cold, 'liveSession').mockReturnValue(undefined)
    vi.spyOn(cold, 'assemblyFor').mockImplementation(assemble as never)
    catalog = createDesktopSubagents(coordinator, cold)
    measured.enabled = true
    const result = await catalog.list('parent')
    measured.enabled = false
    expect(result.agents).toHaveLength(2)
    expect(result.agents.every(row => row.status === 'completed' && row.fullResult?.resultRevision)).toBe(true)
    for (const path of measured.paths) {
      const windows = measured.windows.filter(row => row.path === path)
      expect(windows.map(row => row.requested)).toEqual([65536])
      expect(windows[0]!.returned).toBe(65536)
      expect(snapshots.mock.calls.some(([id]) => path === join(root, `${id}.jsonl`))).toBe(false)
    }
    expect(measured.fullReads).toEqual([]); expect(measured.artifactReads).toBe(0)
    expect(assemble).not.toHaveBeenCalled(); expect(sends).toBe(2)
  } finally { measured.enabled = false; measured.paths.clear(); measured.windows = []; measured.fullReads = []; measured.artifactReads = 0; await catalog?.close(); await cold?.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
