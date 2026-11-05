import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSession } from '@i-harness/core-session'
import { wrapPreparedRequest, type ModelClient } from '@i-harness/llm-seam'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createAgent, type SessionRequestContext, type SuccessfulInstructionHandoff } from '../src/index.ts'
import { createLoopbackProvider } from './helpers/provider-loopback.ts'

const wire = (tool: boolean, ending = tool ? 'tool_calls' : 'stop') => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'original-call', function: { name: 'probe', arguments: '{}' } }] } : { content: 'done' }, finish_reason: ending }], usage: { prompt_tokens: 100, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`

it.each(['success', 'notification-fault', 'flush-fault', 'stop', 'unknown', 'unknown-absent', 'refusal', 'truncation', 'observer-fault', 'fetch-fault'] as const)('original physical completion qualifies handoff and retains real sources: %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-source-'))
  let unknownReady = false, armed = false, originalKey: import('@i-harness/core-session').BatchKey | undefined
  const backend = createJsonlBackend(root, {
    wrapOwnedBatch: append => async (...args) => {
      const uncertain = armed && (mode === 'unknown' || mode === 'unknown-absent') && !originalKey && JSON.parse(Buffer.from(args[3].bytes).toString()).events.some((event: { type: string }) => event.type === 'model/exchange-accepted')
      if (uncertain) { originalKey = args[3].key; if (mode === 'unknown-absent') return { kind: 'unknown', key: originalKey } }
      const outcome = await append(...args)
      if (uncertain) return { kind: 'unknown', key: originalKey! }
      return outcome
    },
    wrapOwnedReconcile: reconcile => (...args) => armed && (mode === 'unknown' || mode === 'unknown-absent') && !unknownReady ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args),
  })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract), { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const sources = new Set<import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>>()
  const begin = document.beginAction.bind(document)
  document.beginAction = signal => { const action = begin(signal), register = action.registerSettlementSource.bind(action); action.registerSettlementSource = (...args) => { const source = register(...args); sources.add(source); return source }; return action }
  armed = true
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { if (mode === 'fetch-fault') response.destroy(); else response.end(wire(true, mode === 'refusal' ? 'content_filter' : mode === 'truncation' ? 'length' : 'tool_calls')) }, async response => { response.end(wire(false)) }])
  const ctx = createContext(), tools = createToolRegistry(ctx), stop = new AbortController()
  let effects = 0, held = 0, retained = 0, promoted = 0, failedFlush = false
  const handoffs: SuccessfulInstructionHandoff[] = [], token = Object.freeze({ kind: 'instruction-request' as const, version: 1 as const })
  const requestContext: SessionRequestContext = {
    async reconcile() {}, capture: () => token, current: value => value === token,
    retain(value) { expect(value).toBe(token); retained++; held++; let released = false; return { async release() { if (!released) { held--; released = true } } } },
    succeeded(handoff) {
      const accepted = document.view.events[handoff.acceptedSeq]
      if (accepted?.type === 'model/exchange-accepted' && accepted.callSeqs.length) expect(held).toBeGreaterThan(0)
      else expect(held).toBe(0)
      expect(handoff.candidate.instructions).toBe(token)
      expect(handoff.outcome.kind).toBe('committed')
      expect(document.view.events[handoff.acceptedSeq]).toMatchObject({ type: 'model/exchange-accepted' })
      expect(Object.isFrozen(handoff.calls)).toBe(true)
      for (const call of handoff.calls) {
        const original = document.view.events[call.eventSeq!]
        expect(original).toMatchObject({ type: 'tool/call', callId: call.callId, name: call.call.name, args: call.call.args })
        expect(Object.isFrozen(call.call.args)).toBe(true)
      }
      handoffs.push(handoff)
      if (mode === 'notification-fault') throw new Error('notification fault')
      return undefined
    }, promotedHumanRequest() { promoted++ }, async close() {},
  }
  tools.register({ name: 'probe', description: 'real source ownership control', inputSchema: { type: 'object' }, async execute() { effects++; expect(held).toBeGreaterThan(0); return 'result' } })
  const agent = createAgent(ctx, { session: document.view, factOwner: document, sessionId: id, tools,
    model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), systemPrompt: 's', requestContext,
    generationFactory: (action, dependencies) => createGenerationLifecycle(document.view, id, action, undefined, dependencies),
    telemetry: { emit(event) { if (mode === 'observer-fault' && event.type === 'provider/usage') throw Error('controlled usage observer fault') }, close() {} },
    async flush() {
      if (!failedFlush && document.view.events.some(event => event.type === 'model/exchange-accepted')) {
        failedFlush = true
        if (mode === 'flush-fault') throw new Error('original flush fault')
        if (mode === 'stop') stop.abort(new Error('original Stop'))
      }
    },
  })
  try {
    const result = await agent.run('unknown direct input cannot retire selection', stop.signal).catch(error => error)
    expect(promoted).toBe(0)
    expect(retained).toBeGreaterThanOrEqual(['fetch-fault', 'refusal', 'truncation'].includes(mode) ? 1 : 2)
    if (mode === 'success') { expect(result).toMatchObject({ finalText: 'done' }); expect(handoffs).toHaveLength(2); expect(effects).toBe(1) }
    else { expect(result).toBeInstanceOf(Error); expect(effects).toBe(0); expect(server.requests).toHaveLength(1); expect(handoffs).toHaveLength(mode === 'notification-fault' ? 1 : 0) }
    if (mode === 'unknown' || mode === 'unknown-absent') {
      // An uncertain acceptance keeps both original producers pinned until its
      // frame reconciles. When the batch never reached the journal the drain's
      // own reconcile resolves it to a definitive absence, so both are released.
      expect(held).toBe(mode === 'unknown' ? 2 : 0)
      unknownReady = true
      // The absent arm never reached the journal at all, so the document
      // reconcile reports the batch as not-issued rather than absent.
      expect(await document.reconcile(originalKey!)).toMatchObject({ kind: mode === 'unknown' ? 'committed' : 'not-issued' })
      for (const source of sources) await source.close()
      await coordinator.close()
      expect(handoffs).toHaveLength(0)
      expect(server.requests).toHaveLength(1)
    }
    expect(held).toBe(0)
    if (mode !== 'success') expect(document.view.events.filter(event => event.type === 'tool/result')).toMatchObject(mode === 'fetch-fault' ? [] : [{ isError: true, output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } }])
  } finally { unknownReady = true; await coordinator.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['confirm-only', 'second-issue-without-confirmation'] as const)('real prepared local completion is unqualified for consumption: %s', async mode => {
  const session = createSession(), ctx = createContext(), token = Object.freeze({ kind: 'instruction-request' as const, version: 1 as const })
  let sends = 0, notifications = 0, held = 0
  const client = createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-local', fetch: async () => { sends++; throw Error('No physical transport is authorized by the local completion fixture') } })
  const model: ModelClient = { ...client, async prepare(request) {
    const prepared = await client.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control) => (async function* () {
      const semantic = prepared.measurement.input.semanticIdentity!, payload = prepared.measurement.payloadIdentity!
      control?.confirmExecution?.({ version: 1, sendId: 'original-confirm-only', semanticId: semantic.semanticId, payloadId: payload.id, payloadKind: payload.kind })
      if (mode === 'second-issue-without-confirmation') { control?.onTransportIssue?.(); control?.onTransportIssue?.() }
      yield { type: 'text/chunk' as const, text: 'local completion' }; yield { type: 'end' as const }
    })())
  } }
  const requestContext: SessionRequestContext = { async reconcile() {}, capture: () => token, current: value => value === token,
    retain() { held++; let released = false; return { async release() { if (!released) { released = true; held-- } } } }, succeeded() { notifications++; return undefined }, promotedHumanRequest() {}, async close() {} }
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), model, systemPrompt: 's', requestContext })
  expect(await agent.run('local unqualified fixture')).toMatchObject({ finalText: 'local completion' })
  expect([sends, notifications, held]).toEqual([0, 0, 0])
  expect(session.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
})
