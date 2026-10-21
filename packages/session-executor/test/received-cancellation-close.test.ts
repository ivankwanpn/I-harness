import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { subscribe, type FactOutcome } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService, createDurableSessionLoader } from '../src/index.ts'
import { receivedInputsFor } from '../src/lifecycle/received-inputs.ts'

it.each([
  { cold: false, before: true, controller: false }, { cold: false, before: false, controller: false },
  { cold: true, before: true, controller: false }, { cold: true, before: false, controller: false },
  { cold: false, before: true, controller: true }, { cold: true, before: true, controller: true },
])('settles cancellation losing to an issued promotion (cold=$cold, close-before-install=$before, caller-stop=$controller)', async ({ cold, before, controller }) => {
  const root = await mkdtemp(join(tmpdir(), 'received-close-')), backend = createJsonlBackend(join(root, 'sessions'))
  let coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const input = { inputId: 'parent-notify-controlled', text: 'Trusted system observation', intent: 'system' as const, delivery: 'steer' as const, provenance: { kind: 'child-report' as const, authority: 'observation' as const, scope: 'turn' as const, producer: 'session.notification' } }
  if (cold) {
    const first = await coordinator.openManagedDocument('parent')
    await receivedInputsFor(first).inbox.admit(input)
    await coordinator.close()
    coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  }
  const document = await coordinator.openManagedDocument('parent'), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), captured = Promise.withResolvers<void>()
  const append = backend.appendOwnedBatch!.bind(backend), outcomes: FactOutcome[] = []
  let promotions = 0, captures = 0
  backend.appendOwnedBatch = async (...args) => {
    const promotion = JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((event: { type: string; inputId?: string }) => event.type === 'agent/input/promoted' && event.inputId === input.inputId)
    const outcome = await append(...args)
    if (promotion) { expect(outcome.kind).toBe('committed'); promotions++; entered.resolve(); await release.promise }
    return outcome
  }
  const register = document.registerReceivedInputSource.bind(document)
  document.registerReceivedInputSource = drain => {
    const source = register(drain), capture = source.captureCancellation.bind(source)
    source.captureCancellation = event => {
      const fact = capture(event), admit = fact.admit.bind(fact)
      captures++; captured.resolve()
      fact.admit = async () => { const outcome = await admit(); outcomes.push(outcome); return outcome }
      return fact
    }
    return source
  }
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.writeHead(500).end('Unexpected notification model send') })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'main', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model, codeMode: { mode: 'off' } })
  let run: Promise<void> | undefined, closing: Promise<void> | undefined, off: (() => void) | undefined, closeError: unknown, journal: unknown, runStopped = false
  const caller = new AbortController()
  const errors: unknown[] = [], deadline = Promise.withResolvers<never>()
  const watchdog = setTimeout(() => { release.resolve(); deadline.reject(Error('Held promotion deadline')) }, 15_000); watchdog.unref()
  const bounded = <T,>(promise: Promise<T>) => Promise.race([promise, deadline.promise])
  try {
    const assembly = await service.assemblyFor('parent')
    if (!cold) await (await service.receivedInputFor('parent')).admit(input)
    const close = () => { closing ??= service.close(); void closing.catch(() => {}); return closing }
    if (!before && !controller) off = subscribe(document.view, event => { if (event.type === 'agent/input/preparation' && event.op === 'promoted' && event.inputId === input.inputId) void close() })
    run = service.submit('parent', input.text, caller.signal, { admittedInputId: input.inputId }); void run.catch(() => {})
    await bounded(entered.promise)
    expect((await backend.read('parent')).events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
    expect(assembly.inbox.isPending(input.inputId)).toBe(true)
    if (controller) caller.abort(Error('Actual caller Stop at issued promotion'))
    else if (before) { void close(); await bounded(captured.promise) }
    release.resolve()
    await bounded(run).catch(() => { runStopped = true })
    if (controller) closing = service.close()
    await bounded(closing!).catch(error => { closeError = error })
    const events = (await backend.read('parent')).events; journal = events
    expect(promotions).toBe(1); expect(requests).toBe(0); expect(runStopped).toBe(true)
    expect(captures).toBe(before && !controller ? 1 : 0)
    expect(events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/input/cancelled')).toHaveLength(0)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'close' && event.disposition === 'stopped')).toHaveLength(1)
    if (before && !controller) expect(outcomes).toEqual([{ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }])
    expect(closeError, 'The original source must drain its superseded never-issued cancellation').toBeUndefined()
  } finally {
    release.resolve(); off?.()
    if (run) await bounded(run).catch(() => {})
    await bounded(service.close()).catch(error => errors.push(error))
    await bounded(coordinator.close()).catch(error => errors.push(error))
    clearTimeout(watchdog); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()))
    const evidence = process.env.IH_CANCELLATION_EVIDENCE_ROOT
    if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, `received-${cold ? 'cold' : 'warm'}-${controller ? 'controller' : before ? 'before' : 'after'}.json`), JSON.stringify({ cold, before, controller, promotions, captures, outcomes, requests, runStopped, closeError: closeError ? String(closeError) : undefined, journal, cleanupErrors: errors.map(String) }, null, 2)) }
    await rm(root, { recursive: true, force: true })
  }
})
