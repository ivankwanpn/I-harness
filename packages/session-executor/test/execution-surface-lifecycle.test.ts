import { expect, it } from 'vitest'
import { createSession } from '@i-harness/core-session'
import { createSessionService, type SessionService } from '../src/service.ts'
import type { SessionAssembly } from '../src/assembly.ts'

type Event = { sessionId: string; assembly: SessionAssembly; kind: 'published' | 'retiring' | 'removed' }
function service(options: Partial<Parameters<typeof createSessionService>[0]> = {}): SessionService {
  return createSessionService({ workspace: process.cwd(), session: createSession(), model: { async *stream() { yield { type: 'end' } } }, ...options })
}

it('publishes exact owners, retires synchronously once, and removes only after real cleanup', async () => {
  const owner = service(), events: Event[] = []
  const off = owner.onExecutionSurfaceLifecycle?.(event => events.push(event))
  owner.onExecutionSurfaceLifecycle?.(() => { throw new Error('consumer failure') })
  try {
    const first = await owner.assemblyFor('s')
    expect(events).toEqual([{ sessionId: 's', assembly: first, kind: 'published' }])
    expect(first.executionSurfaceState?.()).toBe('available')
    const changes: string[] = []
    first.onExecutionSurfaceChanged?.(() => changes.push(first.executionSurfaceState!()))
    first.revokeNewWork()
    expect(first.executionSurfaceState?.()).toBe('retired')
    expect(events.at(-1)).toEqual({ sessionId: 's', assembly: first, kind: 'retiring' })
    first.revokeNewWork()
    expect(changes).toEqual(['retired'])
    await owner.closeSession('s')
    expect(events.map(e => e.kind)).toEqual(['published', 'retiring', 'removed'])
    const second = await owner.assemblyFor('s')
    expect(second).not.toBe(first)
    expect(events.at(-1)).toEqual({ sessionId: 's', assembly: second, kind: 'published' })
    off?.(); const count = events.length
    await owner.close()
    expect(events).toHaveLength(count)
  } finally { await owner.close().catch(() => {}) }
})

it('retains failed cleanup as retiring debt and never republishes it on retry or includeExisting', async () => {
  let fail = true
  const owner = service({ workspace: process.cwd(), codeMode: { mode: 'mixed' }, codeModeFactory: () => ({ schemas: () => [], surfaceState: () => 'available', onSurfaceChanged: () => () => {}, async cancel() {}, async dispose() { if (fail) throw new Error('original mount cleanup held') } }) })
  const events: Event[] = []
  owner.onExecutionSurfaceLifecycle?.(event => events.push(event))
  try {
    const assembly = await owner.assemblyFor('s')
    const closing = owner.closeSession('s')
    expect(assembly.executionSurfaceState?.()).toBe('retired')
    await expect(closing).rejects.toThrow()
    expect(events.map(e => e.kind)).toEqual(['published', 'retiring'])
    const existing: Event[] = []
    owner.onExecutionSurfaceLifecycle?.(event => existing.push(event), { includeExisting: true })
    expect(existing).toEqual([{ sessionId: 's', assembly, kind: 'retiring' }])
    fail = false; await owner.closeSession('s')
    expect(events.map(e => e.kind)).toEqual(['published', 'retiring', 'removed'])
    expect(existing.at(-1)?.kind).toBe('removed')
  } finally { fail = false; await owner.close().catch(() => {}) }
})

it('registers before includeExisting enumeration and fences reentrant revoke for subsequent consumers', async () => {
  const owner = service()
  try {
    const assembly = await owner.assemblyFor('s'), seen: string[] = []
    owner.onExecutionSurfaceLifecycle?.(event => {
      seen.push(event.kind)
      if (event.kind === 'published') event.assembly.revokeNewWork()
    }, { includeExisting: true })
    expect(seen).toEqual(['published', 'retiring'])
    const after: Event[] = []
    owner.onExecutionSurfaceLifecycle?.(event => after.push(event), { includeExisting: true })
    expect(after).toEqual([{ sessionId: 's', assembly, kind: 'retiring' }])
  } finally { await owner.close() }
})

it('requires both actual mount observation methods and forwards changes only while owned', async () => {
  let changed: (() => void) | undefined, detached = 0
  let state: 'available' | 'unavailable' = 'available'
  const owner = service({ workspace: process.cwd(), codeMode: { mode: 'mixed' }, codeModeFactory: () => ({ schemas: () => [], surfaceState: () => state, onSurfaceChanged(listener) { changed = listener; return () => { detached++ } }, async cancel() {}, async dispose() {} }) })
  try {
    const assembly = await owner.assemblyFor('s'), states: string[] = []
    assembly.onExecutionSurfaceChanged?.(() => states.push(assembly.executionSurfaceState!()))
    expect(assembly.executionSurfaceState?.()).toBe('available')
    state = 'unavailable'; changed?.()
    expect(states).toEqual(['unavailable'])
    const closing = assembly.dispose()
    expect(assembly.executionSurfaceState?.()).toBe('retired')
    await closing
    expect(detached).toBe(1)
    changed?.()
    expect(states).toEqual(['unavailable', 'retired'])
  } finally { await owner.close() }
  const legacy = service({ workspace: process.cwd(), codeMode: { mode: 'mixed' }, codeModeFactory: () => ({ schemas: () => [], async cancel() {}, async dispose() {} }) })
  try { expect((await legacy.assemblyFor('s')).executionSurfaceState?.()).toBe('unavailable') } finally { await legacy.close() }
})

it('does not publish a mounting owner as live and retires it before a pending mount completes', async () => {
  const entered = Promise.withResolvers<SessionAssembly>(), release = Promise.withResolvers<void>()
  const owner = service({ workspace: process.cwd(), extensionsFor: async () => ({ options: {}, mount: async assembly => { entered.resolve(assembly); await release.promise } }) })
  const events: Event[] = []
  try {
    const building = owner.assemblyFor('s'); void building.catch(() => {})
    const assembly = await entered.promise
    owner.onExecutionSurfaceLifecycle?.(event => events.push(event), { includeExisting: true })
    expect(events).toEqual([])
    const closing = owner.closeSession('s')
    expect(assembly.executionSurfaceState?.()).toBe('retired')
    expect(events).toEqual([{ sessionId: 's', assembly, kind: 'retiring' }])
    release.resolve(); await expect(building).rejects.toThrow('session closing')
    await closing
    expect(events.map(event => event.kind)).toEqual(['retiring', 'removed'])
  } finally { release.resolve(); await owner.close() }
})

it('retires direct disposal before the original extension cleanup await', async () => {
  const release = Promise.withResolvers<void>()
  const owner = service({ workspace: process.cwd(), extensionsFor: async () => ({ options: {}, mount: async () => async () => { await release.promise } }) })
  try {
    const assembly = await owner.assemblyFor('s')
    const closing = assembly.dispose()
    expect(assembly.executionSurfaceState?.()).toBe('retired')
    release.resolve(); await closing
  } finally { release.resolve(); await owner.close() }
})

it('forwards actual default register installation and terminal removal through the real assembly', async () => {
  const owner = service({ workspace: process.cwd(), codeMode: { mode: 'mixed' } })
  try {
    const assembly = await owner.assemblyFor('s'), live: number[] = []
    assembly.onExecutionSurfaceChanged?.(() => { if (assembly.executionSurfaceState?.() === 'available') live.push(assembly.liveResources!().codeCells.length) })
    const result = await assembly.tools.execute({ name: 'code_exec', args: { code: 'await new Promise(() => {})', yield_time_ms: 0 } })
    const id = (result.output as { cell_id: string }).cell_id
    expect(live).toContain(1)
    await assembly.stopCodeCell!(id)
    expect(live.at(-1)).toBe(0)
    expect(assembly.executionSurfaceState?.()).toBe('available')
  } finally { await owner.close() }
})

it('retires every exact owner synchronously on closeAll before pending original cleanup', async () => {
  const release = Promise.withResolvers<void>()
  const owner = service({ workspace: process.cwd(), extensionsFor: async () => ({ options: {}, mount: async () => async () => { await release.promise } }) })
  const events: Event[] = []
  owner.onExecutionSurfaceLifecycle?.(event => events.push(event))
  try {
    const first = await owner.assemblyFor('a'), second = await owner.assemblyFor('b')
    const closing = owner.close()
    expect(first.executionSurfaceState?.()).toBe('retired')
    expect(second.executionSurfaceState?.()).toBe('retired')
    expect(events.map(event => [event.sessionId, event.kind])).toEqual([['a', 'published'], ['b', 'published'], ['a', 'retiring'], ['b', 'retiring']])
    const existing: Event[] = []
    owner.onExecutionSurfaceLifecycle?.(event => existing.push(event), { includeExisting: true })
    expect(existing.map(event => [event.sessionId, event.kind])).toEqual([['a', 'retiring'], ['b', 'retiring']])
    release.resolve(); await closing
    expect(events.slice(-2)).toEqual([{ sessionId: 'a', assembly: first, kind: 'removed' }, { sessionId: 'b', assembly: second, kind: 'removed' }])
  } finally { release.resolve(); await owner.close() }
})

it('never delivers a stale published event after an earlier listener retires that same owner', async () => {
  const owner = service(), after: Event[] = []
  owner.onExecutionSurfaceLifecycle?.(event => { if (event.kind === 'published') event.assembly.revokeNewWork() })
  owner.onExecutionSurfaceLifecycle?.(event => after.push(event))
  try {
    const assembly = await owner.assemblyFor('s')
    expect(after).toEqual([{ sessionId: 's', assembly, kind: 'retiring' }])
    expect(assembly.executionSurfaceState?.()).toBe('retired')
  } finally { await owner.close() }
})

it('forwards creation of a workflow job when the collection was empty', async () => {
  const owner = service(), assembly = await owner.assemblyFor('workflow-observer')
  const changes: number[] = []
  const off = assembly.onExecutionSurfaceChanged!(() => changes.push(1))
  const { createWorkflowExecutor } = await import('@i-harness/workflow')
  const gate = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>()
  const executor = createWorkflowExecutor({ exec: { run: () => gate.promise } as never })
  try {
    executor.runWorkflow({ name: 'test', description: 'test', steps: [{ name: 'step', command: 'test' }] }, {}, 'workflow-observer')
    expect(changes.length).toBeGreaterThan(0)
    assembly.revokeNewWork(); const retired = changes.length
    gate.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
    await new Promise(resolve => setImmediate(resolve))
    expect(changes.length).toBe(retired)
  } finally { gate.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false }); off(); await owner.close() }
})
