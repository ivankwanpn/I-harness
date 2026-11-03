import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { decodeFactBatch, renderRuntimeContext, type BatchKey } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createTodoTool } from '@i-harness/todo'
import { enterPlanMode } from '@i-harness/plan-mode'
import { createRuntimeContext } from '@i-harness/runtime-context'
import { createScheduleTools } from '@i-harness/schedule/tools'
import { applyTitle } from '../../session-title/src/index.ts'
import { createRuntimeContextSource } from '../src/lifecycle/action-facts.ts'
import { createSessionAssembly } from '../src/assembly.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

it.each(['todo', 'plan', 'runtime', 'schedule', 'title'] as const)('publishes %s through its actual producer only after the managed receipt', async producer => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-producer-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { entered.resolve(); await release.promise; return actual(...args) }
  const runtime = createRuntimeContext(document.view as any, createRuntimeContextSource(document))
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
    const expected = producer === 'todo' ? ['todo/write'] : producer === 'plan' ? ['plan/mode', 'user/message'] : producer === 'runtime' ? ['runtime/context'] : producer === 'schedule' ? ['schedule/change'] : ['session/title']
    expect(document.view.events.map(event => event.type)).toEqual(expected)
    expect((await backend.read(id)).events.map(event => event.type)).toEqual(expected)
  } finally { release.resolve(); await coordinator.close() }
})

// A held real runtime receipt cannot become current or reach the model through
// the actual Agent admission; later admissions share the confirmed snapshot.
it('gates actual assembly Agent visibility on the runtime receipt and deduplicates later admissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-runtime-assembly-'))
  await writeFile(join(root, 'AGENTS.md'), 'CONTROLLED_ASSEMBLY_INSTRUCTION')
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const bodies: { messages: { role: string; content: unknown }[] }[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    bodies.push(JSON.parse(body))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback address')
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, codeMode: { mode: 'off' }, sandbox: 'read-only',
    model: createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: 'http://127.0.0.1:' + address.port }),
  })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), append = backend.appendOwnedBatch!
  let runtimeWrites = 0, otherWrites = 0, settled = false
  backend.appendOwnedBatch = async (...args) => {
    const runtime = decodeFactBatch(args[3].bytes).events.filter(event => event.type === 'runtime/context')
    if (runtime.length) { runtimeWrites += runtime.length; entered.resolve(); await release.promise }
    else otherWrites++
    return append(...args)
  }
  const run = assembly.agent.run('runtime snapshot', AbortSignal.timeout(10000)).then(result => { settled = true; return result })
  void run.catch(() => {})
  try {
    await Promise.race([entered.promise, run.then(() => { throw Error('No runtime receipt hold') })])
    expect(settled).toBe(false)
    expect(runtimeWrites).toBe(1)
    // Human input and step lifecycle facts legitimately precede publication.
    expect(otherWrites).toBeGreaterThan(0)
    expect(assembly.session.events.some(event => event.type === 'user/message')).toBe(true)
    expect(assembly.session.events.filter(event => event.type === 'runtime/context')).toEqual([])
    expect((await backend.read(id)).events.filter(event => event.type === 'runtime/context')).toEqual([])
    expect(bodies).toEqual([])
    release.resolve()
    expect((await run).finalText).toBe('done')
    await assembly.agent.followup('same scoped instructions')
    expect([runtimeWrites, bodies.length]).toEqual([1, 2])
    const expected = '### ' + join(root, 'AGENTS.md') + ' [scope: ' + root + ']\n\nCONTROLLED_ASSEMBLY_INSTRUCTION'
    const current = assembly.session.events.filter(event => event.type === 'runtime/context')
    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({ sections: expect.arrayContaining([{ name: 'instructions', text: expected }]) })
    expect((await backend.read(id)).events.filter(event => event.type === 'runtime/context')).toEqual(current)
    for (const body of bodies) {
      const visible = body.messages.filter(message => typeof message.content === 'string' && message.content.includes('CONTROLLED_ASSEMBLY_INSTRUCTION'))
      expect(visible).toHaveLength(1)
      expect(visible[0]!.content).toContain('## instructions\n\n' + expected)
      expect(visible[0]!.content).toBe(renderRuntimeContext(current[0]!.sections))
      expect(JSON.stringify(body).split('CONTROLLED_ASSEMBLY_INSTRUCTION')).toHaveLength(2)
    }
  } finally {
    release.resolve(); await run.catch(() => {}); await assembly.dispose(); await coordinator.close()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root)
  }
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
  const runtime = createRuntimeContext(document.view, createRuntimeContextSource(document))
  runtime.registerSection('state', () => text)
  try {
    await runtime.render()
    text = 'B'
    await expect(runtime.render()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(document.view.events.filter(event => event.type === 'runtime/context').map(event => renderRuntimeContext(event.sections))).toEqual(['## state\n\nA'])
    expect((await document.reconcile(unknown!)).kind).toBe('committed')
    text = 'A'
    await runtime.render()
    expect(writes).toBe(3)
    expect(document.view.events.filter(event => event.type === 'runtime/context').map(event => renderRuntimeContext(event.sections))).toEqual(['## state\n\nA', '## state\n\nB', '## state\n\nA'])
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
  const runtime = createRuntimeContext(document.view, createRuntimeContextSource(document))
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
    expect(document.view.events).toEqual([expect.objectContaining({ type: 'runtime/context', sections: [{ name: 'held', text: 'one immutable snapshot' }] })])
    text = 'second'
    const changed = runtime.render()
    text = 'third'
    const third = runtime.render()
    text = 'second'
    const back = runtime.render()
    await Promise.all([changed, third, back])
    expect(document.view.events.filter(event => event.type === 'runtime/context').map(event => renderRuntimeContext(event.sections))).toEqual([
      '## held\n\none immutable snapshot', '## held\n\nsecond', '## held\n\nthird', '## held\n\nsecond',
    ])
    expect((await backend.read(id)).events).toEqual(document.view.events)
  } finally {
    release.resolve()
    await Promise.allSettled([first, second])
    await coordinator.close()
  }
})
