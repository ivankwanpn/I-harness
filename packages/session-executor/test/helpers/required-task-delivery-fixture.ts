import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { inspect } from 'node:util'
import { decodeFactBatch, subscribe, readDeliveries } from '@i-harness/core-session'
import { compileSemanticSeed } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '../../../session-persistence-jsonl/src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../../subagent/src/task/storage-contract.ts'
import { createContextOutputService } from '@i-harness/context-output'
import type { LLMRequest } from '@i-harness/llm-seam'
import { createSessionService, createDurableSessionLoader } from '../../src/index.ts'
import { controlledModel } from '../controlled-model.ts'
import { createTelemetry, type TelemetryEvent } from '@i-harness/telemetry'
import { receivedInputsFor } from '../../src/lifecycle/received-inputs.ts'
import { afterEach, expect, vi } from 'vitest'
import { generationError } from '@i-harness/llm-seam'
import { writeLegacyDocument, createOwnedDocumentWrite } from '../../../session-persistence-jsonl/src/backend/document-write.ts'

// Physical fault controls stay behind the original constructor's descriptors.
vi.mock('../../../session-persistence-jsonl/src/backend/fact-journal.ts', async original => {
  const actual = await original<typeof import('../../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
  return { ...actual, createFactJournalBackend(...args: Parameters<typeof actual.createFactJournalBackend>) {
    const journal = actual.createFactJournalBackend(...args)
    return { ...journal, appendOwnedBatch: vi.fn(journal.appendOwnedBatch), reconcileOwnedBatch: vi.fn(journal.reconcileOwnedBatch) }
  } }
})
vi.mock('../../../session-persistence-jsonl/src/backend/document-write.ts', async original => {
  const actual = await original<typeof import('../../../session-persistence-jsonl/src/backend/document-write.ts')>()
  return { ...actual, writeLegacyDocument: vi.fn(actual.writeLegacyDocument), createOwnedDocumentWrite: vi.fn(actual.createOwnedDocumentWrite) }
})

const warningRestorers = new Set<() => void>()
afterEach(() => { for (const restore of [...warningRestorers]) restore() })

/** Only provider/physical backend gates are controlled. Task/source, Inbox,
 * receiver and serial lane are the actual service composition. */
export async function createDeliveryFixture(options: { activeForeground?: boolean; failChild?: boolean; rewindFsWrite?: boolean; holdTerminal?: boolean; holdTerminalUnknown?: boolean; holdTaskSaveFailure?: boolean; expectStopDiagnostics?: boolean; expectedWarnings?: readonly string[]; extensionsFor?: Parameters<typeof createSessionService>[0]['extensionsFor']; failDelivery?: boolean; spawnCount?: number; holdReceiptUnknown?: boolean; holdReceiptReconcile?: boolean; holdOpenUnknown?: boolean; holdReceiptBeforeIssue?: boolean; compatibilityOrigin?: 'synthetic' | 'unknown' | 'delegated' | 'b2'; holdParentStep?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ih-d1a-service-'))
  let backend = createJsonlBackend(join(root, 'sessions'))
  let coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  if (options.compatibilityOrigin === 'b2') {
    const now = Date.now()
    const outcome = await coordinator.bootstrapSemanticTarget({ invocation: { version: 1, operationId: 'delivery-b2-fixture', targetSessionId: 'parent', createdAt: new Date(now).toISOString(), requestDigest: 'a'.repeat(64) }, target: { kind: 'new' }, metadata: {},
      lineage: { origin: 'subagent', parentSession: 'delegator', subagentProtocolVersion: 1 }, seed: compileSemanticSeed({ kind: 'none' }),
      initial: { inputId: 'b2-initial', text: 'run an ordinary child', parentSessionId: 'delegator', startedAt: now, expiresAt: now + 3600000 } },
      { assertCurrent() {}, dependencies: { async confirm() { throw new Error('Empty B2 fixture has no dependencies') }, async reconcile() { throw new Error('Empty B2 fixture has no dependencies') } } })
    if (outcome.kind !== 'ready') throw new Error('Actual B2 fixture not ready: ' + JSON.stringify(outcome))
  } else await coordinator.create({ sessionId: 'parent', ...(options.compatibilityOrigin === 'delegated' ? { parentSession: 'delegator', origin: 'subagent' as const, subagentProtocolVersion: 1 as const, seedLength: 0 } : {}) })
  const originalDocument = await coordinator.openManagedDocument('parent')
  // Retain references to actual original spawn settlement sources for explicit
  // owner recovery controls. No source/received method is replaced.
  const spawnSources: { taskId: string; source: import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome> }[] = []
  const beginAction = originalDocument.beginAction.bind(originalDocument)
  originalDocument.beginAction = signal => {
    const action = beginAction(signal), register = action.registerSettlementSource.bind(action), captureStart = action.captureSubagentStart.bind(action)
    const sources: import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>[] = []
    action.registerSettlementSource = (...args) => { const source = register(...args); sources.push(source); return source }
    action.captureSubagentStart = (...args) => {
      const captured = captureStart(...args)
      if (sources.length !== 1) throw new Error('Actual spawn source identity is ambiguous')
      spawnSources.push({ taskId: args[0].taskId, source: sources[0]! })
      return captured
    }
    return action
  }
  const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'd1a-fixture', config: { enabled: false } })
  const parentRequests: LLMRequest[] = []
  const warnings: string[] = [], expectedWarnings = new Set<string>()
  for (const warning of options.expectedWarnings ?? []) expectedWarnings.add(warning)
  if (options.rewindFsWrite) expectedWarnings.add(`[rewind] bound pre-M54 journal ${join(root, 'rewind-store', 'rewind', 'parent')} to workspace ${root} (no meta.json existed)`)
  if (options.holdTerminalUnknown) for (const prefix of ['original delivery settlement', 'delivery reconciliation failed']) expectedWarnings.add(`[i-harness] ${prefix}: AggregateError: Original delivery sources require settlement`)
  if (options.holdReceiptUnknown || options.holdReceiptBeforeIssue || options.expectStopDiagnostics) for (const prefix of ['original delivery settlement', 'delivery reconciliation failed']) expectedWarnings.add(`[i-harness] ${prefix}: FactRecoveryRequiredError: Managed facts require reconciliation`)
  if (options.expectStopDiagnostics) expectedWarnings.add('[i-harness] delivery Stop requires reconciliation: FactRecoveryRequiredError: Managed facts require reconciliation')
  const originalWarn = console.warn.bind(console)
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    const message = args.map(String).join(' '); warnings.push(message)
    if (!expectedWarnings.has(message)) originalWarn(...args)
  })
  let warningRestored = false
  const restoreWarning = () => {
    if (warningRestored) return
    warningRestored = true; warn.mockRestore(); warningRestorers.delete(restoreWarning)
  }
  warningRestorers.add(restoreWarning)
  const telemetryEvents: TelemetryEvent[] = []
  const telemetry = createTelemetry([{ onEvent(event) { telemetryEvents.push(event) } }])
  const childGate = Promise.withResolvers<void>(), delivery = Promise.withResolvers<void>(), terminal = Promise.withResolvers<void>()
  const foregroundGate = Promise.withResolvers<void>(), foregroundStarted = Promise.withResolvers<void>()
  const terminalGate = Promise.withResolvers<void>()
  const terminalCommitted = Promise.withResolvers<void>()
  const consumed = Promise.withResolvers<void>(), receiptUnknown = Promise.withResolvers<void>()
  const receiptPrepared = Promise.withResolvers<void>(), receiptGate = Promise.withResolvers<void>()
  const parentStep = Promise.withResolvers<void>(), parentGate = Promise.withResolvers<void>()
  const openUnknown = Promise.withResolvers<void>()
  const terminalReconcile = Promise.withResolvers<void>()
  const receiptReconcile = Promise.withResolvers<void>(), receiptReconcileGate = Promise.withResolvers<void>()
  const taskSaveFailed = Promise.withResolvers<void>()
  let allowTaskSave = !options.holdTaskSaveFailure
  if (!options.holdReceiptReconcile) receiptReconcileGate.resolve()
  if (!options.holdParentStep) parentGate.resolve()
  if (!options.holdReceiptBeforeIssue) receiptGate.resolve()
  let consumedCount = 0
  const off = subscribe(originalDocument.view, e => {
    if (e.type === 'subagent/end') terminalCommitted.resolve()
    if (e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-') && ++consumedCount === (options.spawnCount ?? 1)) consumed.resolve()
  })
  let launches = 0, heldTerminal = false, closed = false, resultRead = false
  if (!options.holdTerminal) terminalGate.resolve()
  const append = vi.mocked(backend.appendOwnedBatch!).getMockImplementation()!, reconcile = vi.mocked(backend.reconcileOwnedBatch!).getMockImplementation()!
  let heldReceiptKey: import('@i-harness/core-session').BatchKey | undefined, allowReceipt = !options.holdReceiptUnknown
  let heldOpenKey: import('@i-harness/core-session').BatchKey | undefined, allowOpen = !options.holdOpenUnknown
  let heldTerminalKey: import('@i-harness/core-session').BatchKey | undefined, allowTerminal = !options.holdTerminalUnknown
  const terminalKeys: string[] = []
  const backendTrace: unknown[] = []
  const receiptKeys: string[] = []
  const putDocument = vi.mocked(writeLegacyDocument).getMockImplementation()!
  vi.mocked(writeLegacyDocument).mockImplementation(async (path, data) => {
    if (!path.startsWith(join(root, 'sessions'))) return putDocument(path, data)
    const key = basename(path).replace(/\.doc\.jsonl$/, '')
    const snapshot = JSON.parse(JSON.stringify(data))
    backendTrace.push({ phase: 'document-entered', key, at: Date.now(), data: snapshot })
    try {
      if (!allowTaskSave && key === 'task-parent' && (data as { tasks?: { result?: { kind: string } }[] }).tasks?.some(task => task.result?.kind === 'retained')) {
        taskSaveFailed.resolve()
        throw Object.assign(new Error('Controlled original task document save refused'), { code: 'EPERM' })
      }
      await putDocument(path, data)
      backendTrace.push({ phase: 'document-returned', key, at: Date.now() })
    } catch (error) {
      backendTrace.push({ phase: 'document-failed', key, at: Date.now(), error: inspect(error, { depth: 8 }) })
      throw error
    }
  })
  const createWrite = vi.mocked(createOwnedDocumentWrite).getMockImplementation()!
  vi.mocked(createOwnedDocumentWrite).mockImplementation(input => {
    const original = createWrite(input), write = original.handle
    if (!input.path.startsWith(join(root, 'sessions'))) return original
    const key = basename(input.path).replace(/\.doc\.jsonl$/, ''), data = JSON.parse(Buffer.from(input.bytes).toString('utf8'))
    const save = async (retry: boolean) => {
      backendTrace.push({ phase: 'document-entered', key, at: Date.now(), data })
      if (!allowTaskSave && key === 'task-parent' && data.tasks?.some((task: { result?: { kind: string } }) => task.result?.kind === 'retained')) {
        taskSaveFailed.resolve()
        throw Object.assign(new Error('Controlled original task document save refused'), { code: 'EPERM' })
      }
      const outcome = retry ? await write.retry() : await write.issue()
      backendTrace.push({ phase: 'document-returned', key, at: Date.now(), kind: outcome.kind })
      return outcome
    }
    return { handle: { issue: () => save(false), retry: () => save(true), reconcile: write.reconcile.bind(write), outcome: write.outcome.bind(write) }, settle: original.settle.bind(original) }
  })
  vi.mocked(backend.appendOwnedBatch!).mockImplementation(async (...args) => {
    const events = decodeFactBatch(args[3].bytes).events
    backendTrace.push({ phase: 'entered', sessionId: args[0], key: args[3].key.batchId, at: Date.now(), events: events.map(e => ({ type: e.type, ...('op' in e ? { op: e.op } : {}) })) })
    if (events.some(e => e.type === 'agent/delivery-received')) { receiptPrepared.resolve(); await receiptGate.promise }
    if (args[0] === 'parent' && events.some(e => e.type === 'subagent/end')) {
      heldTerminal = true; terminal.resolve(); await terminalGate.promise
    }
    const outcome = await append(...args)
    backendTrace.push({ phase: 'returned', sessionId: args[0], key: args[3].key.batchId, at: Date.now(), kind: outcome.kind })
    if (options.holdTerminalUnknown && args[0] === 'parent' && events.some(e => e.type === 'subagent/end')) {
      heldTerminalKey = args[3].key; terminalKeys.push(heldTerminalKey.batchId)
      return { kind: 'unknown', key: heldTerminalKey }
    }
    if (options.holdOpenUnknown && events.some(e => e.type === 'agent/delivery-generation' && e.op === 'open')) {
      heldOpenKey = args[3].key; openUnknown.resolve()
      return { kind: 'unknown', key: heldOpenKey }
    }
    if (options.holdReceiptUnknown && events.some(e => e.type === 'agent/delivery-received')) {
      heldReceiptKey = args[3].key; receiptKeys.push(heldReceiptKey.batchId); receiptUnknown.resolve()
      return { kind: 'unknown', key: heldReceiptKey }
    }
    return outcome
  })
  vi.mocked(backend.reconcileOwnedBatch!).mockImplementation(async (...args) => {
    if (args[3].key.batchId === heldTerminalKey?.batchId) {
      terminalKeys.push(args[3].key.batchId)
      if (!allowTerminal) { terminalReconcile.resolve(); return { kind: 'unknown', key: heldTerminalKey } }
    }
    if (args[3].key.batchId === heldOpenKey?.batchId && !allowOpen) return { kind: 'unknown', key: heldOpenKey }
    if (args[3].key.batchId === heldReceiptKey?.batchId) {
      receiptKeys.push(args[3].key.batchId)
      receiptReconcile.resolve(); await receiptReconcileGate.promise
      if (!allowReceipt) return { kind: 'unknown', key: heldReceiptKey }
    }
    return reconcile(...args)
  })
  const child = controlledModel(async function* () {
    const number = ++launches
    if (options.activeForeground && number === 2) { foregroundStarted.resolve(); await foregroundGate.promise }
    else await childGate.promise
    yield { type: 'text/chunk', text: 'original child result' }
    if (options.failChild) { yield { type: 'error', error: new Error('Controlled dispatched child failure') }; return }
    yield { type: 'end' }
  })
  const parent = controlledModel(async function* (request) {
    parentRequests.push(request)
    if (parentRequests.length === 1) {
      if (options.rewindFsWrite) yield { type: 'tool_call', call: { id: 'original-fs-write', name: 'write', args: { path: 'greet.txt', text: 'goodbye' } } }
      for (let i = 0; i < (options.spawnCount ?? 1); i++) yield { type: 'tool_call', call: { id: 'original-spawn-' + i, name: 'spawn_agent', args: { task_name: 'original' + i, agent_type: 'probe', message: 'return original result', fork_turns: 'none' } } }
    }
    else {
      if (options.activeForeground && parentRequests.length === 2) {
        yield { type: 'tool_call', call: { id: 'foreground-a', name: 'spawn_agent', args: { task_name: 'held-a', agent_type: 'probe', message: 'hold original work', fork_turns: 'none', background: false } } }
        yield { type: 'end' }; return
      }
      if (options.holdParentStep && parentRequests.length === 2) {
        parentStep.resolve(); await parentGate.promise
        yield { type: 'tool_call', call: { id: 'normal-parent-step', name: 'fixture_step', args: {} } }
        yield { type: 'end' }; return
      }
      if (JSON.stringify(request.messages).includes('<task_result>') || JSON.stringify(request.messages).includes('<task_error>')) {
        delivery.resolve()
        if (options.failDelivery) { yield { type: 'error', error: generationError('GENERATION_CLOSED') }; return }
      }
      if (!resultRead && JSON.stringify(request.messages).includes('read original retained result')) {
        resultRead = true
        yield { type: 'tool_call', call: { id: 'read-original-result', name: 'get_task_output', args: { task_ids: ['task-1'] } } }
      } else yield { type: 'text/chunk', text: 'parent finished' }
    }
    yield { type: 'end' }
  })
  const mount = () => createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
    rewindStoreRoot: options.rewindFsWrite ? join(root, 'rewind-store') : undefined,
    extensionsFor: options.extensionsFor,
    telemetry,
    model: parent, modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access', codeMode: { mode: 'off' }, contextWindow: 100000,
    pluginAgents: [{ name: 'probe', description: 'delivery fixture', systemPrompt: 'Return the original result', tools: [] }],
    additionalTools: [{ name: 'fixture_step', description: 'A normal parent step boundary', inputSchema: {}, isReadOnly: true, execute: async () => ({ stepped: true }) }],
    allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'child' }),
    resolveRoleModel: async () => ({ status: 'ready', binding: { client: child, contextWindow: 100000 } }),
  })
  let service = mount()
  const evidence = async (label: string, failure?: unknown) => {
    if (!process.env.IH_DELIVERY_EVIDENCE_ROOT) return
    await mkdir(process.env.IH_DELIVERY_EVIDENCE_ROOT, { recursive: true })
    const view = originalDocument.view, assembly = closed ? undefined : await service.assemblyFor('parent').catch(() => undefined)
    await writeFile(join(process.env.IH_DELIVERY_EVIDENCE_ROOT, `${label}.json`), JSON.stringify({ root, launches, heldTerminal, terminalKeys, receiptKeys, backendTrace, warnings, telemetryEvents, pending: assembly?.inbox.pending(), deliveryPending: readDeliveries(view).pending(), requests: parentRequests.map(r => r.messages), events: (await backend.read('parent')).events, failure: inspect(failure, { depth: 8 }) }, null, 2))
  }
  return {
    root, output, get service() { return service }, get backend() { return backend }, get coordinator() { return coordinator }, parentRequests,
    launchCount: () => launches,
    waitForForeground: () => foregroundStarted.promise,
    releaseForeground: () => foregroundGate.resolve(),
    settleOriginalSpawnSources: async () => { for (const original of spawnSources) await original.source.close() },
    async start() {
      if (options.compatibilityOrigin === 'unknown') {
        await (await service.assemblyFor('parent')).agent.run('run an ordinary child', new AbortController().signal)
      } else if (options.compatibilityOrigin === 'delegated' || options.compatibilityOrigin === 'b2') {
        const inputId = options.compatibilityOrigin === 'b2' ? 'b2-initial' : 'delegated-parent'
        if (options.compatibilityOrigin === 'delegated') await receivedInputsFor(originalDocument, 'parent').inbox.admit({ inputId, text: 'run an ordinary child', delivery: 'queue', intent: 'user', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', originSessionId: 'delegator' } })
        await (await service.assemblyFor('parent')).agent.runAdmitted!('run an ordinary child', new AbortController().signal, undefined, inputId)
      } else if (options.compatibilityOrigin === 'synthetic') {
        await receivedInputsFor(originalDocument, 'parent').inbox.admit({ inputId: 'synthetic-parent', text: 'run an ordinary child', delivery: 'queue', intent: 'system', provenance: { kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'session.schedule' }, synthetic: { description: 'synthetic trigger', scope: 'turn' } })
        await service.submit('parent', 'run an ordinary child', new AbortController().signal, { admittedInputId: 'synthetic-parent' })
      } else await service.submit('parent', 'run an ordinary child', new AbortController().signal)
    },
    releaseChild: () => childGate.resolve(),
    waitForDeliveryRequest: () => {
      let timer: ReturnType<typeof setTimeout>
      return Promise.race([delivery.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No real parent delivery request after original child completion')), 5000) })]).finally(() => clearTimeout(timer))
    },
    waitForHeldTerminal: () => terminal.promise,
    waitForTerminalCommitted: () => terminalCommitted.promise,
    waitForConsumed: () => consumed.promise,
    waitForReceiptUnknown: () => receiptUnknown.promise,
    waitForTaskSaveFailed: () => taskSaveFailed.promise,
    releaseTaskSave: () => { allowTaskSave = true },
    waitForReceiptReconcile: () => receiptReconcile.promise,
    releaseReceiptReconcile: () => receiptReconcileGate.resolve(),
    waitForReceiptPrepared: () => receiptPrepared.promise,
    waitForParentStep: () => parentStep.promise,
    waitForOpenUnknown: () => openUnknown.promise,
    waitForTerminalReconcile: () => {
      let timer: ReturnType<typeof setTimeout>
      return Promise.race([terminalReconcile.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Original terminal acknowledgment never received same-source recovery activation')), 5000) })]).finally(() => clearTimeout(timer))
    },
    releaseTerminalOutcome: () => { allowTerminal = true },
    terminalKeys,
    releaseOpen: () => { allowOpen = true },
    releaseParentStep: () => parentGate.resolve(),
    executionErrors: () => telemetryEvents.filter(event => event.type === 'session/error'),
    releaseReceiptPreparation: () => receiptGate.resolve(),
    releaseReceipt: () => { allowReceipt = true },
    receiptKeys,
    releaseTerminal: () => terminalGate.resolve(),
    evidence,
    async reopen() {
      await service.close(); await coordinator.close()
      backend = createJsonlBackend(join(root, 'sessions'))
      coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract); service = mount()
      await service.assemblyFor('parent')
    },
    async close() {
      if (closed) return
      childGate.resolve(); foregroundGate.resolve(); terminalGate.resolve(); receiptGate.resolve(); receiptReconcileGate.resolve(); parentGate.resolve(); allowReceipt = true; allowOpen = true; allowTerminal = true; allowTaskSave = true
      const failures: unknown[] = []
      off()
      try {
        for (const close of [() => service.close(), () => coordinator.close(), () => output.close()]) try { await close() } catch (e) { failures.push(e) }
        await evidence('cleanup-' + root.split(/[\\/]/).at(-1), failures)
        closed = failures.length === 0
        expect(warnings.filter(message => !expectedWarnings.has(message)), 'unexpected delivery fixture warnings').toEqual([])
        if (options.holdTerminalUnknown) expect(warnings.some(message => message.includes('Original delivery sources require settlement'))).toBe(true)
        if (failures.length) { console.info('original-delivery-cleanup-failures', inspect(failures, { depth: 8 })); throw new AggregateError(failures, 'Delivery fixture cleanup failed') }
      } finally { restoreWarning() }
    },
  }
}
