import { expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { decodeFactBatch, type BatchKey, type ManagedAction, type ProducerFactOutcome, type SessionView, type SettlementFacts } from '@i-harness/core-session'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createUnmanagedTaskChildHost } from '../src/lifecycle/task-child-host.ts'
import { createContextOutputService } from '@i-harness/context-output'
import { registerCodeMode } from '@i-harness/code-mode'
import type { LLMRequest } from '@i-harness/llm-seam'
import { createSessionService, createDurableSessionLoader } from '../src/index.ts'
import { controlledModel } from './controlled-model.ts'

it('continues the original parent and child after landed output reconciles on its original handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-live-retained-batch-'))
  const backend = createJsonlBackend(join(root, 'sessions'), {
    wrapOwnedBatch: append => async (...args: Parameters<typeof append>) => {
      const outcome = await append(...args)
      if (!originalKey && args[0] !== 'parent' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/output')) {
        originalKey = args[3].key; originalOutcome = outcome; childId = args[0]
        return { kind: 'unknown' as const, key: originalKey }
      }
      return outcome
    },
    wrapOwnedReconcile: reconcile => async (...args: Parameters<typeof reconcile>) => {
      if (originalKey?.batchId === args[3].key.batchId) {
        reconciles.push(args[3].key)
        if (!allowOriginal) return { kind: 'unknown' as const, key: originalKey }
      }
      return reconcile(...args)
    },
  })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' })
  const parentDocument = await coordinator.openManagedDocument('parent')
  const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'fixture', config: { enabled: false } })
  let originalKey: BatchKey | undefined, originalOutcome: unknown, childId: string | undefined, childSessionId: string | undefined
  let observerError: unknown, allowOriginal = false, producers = 0, parentRequests = 0
  let batchSource: SettlementFacts<ProducerFactOutcome> | undefined, turnAction: ManagedAction<ProducerFactOutcome> | undefined
  let originalView: SessionView | undefined, heldAtRejection = false, checkedLive = false
  const reconciles: BatchKey[] = [], childRequests: LLMRequest[] = []
  const child = controlledModel(async function* (request) {
    if (childRequests.length) {
      // The first model batch's unknown output landed on its original handle and
      // reconciled; the continuation request is served by the SAME still-open
      // turn action, with its batch settlement source closed and the child
      // document live and ready.
      expect(batchSource).toBeDefined()
      expect(() => batchSource!.assertHeld()).toThrow()
      turnAction!.assertOpen()
      expect(turnAction!.signal.aborted).toBe(false)
      expect((await coordinator.openManagedDocument((childSessionId ?? childId)!)).view).toBe(originalView)
      ;(await coordinator.openManagedDocument((childSessionId ?? childId)!)).assertReady()
      checkedLive = true
    }
    childRequests.push(request)
    if (childRequests.length === 1) yield { type: 'tool_call', call: { id: 'child-code', name: 'code_exec', args: { code: 'text(await tools.owner_probe({}))', yield_time_ms: 5000 } } }
    else yield { type: 'text/chunk', text: 'child final' }
    yield { type: 'end' }
  })
  const parent = controlledModel(async function* () {
    if (++parentRequests === 1) yield { type: 'tool_call', call: { id: 'parent-spawn', name: 'spawn_agent', args: { task_name: 'probe', agent_type: 'probe', message: 'emit once', fork_turns: 'none', background: false } } }
    else yield { type: 'text/chunk', text: 'parent final' }
    yield { type: 'end' }
  })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
    prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }),
    model: parent, modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access', codeMode: { mode: 'mixed' }, contextWindow: 100000,
    pluginAgents: [{ name: 'probe', description: 'owned output fixture', systemPrompt: 'Emit once', tools: ['owner_probe', 'code_exec', 'code_wait'] }],
    additionalTools: [{ name: 'owner_probe', description: 'literal fixture', inputSchema: {}, isReadOnly: true, execute: async () => { producers++; return { probe: 'once' } } }],
    allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'child' }),
    resolveRoleModel: async () => ({ status: 'ready', binding: { client: child, contextWindow: 100000 } }),
    codeModeFactory(ctx, tools, options) {
      if (options.sessionId !== 'parent') {
        originalView = options.session; childSessionId = options.sessionId
        const owner = options.factOwner!, begin = owner.beginAction.bind(owner)
        owner.beginAction = signal => {
          const action = begin(signal)
          // The turn action is the first signal-bearing action: code mode's own
          // mount action (and its events) is created without one.
          if (signal) turnAction ??= action
          return action
        }
      }
      // The accepted instruction batch is prepared through `prepareCaptured`,
      // so the batch's settlement source is observable on the capture identity
      // (not on the public `prepare` options the non-captured path receives).
      const capture = tools.capture.bind(tools)
      tools.capture = (input, identity) => {
        const handle = capture(input, identity)
        if (options.sessionId !== 'parent' && input.name === 'code_exec' && identity?.settlementSource) batchSource = identity.settlementSource
        return handle
      }
      const dispatch = tools.dispatch.bind(tools)
      tools.dispatch = prepared => {
        return dispatch(prepared).catch(error => {
        if (options.sessionId !== 'parent' && prepared.tool.name === 'code_exec' && originalKey) {
          observerError = error
          try { const owner = options.factOwner as typeof parentDocument & { assertObservable?: () => void }; (owner.assertObservable ?? owner.assertReady.bind(owner))() } catch { heldAtRejection = true }
          allowOriginal = true
        }
        throw error
      })
      }
      return registerCodeMode(ctx, tools, { ...options, config: { ...options.config, mode: options.sessionId === 'parent' ? 'off' : 'only' } })
    },
  })
  let failure: unknown
  try {
    await service.submit('parent', 'run one child', new AbortController().signal)
    const parentEvents = parentDocument.view.events
    const childDocument = await coordinator.openManagedDocument((childSessionId ?? childId)!)
    const events = childDocument.view.events
    expect(originalOutcome).toHaveProperty('kind', 'committed')
    expect(observerError).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(heldAtRejection).toBe(true); expect(checkedLive).toBe(true)
    expect(reconciles.length).toBeGreaterThan(0)
    expect(reconciles.every(key => key.batchId === originalKey!.batchId)).toBe(true)
    expect(events.filter(event => event.type === 'assistant/message').at(-1)).toMatchObject({ text: 'child final' })
    expect(parentEvents.filter(event => event.type === 'assistant/message').at(-1)).toMatchObject({ text: 'parent final' })
    expect([producers, childRequests.length, parentRequests]).toEqual([1, 2, 2])
    for (const type of ['agent/input/admitted', 'agent/input/promoted', 'user/message', 'code/call', 'code/dispatch', 'code/output'] as const) expect(events.filter(event => event.type === type)).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/result' && event.callId === 'child-code')).toEqual([expect.objectContaining({ envelope: expect.objectContaining({ execution: expect.objectContaining({ outcome: 'succeeded' }) }) })])
    expect(events.filter(event => event.type === 'code/cell' && event.state === 'completed')).toHaveLength(1)
    expect(JSON.stringify(childRequests[1]!.messages)).toContain('once')
    childDocument.assertReady()
  } catch (error) { failure = error; throw error }
  finally {
    if (process.env.IH_LIVE_BATCH_EVIDENCE) {
      await mkdir(process.env.IH_LIVE_BATCH_EVIDENCE, { recursive: true })
      await writeFile(join(process.env.IH_LIVE_BATCH_EVIDENCE, 'fixture.json'), JSON.stringify({ root, childId, originalKey, originalOutcome, reconciles, producers, parentRequests, heldAtRejection, checkedLive, childRequests: childRequests.map(request => request.messages), parent: parentDocument.view.events, child: childId ? (await coordinator.openManagedDocument(childId)).view.events : [], error: inspect(failure, { depth: 12 }), observerError: inspect(observerError, { depth: 8 }) }, null, 2))
    }
    allowOriginal = true
    await service.close().catch(() => {}); await coordinator.close().catch(() => {}); await output.close()
  }
}, 20000)
