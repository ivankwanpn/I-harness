import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { decodeFactBatch, subscribe, readDeliveries } from '@i-harness/core-session'
import { createSessionCoordinator, compileSemanticSeed } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import type { LLMRequest } from '@i-harness/llm-seam'
import { createSessionService, createDurableSessionLoader } from '../../src/index.ts'
import { controlledModel } from '../controlled-model.ts'
import { createTelemetry, type TelemetryEvent } from '@i-harness/telemetry'
import { receivedInputsFor } from '../../src/lifecycle/received-inputs.ts'

/** Only provider/physical backend gates are controlled. Task/source, Inbox,
 * receiver and serial lane are the actual service composition. */
export async function createDeliveryFixture(options: { holdTerminal?: boolean; holdTerminalUnknown?: boolean; spawnCount?: number; holdReceiptUnknown?: boolean; holdOpenUnknown?: boolean; holdReceiptBeforeIssue?: boolean; compatibilityOrigin?: 'synthetic' | 'unknown' | 'delegated' | 'b2'; holdParentStep?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ih-d1a-service-'))
  const backend = createJsonlBackend(join(root, 'sessions'))
  let coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  if (options.compatibilityOrigin === 'b2') {
    const now = Date.now()
    const outcome = await coordinator.bootstrapSemanticTarget({ invocation: { version: 1, operationId: 'delivery-b2-fixture', targetSessionId: 'parent', createdAt: new Date(now).toISOString(), requestDigest: 'a'.repeat(64) }, target: { kind: 'new' }, metadata: {},
      lineage: { origin: 'subagent', parentSession: 'delegator', subagentProtocolVersion: 1 }, seed: compileSemanticSeed({ kind: 'none' }),
      initial: { inputId: 'b2-initial', text: 'run an ordinary child', parentSessionId: 'delegator', startedAt: now, expiresAt: now + 3600000 } },
      { assertCurrent() {}, dependencies: { async confirm() { throw new Error('Empty B2 fixture has no dependencies') }, async reconcile() { throw new Error('Empty B2 fixture has no dependencies') } } })
    if (outcome.kind !== 'ready') throw new Error('Actual B2 fixture not ready: ' + JSON.stringify(outcome))
  } else await coordinator.create({ sessionId: 'parent', ...(options.compatibilityOrigin === 'delegated' ? { parentSession: 'delegator', origin: 'subagent' as const, subagentProtocolVersion: 1 as const, seedLength: 0 } : {}) })
  const originalDocument = await coordinator.openManagedDocument('parent')
  const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'd1a-fixture', config: { enabled: false } })
  const parentRequests: LLMRequest[] = []
  const telemetryEvents: TelemetryEvent[] = []
  const telemetry = createTelemetry([{ onEvent(event) { telemetryEvents.push(event) } }])
  const childGate = Promise.withResolvers<void>(), delivery = Promise.withResolvers<void>(), terminal = Promise.withResolvers<void>()
  const terminalGate = Promise.withResolvers<void>()
  const terminalCommitted = Promise.withResolvers<void>()
  const consumed = Promise.withResolvers<void>(), receiptUnknown = Promise.withResolvers<void>()
  const receiptPrepared = Promise.withResolvers<void>(), receiptGate = Promise.withResolvers<void>()
  const parentStep = Promise.withResolvers<void>(), parentGate = Promise.withResolvers<void>()
  const openUnknown = Promise.withResolvers<void>()
  const terminalReconcile = Promise.withResolvers<void>()
  if (!options.holdParentStep) parentGate.resolve()
  if (!options.holdReceiptBeforeIssue) receiptGate.resolve()
  let consumedCount = 0
  const off = subscribe(originalDocument.view, e => {
    if (e.type === 'subagent/end') terminalCommitted.resolve()
    if (e.type === 'agent/input/promoted' && e.inputId.startsWith('delivery-') && ++consumedCount === (options.spawnCount ?? 1)) consumed.resolve()
  })
  let launches = 0, heldTerminal = false, closed = false, resultRead = false
  if (!options.holdTerminal) terminalGate.resolve()
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  let heldReceiptKey: import('@i-harness/core-session').BatchKey | undefined, allowReceipt = !options.holdReceiptUnknown
  let heldOpenKey: import('@i-harness/core-session').BatchKey | undefined, allowOpen = !options.holdOpenUnknown
  let heldTerminalKey: import('@i-harness/core-session').BatchKey | undefined, allowTerminal = !options.holdTerminalUnknown
  const terminalKeys: string[] = []
  const backendTrace: unknown[] = []
  const receiptKeys: string[] = []
  backend.appendOwnedBatch = async (...args) => {
    const events = decodeFactBatch(args[3].bytes).events
    backendTrace.push({ phase: 'entered', key: args[3].key.batchId, events: events.map(e => ({ type: e.type, ...('op' in e ? { op: e.op } : {}) })) })
    if (events.some(e => e.type === 'agent/delivery-received')) { receiptPrepared.resolve(); await receiptGate.promise }
    if (args[0] === 'parent' && events.some(e => e.type === 'subagent/end')) {
      heldTerminal = true; terminal.resolve(); await terminalGate.promise
    }
    const outcome = await append(...args)
    backendTrace.push({ phase: 'returned', key: args[3].key.batchId, kind: outcome.kind })
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
  }
  backend.reconcileOwnedBatch = async (...args) => {
    if (args[3].key.batchId === heldTerminalKey?.batchId) {
      terminalKeys.push(args[3].key.batchId)
      if (!allowTerminal) { terminalReconcile.resolve(); return { kind: 'unknown', key: heldTerminalKey } }
    }
    if (args[3].key.batchId === heldOpenKey?.batchId && !allowOpen) return { kind: 'unknown', key: heldOpenKey }
    if (args[3].key.batchId === heldReceiptKey?.batchId) {
      receiptKeys.push(args[3].key.batchId)
      if (!allowReceipt) return { kind: 'unknown', key: heldReceiptKey }
    }
    return reconcile(...args)
  }
  const child = controlledModel(async function* () {
    launches++
    await childGate.promise
    yield { type: 'text/chunk', text: 'original child result' }
    yield { type: 'end' }
  })
  const parent = controlledModel(async function* (request) {
    parentRequests.push(request)
    if (parentRequests.length === 1) {
      for (let i = 0; i < (options.spawnCount ?? 1); i++) yield { type: 'tool_call', call: { id: 'original-spawn-' + i, name: 'spawn_agent', args: { task_name: 'original' + i, agent_type: 'probe', message: 'return original result', fork_turns: 'none' } } }
    }
    else {
      if (options.holdParentStep && parentRequests.length === 2) {
        parentStep.resolve(); await parentGate.promise
        yield { type: 'tool_call', call: { id: 'normal-parent-step', name: 'fixture_step', args: {} } }
        yield { type: 'end' }; return
      }
      if (JSON.stringify(request.messages).includes('<task_result>')) delivery.resolve()
      if (!resultRead && JSON.stringify(request.messages).includes('read original retained result')) {
        resultRead = true
        yield { type: 'tool_call', call: { id: 'read-original-result', name: 'get_task_output', args: { task_ids: ['task-1'] } } }
      } else yield { type: 'text/chunk', text: 'parent finished' }
    }
    yield { type: 'end' }
  })
  const mount = () => createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
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
    await writeFile(join(process.env.IH_DELIVERY_EVIDENCE_ROOT, `${label}.json`), JSON.stringify({ root, launches, heldTerminal, terminalKeys, receiptKeys, backendTrace, telemetryEvents, pending: assembly?.inbox.pending(), deliveryPending: readDeliveries(view).pending(), requests: parentRequests.map(r => r.messages), events: (await backend.read('parent')).events, failure: inspect(failure, { depth: 8 }) }, null, 2))
  }
  return {
    get service() { return service }, backend, get coordinator() { return coordinator }, parentRequests,
    launchCount: () => launches,
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
      coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }); service = mount()
      await service.assemblyFor('parent')
    },
    async close() {
      if (closed) return
      childGate.resolve(); terminalGate.resolve(); receiptGate.resolve(); parentGate.resolve(); allowReceipt = true; allowOpen = true; allowTerminal = true
      const failures: unknown[] = []
      off()
      for (const close of [() => service.close(), () => coordinator.close(), () => output.close()]) try { await close() } catch (e) { failures.push(e) }
      await evidence('cleanup-' + root.split(/[\\/]/).at(-1), failures)
      closed = failures.length === 0
      if (failures.length) throw new AggregateError(failures, 'Delivery fixture cleanup failed')
    },
  }
}
