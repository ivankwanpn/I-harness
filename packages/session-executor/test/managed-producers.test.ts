import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { type BatchKey } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createTodoTool } from '@i-harness/todo'
import { enterPlanMode } from '@i-harness/plan-mode'
import { createRuntimeContext } from '@i-harness/runtime-context'
import { createScheduleTools } from '@i-harness/schedule/tools'
import { applyTitle } from '../../session-title/src/index.ts'
import { createSessionAssembly } from '../src/assembly.ts'

it.each(['todo', 'plan', 'runtime', 'schedule', 'title'] as const)('publishes %s through its actual producer only after the managed receipt', async producer => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-producer-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { entered.resolve(); await release.promise; return actual(...args) }
  const runtime = createRuntimeContext(document.view as any, document.agent)
  runtime.registerSection('test', () => 'current source')
  try {
    const work = producer === 'todo'
      ? createTodoTool({ session: document.view as any, metadata: document.metadata }).execute({ todos: [{ content: 'work', status: 'pending' }] }, {})
      : producer === 'plan' ? enterPlanMode(document.view as any, 'approved proposal', document.metadata)
        : producer === 'runtime' ? runtime.render()
          : producer === 'schedule' ? createScheduleTools({ session: document.view as any, metadata: document.metadata })[0]!.execute({ prompt: 'remember', after_seconds: 10 }, {})
            : applyTitle(document.view as any, 'Committed title', 'user', [], document.metadata)
    const settled = Promise.resolve(work)
    // A producer rejection also surfaces promptly rather than hanging on the gate.
    await Promise.race([entered.promise, settled])
    expect(document.view.events).toEqual([])
    release.resolve(); await settled
    const expected = producer === 'todo' ? ['todo/write'] : producer === 'plan' ? ['plan/mode', 'user/message'] : producer === 'runtime' ? ['user/message'] : producer === 'schedule' ? ['schedule/change'] : ['session/title']
    expect(document.view.events.map(event => event.type)).toEqual(expected)
    expect((await backend.read(id)).events.map(event => event.type)).toEqual(expected)
  } finally { release.resolve(); await coordinator.close() }
})

it('shares adjacent runtime snapshots through the actual assembly feedback factory while its receipt is held', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-runtime-assembly-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let sends = 0
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, codeMode: { mode: 'off' }, sandbox: 'read-only', model: { async *stream() { sends++; yield { type: 'end' } } } })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), append = backend.appendOwnedBatch!
  let writes = 0, settled = 0
  backend.appendOwnedBatch = async (...args) => { writes++; entered.resolve(); await release.promise; return append(...args) }
  const signal = new AbortController().signal
  const payload = { task: 'runtime snapshot', session: assembly.session, signal }
  const first = assembly.ctx.emit('agent/pre-step', payload).then(() => { settled++ })
  await Promise.race([entered.promise, first.then(() => { throw new Error('No runtime receipt hold') })])
  const second = assembly.ctx.emit('agent/pre-step', payload).then(() => { settled++ })
  try {
    expect(settled).toBe(0)
    expect(assembly.session.events.filter(event => event.type === 'user/message')).toEqual([])
    release.resolve()
    await Promise.all([first, second])
    expect([writes, sends, settled]).toEqual([1, 0, 2])
    expect(assembly.session.events.filter(event => event.type === 'user/message' && event.source?.plugin === 'i-harness/runtime-context')).toHaveLength(1)
  } finally { release.resolve(); await Promise.allSettled([first, second]); await assembly.dispose(); await coordinator.close() }
})

it('invalidates runtime dedupe knowledge after unknown so a reconciled newer snapshot cannot hide a return to old text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-runtime-unknown-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const append = backend.appendOwnedBatch!
  let writes = 0, unknown: BatchKey | undefined, text = 'A'
  backend.appendOwnedBatch = async (...args) => {
    writes++
    const outcome = await append(...args)
    if (writes === 2) { unknown = args[3].key; return { kind: 'unknown', key: unknown } }
    return outcome
  }
  const runtime = createRuntimeContext(document.view, document.agent)
  runtime.registerSection('state', () => text)
  try {
    await runtime.render()
    text = 'B'
    await expect(runtime.render()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(document.view.events.filter(event => event.type === 'user/message').map(event => event.text)).toEqual(['## state\n\nA'])
    expect((await document.reconcile(unknown!)).kind).toBe('committed')
    text = 'A'
    await runtime.render()
    expect(writes).toBe(3)
    expect(document.view.events.filter(event => event.type === 'user/message').map(event => event.text)).toEqual(['## state\n\nA', '## state\n\nB', '## state\n\nA'])
  } finally { await coordinator.close() }
})

it('shares one pending runtime snapshot across overlapping render calls until its original receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-runtime-overlap-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), append = backend.appendOwnedBatch!
  let writes = 0, firstSettled = false, secondSettled = false
  backend.appendOwnedBatch = async (...args) => {
    writes++
    entered.resolve()
    await release.promise
    return append(...args)
  }
  const runtime = createRuntimeContext(document.view, document.agent)
  let text = 'one immutable snapshot'
  runtime.registerSection('held', () => text)
  const first = runtime.render().then(() => { firstSettled = true })
  await entered.promise
  const second = runtime.render().then(() => { secondSettled = true })
  try {
    expect([firstSettled, secondSettled]).toEqual([false, false])
    expect(document.view.events).toEqual([])
    expect(writes).toBe(1)
    release.resolve()
    await Promise.all([first, second])
    await runtime.render()
    expect(writes).toBe(1)
    expect(document.view.events).toEqual([expect.objectContaining({ type: 'user/message', text: '## held\n\none immutable snapshot' })])
    text = 'second'
    const changed = runtime.render()
    text = 'third'
    const third = runtime.render()
    text = 'second'
    const back = runtime.render()
    await Promise.all([changed, third, back])
    expect(document.view.events.filter(event => event.type === 'user/message').map(event => event.text)).toEqual([
      '## held\n\none immutable snapshot', '## held\n\nsecond', '## held\n\nthird', '## held\n\nsecond',
    ])
    expect((await backend.read(id)).events).toEqual(document.view.events)
  } finally {
    release.resolve()
    await Promise.allSettled([first, second])
    await coordinator.close()
  }
})
