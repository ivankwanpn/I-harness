import { controlledModel } from "./controlled-model.ts"
import { afterEach, vi, expect, it } from 'vitest'
import { mkdtemp, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/service.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

it('retains the real completed tool and service attachment at ticket65 through unknown close, then saves its original outcome and full closers once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-service-ticket65-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const bodyEntered = Promise.withResolvers<void>(), bodyRelease = Promise.withResolvers<void>(), captured = Promise.withResolvers<void>()
  const syncing = Promise.withResolvers<void>(), syncRelease = Promise.withResolvers<void>()
  let effects = 0, finalizations = 0, conversions = 0, sends = 0, fault = false
  const service = createSessionService({
    workspace: root, coordinator, codeMode: { mode: 'off' },
    additionalTools: [{ name: 'completed', description: '', inputSchema: {}, isReadOnly: true, async execute() {
      effects++; bodyEntered.resolve(); await bodyRelease.promise
      return { toJSON() { conversions++; captured.resolve(); return { value: 'the original completed outcome' } } }
    } }],
    model: controlledModel(async function* () { sends++; yield { type: 'tool_call', call: { id: 'c', name: 'completed', args: {} } }; yield { type: 'end' } }),
  })
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await native.open(...args)
    if (String(args[0]) !== join(root, id + '.jsonl') || args[1] !== 'r+') return handle
    return new Proxy(handle, { get(target, name) {
      if (name === 'sync') return async () => {
        if (!fault) return target.sync()
        syncing.resolve(); await syncRelease.promise; throw new Error('controlled unresolved sync')
      }
      if (name === 'truncate') return async (size: number) => {
        if (fault) throw new Error('controlled unresolved rollback')
        return target.truncate(size)
      }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  let execution: Promise<void> | undefined
  try {
    const assembly = await service.assemblyFor(id), document = await coordinator.openManagedDocument(id)
    assembly.ctx.on('tools/post-execute', () => { finalizations++ })
    execution = service.submit(id, 'complete one real tool', new AbortController().signal)
    void execution.catch(() => {})
    await bodyEntered.promise
    fault = true
    const admissions = Array.from({ length: 64 }, () => document.metadata.admit({ type: 'plan/mode', mode: 'off' }))
    await syncing.promise
    bodyRelease.resolve(); await captured.promise
    const closing = service.closeSession(id)
    const rejected = expect(closing).rejects.toThrow()
    syncRelease.resolve()
    const outcomes = await Promise.all(admissions)
    await rejected
    await expect(execution).rejects.toThrow()
    expect(service.hasAssembly(id)).toBe(true)
    expect(service.liveSession(id)).toBe(assembly.session)
    await expect(service.assemblyFor(id)).rejects.toThrow(/cleanup incomplete/)
    expect(coordinator.ownerOf(id)).toBe(true)
    expect([effects, finalizations, conversions, sends]).toEqual([1, 1, 1, 1])
    expect(document.view.events.some(event => event.type === 'tool/result')).toBe(false)
    const unknown = outcomes[0]!
    if (unknown.kind !== 'unknown') throw new Error('Expected the issued 64-group frame to remain unknown')
    fault = false
    await document.reconcile(unknown.key)
    await service.closeSession(id)
    const saved = (await backend.read(id)).events
    expect(saved.filter(event => event.type === 'tool/result')).toEqual([expect.objectContaining({ callId: 'c', output: { value: 'the original completed outcome' } })])
    expect(saved.filter(event => event.type === 'step/end')).toHaveLength(1)
    expect(saved.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(saved.map(event => event.seq)).toEqual(saved.map((_, index) => index))
    expect(service.liveAssembly(id)).toBeUndefined()
    expect([effects, finalizations, conversions, sends]).toEqual([1, 1, 1, 1])
  } finally {
    fault = false; bodyRelease.resolve(); syncRelease.resolve()
    vi.mocked(open).mockImplementation(native.open)
    await execution?.catch(() => {})
    await service.close().catch(() => {}); await coordinator.close().catch(() => {})
  }
}, 3000)

afterEach(() => vi.unstubAllGlobals())
