import { controlledModel } from "./controlled-model.ts"
import { afterEach, vi, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { maybeAutoTitle } from '../../session-title/src/index.ts'
import { createSessionService } from '../src/service.ts'

it('keeps the original service action fenced while the post-turn binding await yields to Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-title-binding-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), controller = new AbortController()
  let titleSends = 0, callbacks = 0, opened = 0
  const service = createSessionService({ workspace: root, coordinator, model: controlledModel(async function* () { yield { type: 'text/chunk', text: 'answer' }; yield { type: 'end' } }), afterSuccessfulSubmit: async (_id, assembly, _limits, action) => {
    callbacks++
    await maybeAutoTitle({ session: assembly.session, action, model: controlledModel(async function* () { titleSends++; yield { type: 'text/chunk', text: 'title' }; yield { type: 'end' } }) })
  } })
  try {
    const assembly = await service.assemblyFor(id), begin = assembly.factOwner.beginAction.bind(assembly.factOwner)
    vi.spyOn(assembly.factOwner, 'beginAction').mockImplementation(signal => {
      const action = begin(signal)
      if (assembly.session.events.some(event => event.type === 'turn/end')) { opened++; queueMicrotask(() => controller.abort(new Error('Stop during original binding await'))) }
      return action
    })
    await service.submit(id, 'original prompt', controller.signal)
    expect([opened, callbacks, titleSends]).toEqual([1, 0, 0])
    expect(assembly.session.events.some(event => event.type === 'session/title')).toBe(false)
  } finally { await service.close(); await coordinator.close() }
})

it('passes the same original service title action across a held real profile lookup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-title-profile-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), controller = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const profile = coordinator.profile.bind(coordinator)
  let titleSends = 0, callbacks = 0
  const service = createSessionService({ workspace: root, coordinator, model: controlledModel(async function* () { yield { type: 'text/chunk', text: 'answer' }; yield { type: 'end' } }), afterSuccessfulSubmit: async (_id, assembly, _limits, action) => {
    callbacks++
    expect(action.view).toBe(assembly.session)
    const pending = profile(id).then(async result => { entered.resolve(); await release.promise; return result })
    await pending
    await maybeAutoTitle({ session: assembly.session, action, model: controlledModel(async function* () { titleSends++; yield { type: 'text/chunk', text: 'late title' }; yield { type: 'end' } }) })
  } })
  const running = service.submit(id, 'original prompt', controller.signal)
  void running.catch(() => {})
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('No actual post-turn profile hold') })])
    controller.abort(new Error('Stop during original profile await'))
    release.resolve()
    await running
    expect([callbacks, titleSends]).toEqual([1, 0])
    expect(service.liveSession(id)?.events.some(event => event.type === 'session/title')).toBe(false)
  } finally { release.resolve(); await running.catch(() => {}); await service.close(); await coordinator.close() }
})

it('keeps only the actual post-turn row cancellable and clears its phase after both callbacks finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-post-turn-row-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let callbacks = 0, sends = 0
  let original: Parameters<NonNullable<import('../src/service.ts').SessionServiceOptions['afterSuccessfulSubmit']>>[3] | undefined
  let completed: typeof original
  const service = createSessionService({ workspace: root, coordinator, model: controlledModel(async function* () { sends++; yield { type: 'text/chunk', text: 'answer' }; yield { type: 'end' } }), afterSuccessfulSubmit: async (_id, _assembly, _limits, action) => {
    if (++callbacks === 1) { original = action; entered.resolve(); await release.promise; action.assertOpen() }
    else completed = action
  } })
  const first = service.submit(id, 'first real turn', new AbortController().signal)
  void first.catch(() => {})
  let second: Promise<void> | undefined
  try {
    await entered.promise
    second = service.submit(id, 'ordinary queued next turn', new AbortController().signal)
    const queue = service.queue(id)
    expect(queue.map(row => [row.text, row.state])).toEqual([['first real turn', 'running'], ['ordinary queued next turn', 'queued']])
    expect(await service.cancelQueued(id, queue[0]!.id)).toEqual({ cancelled: false })
    expect(service.cancelRunning!(id)).toEqual({ cancelled: true })
    expect(original!.signal.aborted).toBe(true)
    expect(service.cancelRunning!(id)).toEqual({ cancelled: false })
    release.resolve()
    await Promise.all([first, second])
    expect([sends, callbacks]).toEqual([2, 2])
    expect(() => completed!.assertOpen()).toThrow()
    expect(service.queue(id)).toEqual([])
    expect(service.cancelRunning!(id)).toEqual({ cancelled: false })
  } finally { release.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); await service.close(); await coordinator.close() }
})

afterEach(() => vi.unstubAllGlobals())
