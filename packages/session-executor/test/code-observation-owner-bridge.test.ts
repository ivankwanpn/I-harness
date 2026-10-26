import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, retainedToolOutcome, type PreparedCall } from '@i-harness/core-tools'
import { decodeFactBatch, type ManagedArtifactRef, type ProducerFactOutcome, type CapturedActionFact, type SettlementFacts } from '@i-harness/core-session'
import { executeToolCalls } from '@i-harness/core-agent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '@i-harness/context-output'
import { registerCodeMode } from '@i-harness/code-mode'
import { createCodeTextRetention } from '../src/lifecycle/code-text-retention.ts'

// Characterizations, not repair tests: the actual batch checkpoint abort can
// retire executable work before either hypothesized later operation is issued.
// All method observers return the original value/promise and delegate once.
// Only the explicitly labelled finish-visibility fault changes an outcome.
async function bridge(arm: 'H1' | 'H2') {
  const evidence = process.env.IH_BRIDGE_EVIDENCE_ROOT
  if (!evidence || !process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT) throw new Error('Fresh task evidence roots are required')
  const root = join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT, arm)
  await mkdir(root, { recursive: true })
  const trace: unknown[] = [], ids = new WeakMap<object, number>()
  let overflow = 0, nextId = 0, observerFailures = 0
  const label = (value: object) => { let id = ids.get(value); if (!id) { id = ++nextId; ids.set(value, id) }; return id }
  const record = (kind: string, data: object = {}) => { if (trace.length < 1000) trace.push({ seq: trace.length, kind, ...data }); else overflow++ }
  const errorInfo = (error: unknown, depth = 0): unknown => error && typeof error === 'object' ? {
    id: label(error), name: (error as Error).name, message: (error as Error).message,
    code: (error as { code?: string }).code,
    ...(depth < 4 && 'cause' in error ? { cause: errorInfo(error.cause, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.map(value => errorInfo(value, depth + 1)) } : {}),
  } : { value: String(error) }
  const observe = <T>(promise: Promise<T>, success: (value: T) => void, failure: (error: unknown) => void) => {
    void promise.then(success, failure).catch(error => {
      observerFailures++; record('fixture.observer.failed', { error: errorInfo(error) })
    }); return promise
  }
  const backend = createJsonlBackend(join(root, 's')), append = backend.appendOwnedBatch!
  const appends: unknown[] = []
  backend.appendOwnedBatch = (...args) => {
    const captured = { key: args[3].key, bytes: Buffer.from(args[3].bytes).toString('base64'), events: decodeFactBatch(args[3].bytes).events }
    appends.push(captured); record('journal.append', { key: captured.key, types: captured.events.map(event => event.type) })
    return observe(append.apply(backend, args), outcome => record('journal.receipt', { outcome }), error => record('journal.error', { error: errorInfo(error) }))
  }
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const gateEntered = Promise.withResolvers<void>(), releaseGate = Promise.withResolvers<void>()
  const storeOutcomes: ProducerFactOutcome[] = [], captures: object[] = []
  let batchSource: SettlementFacts<ProducerFactOutcome> | undefined, outputSource: SettlementFacts<ProducerFactOutcome> | undefined
  let batchHolds = 0, batchClosed = false, outputClosed = false, codeBodies = 0, gateBodies = 0
  let originalAborts = 0, registrationRefusals = 0
  let visibility = false, firstOperation: string | undefined, writes = 0, finishes = 0
  let actualReceipt: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof createContextOutputService>['beginResult']>>['finish']>> | undefined
  let actualRef: ManagedArtifactRef | undefined, readyOutput: unknown
  const beginAction = document.beginAction
  document.beginAction = function (...args) {
    const action = beginAction.apply(document, args), register = action.registerSettlementSource
    record('action.begin', { action: label(action), owned: document.ownsAction(action) })
    action.registerSettlementSource = function (...registerArgs) {
      record('source.register.attempt', { action: label(action) })
      let source: ReturnType<typeof register>
      try { source = register.apply(action, registerArgs) }
      catch (error) { registrationRefusals++; record('source.register.refused', { action: label(action), error: errorInfo(error) }); throw error }
      record('source.registered', { action: label(action), source: label(source) })
      const hold = source.holdRecovery, close = source.close, capture = source.code.capture
      source.holdRecovery = function () {
        const result = hold.call(source)
        if (source === batchSource) batchHolds++
        else outputSource ??= source
        record('source.hold', { source: label(source), batch: source === batchSource }); return result
      }
      source.close = function () {
        record('source.close.begin', { source: label(source) })
        return observe(close.call(source), () => {
          if (source === outputSource) outputClosed = true
          if (source === batchSource) batchClosed = true
          record('source.close.done', { source: label(source) })
        }, error => record('source.close.failed', { source: label(source), error: errorInfo(error) }))
      }
      source.code.capture = function (event) {
        const fact = capture.call(source.code, event)
        record('source.code.capture', { source: label(source), capture: label(fact), event })
        watchFact(fact, 'required'); return fact
      }
      return source
    }
    const captureStore = action.captureCodeStore, stop = action.stop
    action.captureCodeStore = function (event) {
      const fact = captureStore.call(action, event); captures.push(fact)
      record('store.capture', { action: label(action), capture: label(fact), event })
      watchFact(fact, 'store'); return fact
    }
    action.stop = function () {
      record('action.stop.before', { action: label(action), aborted: action.signal.aborted })
      const result = stop.call(action)
      record('action.stop.after', { action: label(action), aborted: action.signal.aborted }); return result
    }
    return action
  }
  function watchFact(fact: CapturedActionFact<ProducerFactOutcome>, kind: string) {
    const admit = fact.admit, reconcile = fact.reconcile
    fact.admit = function () {
      record(kind + '.admit', { capture: label(fact) })
      return observe(admit.call(fact), outcome => {
        record(kind + '.admitted', { capture: label(fact), outcome })
        if (kind === 'store') storeOutcomes.push(outcome)
      }, error => record(kind + '.admit.error', { error: errorInfo(error) }))
    }
    fact.reconcile = function () {
      record(kind + '.reconcile', { capture: label(fact) })
      return observe(reconcile.call(fact), outcome => {
        record(kind + '.reconciled', { capture: label(fact), outcome }); if (kind === 'store') storeOutcomes.push(outcome)
      }, error => record(kind + '.reconcile.error', { error: errorInfo(error) }))
    }
  }
  const service = createContextOutputService({ root: join(root, 'r'), workspaceId: 'bridge', config: { enabled: true } })
  const begin = service.beginResult
  service.beginResult = function (scope, codec) {
    const original = begin.call(service, scope, codec)
    // Register this synchronous mutation before the caller's continuation,
    // while returning the exact original begin promise and resolved sink.
    return observe(original, sink => {
      record('sink.begin', { scope: label(scope), operationId: scope.operationId, sink: label(sink), codec })
      firstOperation ??= scope.operationId
      const originalWrite = sink.write, originalFinish = sink.finish
      sink.write = function (...args) {
        writes++; record('sink.write', { operationId: scope.operationId, bytes: Buffer.from(args[0]).toString('base64') })
        return originalWrite.apply(sink, args)
      }
      sink.finish = async function (...args) {
        finishes++
        const actual = await originalFinish.apply(sink, args)
        record('sink.physical.finish', { operationId: scope.operationId, actual })
        if (scope.operationId === firstOperation) {
          actualReceipt ??= actual
          if (actual.kind === 'committed') actualRef = actual.ref
          if (!visibility) {
            record('fault.hide-known-physical-finish', { operationId: scope.operationId, physical: actual })
            return { kind: 'recovery-required', operationId: scope.operationId }
          }
        }
        return actual
      }
    }, error => record('sink.begin.error', { error: errorInfo(error) }))
  }
  tools.register({ name: 'fixture_gate', description: 'fixture owned existing gate', inputSchema: {}, isReadOnly: true, execute: async () => {
    gateBodies++; record('gate.enter'); gateEntered.resolve(); await releaseGate.promise; record('gate.exit'); return null
  } })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'only' }, retainText: createCodeTextRetention({ service, sessionId: id }) })
  // Observe genuine registry-created sinks in place. No ready/progress/error is
  // ever issued by the fixture; only the production observer invokes them.
  ctx.onCascade('tools/execute', (input, next) => {
    const exec = (input as { name: string; exec: import('@i-harness/core-tools').ToolExec }).exec
    if ((input as { name: string }).name === 'code_exec') {
      codeBodies++; record('code.body')
      exec.abortSignal!.addEventListener('abort', () => {
        originalAborts++; record('prepared.signal.aborted', { exec: label(exec), reason: errorInfo(exec.abortSignal!.reason) })
      }, { once: true })
      const register = exec.retainOutcome!
      Object.defineProperty(exec, 'retainOutcome', { configurable: true, value: function () {
        const sink = register.call(exec)
        for (const name of ['observed', 'progress', 'unavailable', 'ready', 'beforeRead'] as const) {
          const original = sink[name] as (...args: unknown[]) => void
          Object.assign(sink, { [name]: function (...args: unknown[]) {
            record('observer.' + name, { sink: label(sink), ...(name === 'ready' ? { output: args[0] } : {}) })
            if (name === 'ready') readyOutput = args[0]
            return original.apply(sink, args)
          } })
        }
        return sink
      } })
    }
    return next()
  })
  let originalPrepared: PreparedCall | undefined, originalError: unknown
  const dispatch = tools.dispatch
  tools.dispatch = function (prepared) {
    if (prepared.call.name === 'code_exec') { originalPrepared = prepared; record('registry.prepared', { prepared: label(prepared), exec: label(prepared.exec) }) }
    return observe(dispatch.call(tools, prepared), () => record('registry.dispatch.returned', { prepared: label(prepared) }), error => {
      if (prepared === originalPrepared) originalError = error
      record('registry.dispatch.error', { prepared: label(prepared), error: errorInfo(error) })
    })
  }
  const first = 'first original π\n', second = 'later original 二\n'
  const code = arm === 'H1' ? 'const gate=tools.fixture_gate({}); text(' + JSON.stringify(first) + '); await gate; text(' + JSON.stringify(second) + ');' : 'text(' + JSON.stringify(first) + '); store("original-key",7);'
  const action = document.beginAction()
  const call = { callId: 'original-' + arm, name: 'code_exec', args: { code, yield_time_ms: 5000 } }
  const cleanup: { name: string; outcome: string; error?: unknown }[] = []
  let body: Buffer | undefined, batchError: unknown, frozen: unknown
  async function clean(name: string, work: () => void | Promise<unknown>) {
    try { await work(); cleanup.push({ name, outcome: 'fulfilled' }) }
    catch (error) { cleanup.push({ name, outcome: 'rejected', error: errorInfo(error) }) }
  }
  try {
    await action.facts.tools.call({ type: 'tool/call', ...call })
    record('original.call', { action: label(action), call, root, sessionId: id, document: label(document) })
    batchError = await executeToolCalls(ctx, document.view, tools, [call], {
      facts: action.facts.tools, maxParallel: 1, sessionId: id,
      registerFactSource(drain) { batchSource = action.registerSettlementSource(drain); record('batch.source', { source: label(batchSource) }); return batchSource },
    }).catch(error => error)
    record('batch.returned', { error: errorInfo(batchError), originalError: errorInfo(originalError) })
    expect(batchError).toBeInstanceOf(Error)
    expect(batchHolds).toBe(1); expect(batchClosed).toBe(false)
    expect(actualReceipt?.kind).toBe('committed'); expect(actualRef).toBeDefined()
    expect(writes).toBe(1); expect(codeBodies).toBe(1)
    const retained = retainedToolOutcome(originalError, originalPrepared!)
    expect(retained).toBeDefined()
    expect(originalAborts).toBe(1); expect(originalPrepared!.exec.abortSignal!.aborted).toBe(true)
    if (arm === 'H1') { await gateEntered.promise; expect(gateBodies).toBe(1) }
    visibility = true; record('fault.visibility.released', { operationId: firstOperation })
    // Original execution/drain returned. Only this original batch drain owns
    // the ready value: it invokes retained.take, finalizes and installs result.
    // Successful source release here follows real installation; no fixture
    // hold clearing or independent consumer can force that outcome.
    await batchSource!.close(); record('batch.close.after-visibility')
    expect(outputClosed).toBe(true)
    expect(batchClosed).toBe(true)
    expect(readyOutput).toMatchObject({ status: 'terminated' })
    expect(document.view.events).toContainEqual(expect.objectContaining({ type: 'tool/result', callId: call.callId, output: expect.objectContaining({ status: 'terminated' }) }))
    if (arm === 'H1') {
      record('gate.release.after-source-retirement'); releaseGate.resolve()
      expect(document.view.events.filter(event => event.type === 'code/output')).toHaveLength(1)
      expect(captures).toHaveLength(0)
      expect(registrationRefusals).toBe(0)
      record('hypothesis.absent', { reason: 'original checkpoint abort terminated guest before later output', registrationRefusals })
    } else {
      record('original.Stop.begin'); await mount.cancel('original Stop'); record('original.Stop.joined')
      expect(captures).toHaveLength(0); expect(storeOutcomes).toEqual([])
      expect(document.view.events.some(event => event.type === 'code/store')).toBe(false)
      expect(document.view.events).toContainEqual(expect.objectContaining({ type: 'code/cell', state: 'terminated' }))
      record('hypothesis.absent', { reason: 'original checkpoint abort prevented optional store capture; later original Stop joined' })
    }
    const page = await service.readResult({ sessionId: id }, { ref: actualRef! })
    expect(page.eof).toBe(true)
    body = page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64')
    expect(JSON.parse(body.toString('utf8'))).toBe(first)
    expect(createHash('sha256').update(body).digest('hex')).toBe(actualRef!.contentDigest)
    frozen = { batchHolds, batchClosed, outputClosed, originalAborts, registrationRefusals, codeBodies, gateBodies, writes, finishes, actualReceipt, actualRef, storeCaptures: captures.length, storeOutcomes, readyOutput, events: [...document.view.events] }
    record('observations.frozen', frozen as object)
  } finally {
    record('cleanup.begin')
    releaseGate.resolve()
    await clean('mount.cancel.join-original-workers', () => mount.cancel('bridge cleanup'))
    await clean('mount.dispose', () => mount.dispose())
    await clean('original.batch.close', () => batchSource?.close())
    action.finish()
    await clean('managed.document.close', () => document.close())
    await clean('coordinator.close', () => coordinator.close())
    await clean('result.service.close', () => service.close())
    await clean('context.unmount', () => ctx.scope.unmount())
    record('cleanup.done', { cleanup })
    await mkdir(evidence, { recursive: true })
    const journal = await readFile(join(root, 's', id + '.jsonl'))
    await writeFile(join(evidence, arm + '-journal.jsonl'), journal)
    if (body) await writeFile(join(evidence, arm + '-artifact.json'), body)
    await writeFile(join(evidence, arm + '.json'), JSON.stringify({ arm, root, sessionId: id, code, trace, overflow, appends, frozen, cleanup, originalError: errorInfo(originalError), batchError: errorInfo(batchError), privateSeam: 'pendingOutputReceipts, 353 flags and original installed callback are not public and are not claimed' }, null, 2))
  }
  expect(overflow).toBe(0)
  expect(observerFailures).toBe(0)
}

it('H1: actual checkpoint abort terminates the original gated guest before its later output', async () => { await bridge('H1') })
it('H2: actual checkpoint abort prevents original store capture and original Stop joins', async () => { await bridge('H2') })
