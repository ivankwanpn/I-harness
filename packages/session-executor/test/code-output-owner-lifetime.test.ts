import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, retainedToolOutcome, type PreparedCall } from '@i-harness/core-tools'
import { decodeFactBatch, type ManagedArtifactRef, type ProducerFactOutcome, type CapturedActionFact, type SettlementFacts } from '@i-harness/core-session'
import { executeToolCalls } from '@i-harness/core-agent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '@i-harness/context-output'
import { registerCodeMode } from '@i-harness/code-mode'
import { createCodeTextRetention } from '../src/lifecycle/code-text-retention.ts'

// Historical causal RED: ROOT frozen-diagnostic/code-output-settlement-timing.test.ts,
// SHA256 9D3E4329368F909855A30F0F59CA48CCF541AFF2BADD74579ABA84A762B2B15B.
// That diagnostic ran acf00fcf and failed real cleanup; this NEW test does not.
// Preserve its original body, visibility fault and two delivery gates. The
// repaired normal subscription checkpoints the unsealed original cell source;
// the historical source-close milestone is therefore an actual checkpoint.
it('retains the original mounted cell source for later output under the original delayed registry rejection', async () => {
  const evidence = process.env.IH_OWNER_LIFETIME_EVIDENCE_ROOT
  if (!evidence || !process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT) throw new Error('Fresh task evidence roots are required')
  const root = join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT, 'T')
  await mkdir(root, { recursive: true })
  const trace: unknown[] = [], ids = new WeakMap<object, number>()
  let overflow = 0, nextId = 0, observerFailures = 0, traceBytes = 0
  const label = (value: object) => { let id = ids.get(value); if (!id) { id = ++nextId; ids.set(value, id) }; return id }
  const record = (kind: string, data: object = {}) => {
    const row = { seq: trace.length, kind, ...data }, bytes = Buffer.byteLength(JSON.stringify(row))
    if (trace.length < 1000 && traceBytes + bytes <= 512_000) { trace.push(row); traceBytes += bytes } else overflow++
  }
  const errorInfo = (error: unknown, depth = 0): unknown => error && typeof error === 'object' ? {
    id: label(error), name: (error as Error).name, message: (error as Error).message,
    code: (error as { code?: string }).code,
    ...(depth < 4 && 'cause' in error ? { cause: errorInfo(error.cause, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.map(value => errorInfo(value, depth + 1)) } : {}),
  } : { type: typeof error, value: String(error) }
  const observe = <T>(promise: Promise<T>, success: (value: T) => void, failure: (error: unknown) => void) => {
    void promise.then(success, failure).catch(error => {
      observerFailures++; record('fixture.observer.failed', { error: errorInfo(error) })
    }); return promise
  }
  // Bounded milestone waits leave time for genuine cleanup inside the existing
  // Vitest 5000ms deadline. A missing seam is a failed diagnostic, never retried.
  async function milestone<T>(name: string, promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Missing actual ordering: ' + name)), 1000) })]) }
    finally { clearTimeout(timer) }
  }
  const gateEntered = Promise.withResolvers<void>(), releaseGate = Promise.withResolvers<void>()
  const registryRejected = Promise.withResolvers<void>(), releaseRejection = Promise.withResolvers<void>()
  const nestedCommitted = Promise.withResolvers<void>(), releaseNestedReturn = Promise.withResolvers<void>()
  const firstOutputCheckpoint = Promise.withResolvers<void>(), workerCompleted = Promise.withResolvers<void>()
  const laterOutputBoundary = Promise.withResolvers<void>()
  const storeAttempted = Promise.withResolvers<void>(), preparedAborted = Promise.withResolvers<void>()
  const backend = createJsonlBackend(join(root, 's')), append = backend.appendOwnedBatch!
  const appends: { key: Parameters<typeof append>[3]['key']; bytes: string; events: ReturnType<typeof decodeFactBatch>['events'] }[] = []
  const nativeOutcomes: Awaited<ReturnType<typeof append>>[] = []
  backend.appendOwnedBatch = (...args) => {
    const captured = { key: args[3].key, bytes: Buffer.from(args[3].bytes).toString('base64'), events: decodeFactBatch(args[3].bytes).events }
    appends.push(captured); record('journal.append', { key: captured.key, bytes: captured.bytes, types: captured.events.map(event => event.type) })
    return observe(append.apply(backend, args), outcome => { nativeOutcomes.push(outcome); record('journal.receipt', { outcome }) }, error => record('journal.error', { error: errorInfo(error) }))
  }
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const captures: object[] = [], storeOutcomes: ProducerFactOutcome[] = []
  let batchSource: SettlementFacts<ProducerFactOutcome> | undefined, outputSource: SettlementFacts<ProducerFactOutcome> | undefined
  let batchHolds = 0, batchClosed = false, outputClosed = false, codeBodies = 0, gateBodies = 0
  let originalAborts = 0, registrationRefusals = 0, nestedReturnGates = 0, readyCalls = 0, checkpoints = 0
  let deliveredError: unknown, takeCalls = 0, finalizeCalls = 0
  let cellRegistrations = 0
  const takeStacks: string[] = []
  const outputCaptures: { source: object; fact: object; event: unknown }[] = []
  const storeAttempts: { capture: number; method: string; outcome: ProducerFactOutcome }[] = []
  const physical = new Map<string, { ref: ManagedArtifactRef; sink: number; scope: number }>()
  let visibility = false, firstOperation: string | undefined, writes = 0, finishes = 0
  let actualReceipt: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof createContextOutputService>['beginResult']>>['finish']>> | undefined
  let actualRef: ManagedArtifactRef | undefined, readyOutput: unknown
  const beginAction = document.beginAction
  document.beginAction = function (...args) {
    const action = beginAction.apply(document, args), register = action.registerSettlementSource
    record('action.begin', { action: label(action), owned: document.ownsAction(action), signal: label(action.signal) })
    action.registerSettlementSource = function (...registerArgs) {
      record('source.register.attempt', { action: label(action), batchHeld: batchHolds > 0 && !batchClosed, firstOutputClosed: outputClosed })
      let source: ReturnType<typeof register>
      try { source = register.apply(action, registerArgs) }
      catch (error) {
        registrationRefusals++; record('source.register.refused', { action: label(action), error: errorInfo(error) })
        if (outputClosed) laterOutputBoundary.resolve()
        throw error
      }
      const descriptor = registerArgs[2]
      if (descriptor) { outputSource = source; cellRegistrations++ }
      record('source.registered', { action: label(action), source: label(source), descriptor: descriptor && label(descriptor), drain: label(registerArgs[0]), reconcile: registerArgs[1] && label(registerArgs[1]) })
      const hold = source.holdRecovery, close = source.close, capture = source.code.capture, checkpoint = source.checkpoint
      source.holdRecovery = function () {
        const result = hold.call(source)
        if (source === batchSource) batchHolds++
        record('source.hold', { source: label(source), batch: source === batchSource }); return result
      }
      source.checkpoint = function () {
        record('source.checkpoint.begin', { source: label(source), descriptor: descriptor && label(descriptor), cut: descriptor?.readCut() })
        return observe(checkpoint.call(source), outcome => {
          checkpoints++; record('source.checkpoint.done', { source: label(source), outcome, cut: descriptor?.readCut() })
          if (source === outputSource) firstOutputCheckpoint.resolve()
        }, error => record('source.checkpoint.failed', { source: label(source), error: errorInfo(error) }))
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
        if (event.type === 'code/output') {
          outputCaptures.push({ source, fact, event })
          if (outputCaptures.length === 2) laterOutputBoundary.resolve()
        }
        watchFact(fact, event.type === 'code/result' ? 'nested-result' : 'required')
        return fact
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
      const original = observe(admit.call(fact), outcome => {
        record(kind + '.admitted', { capture: label(fact), outcome })
        if (kind === 'store') { storeOutcomes.push(outcome); storeAttempts.push({ capture: label(fact), method: 'admit', outcome }); storeAttempted.resolve() }
      }, error => record(kind + '.admit.error', { error: errorInfo(error) }))
      if (kind !== 'nested-result') return original
      // records.ts calls this original capture.admit, not source.code.record.
      // The document commits and publishes its event before this return gate.
      return original.then(async outcome => {
        nestedReturnGates++; record('gate.nested-result.native-return-held', { capture: label(fact), outcome })
        nestedCommitted.resolve(); await releaseNestedReturn.promise
        record('gate.nested-result.return-delivered', { capture: label(fact), outcome }); return outcome
      })
    }
    fact.reconcile = function () {
      record(kind + '.reconcile', { capture: label(fact) })
      return observe(reconcile.call(fact), outcome => {
        record(kind + '.reconciled', { capture: label(fact), outcome }); if (kind === 'store') { storeOutcomes.push(outcome); storeAttempts.push({ capture: label(fact), method: 'reconcile', outcome }); storeAttempted.resolve() }
      }, error => record(kind + '.reconcile.error', { error: errorInfo(error) }))
    }
  }
  const service = createContextOutputService({ root: join(root, 'r'), workspaceId: 'timing', config: { enabled: true } })
  const begin = service.beginResult
  service.beginResult = function (scope, codec) {
    return observe(begin.call(service, scope, codec), sink => {
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
        if (actual.kind === 'committed') physical.set(scope.operationId, { ref: actual.ref, scope: label(scope), sink: label(sink) })
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
  tools.register({ name: 'fixture_gate', description: 'original already-running timing gate', inputSchema: {}, isReadOnly: true, execute: async () => {
    gateBodies++; record('gate.enter'); gateEntered.resolve(); await releaseGate.promise; record('gate.exit'); return null
  } })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'only' }, retainText: createCodeTextRetention({ service, sessionId: id }) })
  ctx.onCascade('tools/execute', (input, next) => {
    const exec = (input as { name: string; exec: import('@i-harness/core-tools').ToolExec }).exec
    if ((input as { name: string }).name === 'code_exec') {
      codeBodies++; record('code.body', { exec: label(exec) })
      exec.abortSignal!.addEventListener('abort', () => {
        originalAborts++; record('prepared.signal.aborted', { exec: label(exec), reason: errorInfo(exec.abortSignal!.reason) })
        preparedAborted.resolve()
      }, { once: true })
      const retain = exec.retainOutcome!
      Object.defineProperty(exec, 'retainOutcome', { configurable: true, value: function () {
        const sink = retain.call(exec)
        for (const name of ['observed', 'progress', 'unavailable', 'ready', 'beforeRead'] as const) {
          const original = sink[name] as (...args: unknown[]) => void
          Object.assign(sink, { [name]: function (...args: unknown[]) {
            record('observer.' + name, { sink: label(sink), ...(name === 'ready' ? { output: args[0] } : {}) })
            if (name === 'ready') { readyOutput = args[0]; readyCalls++ }
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
    if (prepared.call.name !== 'code_exec') {
      record('registry.nested.prepared', { prepared: label(prepared), exec: label(prepared.exec), call: prepared.call })
      return observe(dispatch.call(tools, prepared), output => record('registry.nested.returned', { prepared: label(prepared), output }), error => record('registry.nested.error', { prepared: label(prepared), error: errorInfo(error) }))
    }
    originalPrepared = prepared
    record('registry.prepared', { prepared: label(prepared), exec: label(prepared.exec), source: label(batchSource!) })
    return dispatch.call(tools, prepared).then(value => { record('registry.dispatch.returned'); return value }, async error => {
      originalError = error
      const retained = retainedToolOutcome(error, prepared)
      if (retained) {
        const take = retained.take
        retained.take = function () {
          const stack = new Error('actual original consumer').stack ?? ''
          takeStacks.push(stack)
          takeCalls++; record('original.retained.take', { retained: label(retained), prepared: label(prepared), stack })
          return observe(take.call(retained), outcome => record('original.retained.taken', { retained: label(retained), outcome }), reason => record('original.retained.take.failed', { error: errorInfo(reason) }))
        }
      }
      record('gate.registry.original-rejection-held', { prepared: label(prepared), error: errorInfo(error), retained: retained && label(retained) })
      registryRejected.resolve(); await releaseRejection.promise
      deliveredError = error; record('gate.registry.original-rejection-delivered', { error: errorInfo(error) }); throw error
    })
  }
  const finalize = tools.finalize
  tools.finalize = function (...args) {
    if (args[0] === originalPrepared) { finalizeCalls++; record('original.finalize', { prepared: label(args[0]), output: args[1] }) }
    return finalize.apply(tools, args)
  }
  const terminate = Worker.prototype.terminate, terminations: unknown[] = []
  const terminationJoins: Promise<number>[] = []
  Worker.prototype.terminate = function (...args) {
    const stack = new Error('passive actual worker termination callsite').stack
    const actual = { worker: label(this), threadId: this.threadId, stack, aborted: originalPrepared?.exec.abortSignal?.aborted, batchHeld: batchHolds > 0 && !batchClosed }
    terminations.push(actual); record('worker.terminate.called', actual)
    const original = terminate.apply(this, args); terminationJoins.push(original)
    observe(original, value => record('worker.terminate.joined', { worker: actual.worker, threadId: actual.threadId, value }), error => record('worker.terminate.failed', { error: errorInfo(error) }))
    if (stack?.includes('complete') && stack.includes('retirement') && !actual.aborted) workerCompleted.resolve()
    return original
  }
  const first = 'first original π\n', second = 'later original 二\n'
  const code = 'const gate=tools.fixture_gate({}); text(' + JSON.stringify(first) + '); await gate; text(' + JSON.stringify(second) + '); store("original-key",7);'
  const action = document.beginAction()
  const call = { callId: 'original-timing', name: 'code_exec', args: { code, yield_time_ms: 5000 } }
  const cleanup: { name: string; outcome: string; error?: unknown }[] = [], cleanupErrors: unknown[] = []
  let batchPromise: Promise<void> | undefined, batchFailed = false, batchError: unknown, frozen: unknown, body: Buffer | undefined
  let primaryFailed = false, primaryError: unknown, evidenceFailed = false, evidenceError: unknown
  const primaryErrors: unknown[] = [], artifactBodies: Buffer[] = []
  async function clean(name: string, work: () => void | Promise<unknown>) {
    try { await work(); cleanup.push({ name, outcome: 'fulfilled' }) }
    catch (error) { cleanupErrors.push(error); cleanup.push({ name, outcome: 'rejected', error: errorInfo(error) }) }
  }
  try {
    await action.facts.tools.call({ type: 'tool/call', ...call })
    record('original.call', { action: label(action), call, root, sessionId: id, document: label(document), first, second })
    batchPromise = executeToolCalls(ctx, document.view, tools, [call], {
      facts: action.facts.tools, maxParallel: 1, sessionId: id,
      registerFactSource(drain) { batchSource = action.registerSettlementSource(drain); record('batch.source', { source: label(batchSource) }); return batchSource },
    }).catch(error => { batchFailed = true; batchError = error; record('batch.rejected', { error: errorInfo(error) }) })
    await milestone('original registry rejection', registryRejected.promise)
    await milestone('already-running original tool', gateEntered.promise)
    expect(batchHolds).toBe(1); expect(batchClosed).toBe(false)
    expect(actualReceipt?.kind).toBe('committed'); expect(actualRef).toBeDefined()
    expect(writes).toBe(1); expect(codeBodies).toBe(1); expect(gateBodies).toBe(1)
    expect(retainedToolOutcome(originalError, originalPrepared!)).toBeDefined()
    expect(originalAborts).toBe(0)
    visibility = true; record('fault.visibility.released', { operationId: firstOperation })
    record('gate.original-tool.released'); releaseGate.resolve()
    await milestone('native original code/result commit', nestedCommitted.promise)
    await milestone('original cell checkpoint from subscribed refresh', firstOutputCheckpoint.promise)
    expect(document.view.events.filter(event => event.type === 'code/output')).toHaveLength(1)
    expect(document.view.events.filter(event => event.type === 'code/result')).toHaveLength(1)
    expect(nestedReturnGates).toBe(1); expect(originalAborts).toBe(0); expect(batchClosed).toBe(false)
    expect(outputClosed).toBe(false)
    expect(outputCaptures).toHaveLength(1); expect(outputCaptures[0]!.source).toBe(outputSource)
    record('gate.nested-result.return-released', { originalSourceOpen: !outputClosed, batchHeld: true }); releaseNestedReturn.resolve()
    await milestone('genuine retirement.complete before checkpoint abort', workerCompleted.promise)
    await milestone('later original output capture boundary', laterOutputBoundary.promise)
    await milestone('original Store first attempt under real batch hold', storeAttempted.promise)
    expect(originalAborts).toBe(0); expect(batchClosed).toBe(false)
    expect(terminations).toHaveLength(1)
    expect(outputCaptures).toHaveLength(2)
    expect(cellRegistrations).toBe(1)
    expect(outputCaptures[1]!.source).toBe(outputSource)
    expect(registrationRefusals).toBe(0); expect(outputClosed).toBe(false)
    expect(captures).toHaveLength(1)
    expect(storeAttempts[0]).toMatchObject({ capture: label(captures[0]!), method: 'admit', outcome: { kind: 'not-issued' } })
    expect(document.view.events.filter(event => event.type === 'code/output')).toHaveLength(2)
    expect(document.view.events.some(event => event.type === 'code/store')).toBe(false)
    record('pre-checkpoint.observed', { registrationRefusals, events: [...document.view.events], terminations, storeCaptures: captures.length })
    record('gate.registry.rejection-released'); releaseRejection.resolve()
    await milestone('actual original checkpoint abort', preparedAborted.promise)
    record('original.Stop.begin'); await mount.cancel('original Stop'); record('original.Stop.joined')
    await milestone('original batch checkpoint/drain return', batchPromise)
    expect(originalAborts).toBe(1); expect(batchFailed).toBe(true)
    expect(deliveredError).toBe(originalError); expect(batchError).toBe(originalError)
    expect(batchClosed).toBe(true); expect(outputClosed).toBe(true)
    expect(readyCalls).toBe(1); expect(readyOutput).toMatchObject({ status: 'terminated' })
    expect(finalizeCalls).toBe(1); expect(takeCalls).toBe(1)
    expect(takeStacks).toHaveLength(1)
    expect(takeStacks[0]).toContain('commitSlot')
    expect(takeStacks[0]).toMatch(/tool-batch[/\\]record\.ts/)
    expect(codeBodies).toBe(1); expect(gateBodies).toBe(1)
    expect(storeAttempts).toEqual([
      { capture: label(captures[0]!), method: 'admit', outcome: { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' } },
      { capture: label(captures[0]!), method: 'reconcile', outcome: { kind: 'not-issued', code: 'FACT_CANCELLED' } },
    ])
    // Both dispositions are explicitly not-issued and therefore carry no
    // native key/receipt. A zero capture count would not prove cancellation.
    expect(storeOutcomes.every(outcome => !('key' in outcome) && !('receipt' in outcome))).toBe(true)
    expect(document.view.events.filter(event => event.type === 'code/store')).toHaveLength(0)
    expect(document.view.events.filter(event => event.type === 'code/cell' && event.state === 'terminated')).toHaveLength(1)
    expect(document.view.events.filter(event => event.type === 'tool/result' && event.callId === call.callId)).toEqual([
      expect.objectContaining({ output: expect.objectContaining({ status: 'terminated' }) }),
    ])
    const outputs = document.view.events.filter(event => event.type === 'code/output')
    // The original observer can additionally retain its normal two-item index.
    // Each original item still has its own independently verified literal bytes.
    for (const [index, literal] of [first, second].entries()) {
      const event = outputs[index]!
      expect(event.envelope?.retention.kind).toBe('artifact')
      if (event.envelope?.retention.kind !== 'artifact') throw new Error('Original literal lacks its artifact')
      const ref = event.envelope.retention.ref
      expect([...physical.values()].some(entry => entry.ref.id === ref.id && entry.ref.revision === ref.revision && entry.ref.contentDigest === ref.contentDigest)).toBe(true)
      const page = await service.readResult({ sessionId: id }, { ref })
      expect(page.eof).toBe(true)
      const bytes = page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64')
      const oracle = Buffer.from(JSON.stringify(literal), 'utf8')
      expect(bytes.equals(oracle)).toBe(true)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.contentDigest)
      artifactBodies.push(bytes)
      record('literal.artifact.verified', { index, literal, ref, expectedBytes: oracle.toString('base64'), bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    body = artifactBodies[0]
    expect(nativeOutcomes).toHaveLength(appends.length)
    for (const entry of appends) {
      expect(nativeOutcomes.filter(outcome => outcome.kind === 'committed' && JSON.stringify(outcome.receipt.key) === JSON.stringify(entry.key))).toHaveLength(1)
      expect(decodeFactBatch(Buffer.from(entry.bytes, 'base64')).events).toEqual(entry.events)
    }
    const nativeOutputs = appends.filter(entry => entry.events.some(event => event.type === 'code/output'))
    expect(nativeOutputs).toHaveLength(2)
    expect(nativeOutputs.map(entry => entry.events[0])).toEqual(outputs)
    frozen = { batchHolds, batchClosed, outputClosed, originalAborts, registrationRefusals, codeBodies, gateBodies, nestedReturnGates, writes, finishes, checkpoints, readyCalls, takeCalls, finalizeCalls, actualReceipt, actualRef, storeCaptures: captures.length, storeAttempts, storeOutcomes, readyOutput, events: [...document.view.events], terminations }
    record('observations.frozen', frozen as object)
  } catch (error) { primaryFailed = true; primaryError = error; primaryErrors.push(error) }
  finally {
    record('cleanup.begin')
    // Release only the declared transport/body gates. Never clear a hold or
    // close an output source externally; the original batch owns retained.take.
    releaseGate.resolve(); releaseNestedReturn.resolve(); releaseRejection.resolve()
    await clean('mount.cancel.join-original-workers', () => mount.cancel('timing cleanup'))
    await clean('original.batch.join', () => batchPromise)
    await clean('mount.dispose', () => mount.dispose())
    await clean('original.batch.close', () => batchSource?.close())
    await clean('original.action.finish', () => action.finish())
    await clean('managed.document.close', () => document.close())
    await clean('coordinator.close', () => coordinator.close())
    await clean('original.artifact.read-and-verify', async () => {
      if (!actualRef || body) return
      const page = await service.readResult({ sessionId: id }, { ref: actualRef })
      expect(page.eof).toBe(true)
      body = page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64')
      expect(JSON.parse(body.toString('utf8'))).toBe(first)
      expect(createHash('sha256').update(body).digest('hex')).toBe(actualRef.contentDigest)
      record('artifact.read-and-verified', { actualRef, bytes: body.toString('base64'), sha256: createHash('sha256').update(body).digest('hex') })
    })
    await clean('result.service.close', () => service.close())
    await clean('context.unmount', () => ctx.scope.unmount())
    await clean('actual.worker.termination-joins', () => Promise.all(terminationJoins))
    Worker.prototype.terminate = terminate
    record('cleanup.done', { cleanup })
    try {
      await mkdir(evidence, { recursive: true })
      const journal = await readFile(join(root, 's', id + '.jsonl'))
      await writeFile(join(evidence, 'T-journal.jsonl'), journal)
      if (body) await writeFile(join(evidence, 'T-artifact.json'), body)
      for (const [index, bytes] of artifactBodies.entries()) await writeFile(join(evidence, `T-artifact-${index}.json`), bytes)
      await writeFile(join(evidence, 'T.json'), JSON.stringify({ root, sessionId: id, first, second, code, trace, traceBytes, overflow, observerFailures, appends, frozen, final: { batchHolds, batchClosed, outputClosed, originalAborts, registrationRefusals, codeBodies, gateBodies, nestedReturnGates, writes, finishes, readyCalls, takeCalls, finalizeCalls, checkpoints, storeCaptures: captures.length, storeAttempts, storeOutcomes, readyOutput, events: [...document.view.events] }, cleanup, cleanupFailed: cleanupErrors.length > 0, cleanupErrors: cleanupErrors.map(error => errorInfo(error)), primaryFailed, primaryErrors: primaryErrors.map(error => errorInfo(error)), originalError: errorInfo(originalError), deliveredError: errorInfo(deliveredError), batchFailed, batchError: errorInfo(batchError), actualReceipt, actualRef, physical: [...physical], terminations, privateSeam: 'private output/callback counters are not claimed; one cancellation effect follows the same captured never-issued handle and truthful terminated terminal' }, null, 2))
    } catch (error) { evidenceFailed = true; evidenceError = error }
  }
  if (primaryFailed) throw primaryError
  if (evidenceFailed) throw evidenceError
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Mounted owner lifetime cleanup failed')
  expect(overflow).toBe(0); expect(observerFailures).toBe(0)
})
