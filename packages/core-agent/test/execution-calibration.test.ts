import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession, type Session } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createPreparedPayload, createRetryingClient, resolveRetryPolicy, type LiveExecutionIdentity, type ModelClient, type ExecutionConfirmation, type LLMUsage } from '@i-harness/llm-seam'
import { ProjectionCounter } from '@i-harness/token-meter'
import { createAgent } from '../src/index.ts'
import { createExecutionOwner } from '../src/agent/execution.ts'
import { captureRequestCandidate } from '../src/agent/request-snapshot.ts'
const E: LiveExecutionIdentity = { version: 1, runtimeId: 'runtime', bindingLifetimeId: 'binding', authEpoch: 'E', scope: 'managed-subscription', coldCompatible: false }
it('peeks another lifetime without clearing observed F and retains mutating execution ownership', () => {
  const owner = createExecutionOwner(), F = { ...E, authEpoch: 'F' }, M = { ...E, bindingLifetimeId: 'M' }
  const request = { messages: [{ role: 'user' as const, content: 'task' }], tools: [], systemPrompt: '' }
  const prepared = createPreparedPayload({ body: { task: 'task' }, request,
    describe(body) { const c = new ProjectionCounter('projected-pricing-v2'); c.unit('task', 'user', () => c.text('visibleText', body.task)); return { input: c.finish({ protocol: 'test', modelId: 'm' }, body, 'shape'), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
    output: () => ({ capSupport: 'unsupported', minimumCap: 1, source: 'request' }), cap: b => b,
    async *execute() { throw Error('no transport') },
  })
  const model: ModelClient = { async *stream() { throw Error('no transport') } }
  const evidence = captureRequestCandidate(createSession(), 'owner', { model, executionIdentity: E }, { systemPrompt: '', tools: [] }, 0)
  const state = { epochRebuilds: 0, hasStartedSend: false, hasObservedOutput: false }
  const candidate = owner.candidate(prepared, evidence, state, false, () => true, () => { throw Error('unexpected retirement') })
  const confirmation: ExecutionConfirmation = { version: 1, sendId: 'send', semanticId: prepared.measurement.input.semanticIdentity!.semanticId,
    payloadId: prepared.measurement.payloadIdentity!.id, payloadKind: prepared.measurement.payloadIdentity!.kind, identity: F }
  expect(candidate.confirm(confirmation)).toBeDefined()
  expect(owner.peekExpected(M)).toEqual({ kind: 'known', identity: M })
  expect(owner.peekExpected(E)).toEqual({ kind: 'known', identity: F })
  const stale = owner.candidate(prepared, evidence, state, true, () => false, () => { throw Error('unexpected retirement') })
  expect(() => stale.confirm(confirmation)).toThrow(/Candidate changed/)
  candidate.close(); expect(candidate.confirm({ ...confirmation, identity: { ...E, authEpoch: 'G' } })).toBeUndefined()
  expect(owner.peekExpected(E)).toEqual({ kind: 'known', identity: F })
  owner.expected(M)
  expect(owner.peekExpected(E)).toEqual({ kind: 'known', identity: E })
})
function fixture(session = createSession(), retry = false) {
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let identity: LiveExecutionIdentity | undefined = E, confirms = 0, sends = 0, hooks = 0, claims = 0
  const epochs: (LiveExecutionIdentity | undefined)[] = []
  let usage: LLMUsage = { inputTokens: 100, outputTokens: 9000, inputTokenSemantics: 'includes-cache' }, failNext = false, usageBeforeConfirm = false
  const confirmers: ((c: ExecutionConfirmation) => void)[] = []
  ctx.on('agent/pre-step', () => { hooks++ })
  const model: ModelClient = { executionIdentity: E, async *stream() { throw Error('unprepared') }, async prepare(request) {
    return createPreparedPayload({ body: { messages: request.messages }, request,
      describe(body) { const c = new ProjectionCounter('projected-pricing-v2'); for (const m of body.messages) c.unit(m, m.role, () => c.text('visibleText', m.content)); return { input: c.finish({ protocol: 'test', modelId: 'm' }, body, 'fixed-shape'), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
      output: () => ({ capSupport: 'unsupported', minimumCap: 1, source: 'request' }), cap: b => b,
      async *execute(_b, _s, control, execution) { if (usageBeforeConfirm) yield { type: 'usage', usage }; if (control.confirmExecution) confirmers.push(control.confirmExecution); confirms++; execution.confirm(epochs.length ? epochs.shift() : identity); sends++; if (failNext) { failNext = false; throw Object.assign(Error('failed transport'), { code: 'SERVER' }) }; yield { type: 'usage', usage }; yield { type: 'text/chunk', text: 'answer' }; yield { type: 'end' } },
    })
  } }
  const sending = retry ? Object.assign(createRetryingClient(model, resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } })), { executionIdentity: E }) : model
  const agent = createAgent(ctx, { session, sessionId: 'owner', model: sending, tools, systemPrompt: '', budget: { contextWindow: 20000 }, stepInputs: { claimAtStepBoundary() { claims++ } } })
  return { agent, session, confirmers, preUsage: () => { usageBeforeConfirm = true }, usage: (value: LLMUsage) => { usage = value }, fail: () => { failNext = true }, set: (epoch: string | undefined) => { identity = epoch ? { ...E, authEpoch: epoch } : undefined }, epochs, counts: () => ({ confirms, sends, hooks, claims }) }
}
it('writes exact accepted v2 lineage and prices only actual replay suffix on the next live step', async () => {
  const f = fixture(); await f.agent.run('first'); await f.agent.followup('second')
  const samples = f.session.events.filter(e => e.type === 'context/usage' && e.version === 2 && e.op === 'sample')
  expect(samples).toHaveLength(2)
  expect(f.session.events.filter(e => e.type === 'context/budget').some((e: any) => e.snapshot.estimateSource === 'provider-anchor-plus-projection')).toBe(true)
  const sample: any = samples[0], accepted: any = f.session.events[sample.checkpoint.accepted.acceptedSeq]
  expect(accepted.version).toBe(2); expect(accepted.request).toEqual(sample.checkpoint.request)
  expect(accepted.request.coldCompatible).toBe(false)
})
it('hands E to F once and retains safely observed F for the following step', async () => {
  const f = fixture(); await f.agent.run('establish E'); f.set('F'); await f.agent.followup('change'); await f.agent.followup('stable')
  expect(f.counts()).toEqual({ confirms: 4, sends: 3, hooks: 3, claims: 3 })
  expect(f.session.events.filter(e => e.type === 'context/usage' && e.version === 2 && e.op === 'retire')).toHaveLength(1)
})
it('pins a known F handoff and terminates E to F to G before any new send', async () => {
  const f = fixture(); await f.agent.run('establish E'); f.epochs.push({ ...E, authEpoch: 'F' }, { ...E, authEpoch: 'G' })
  await expect(f.agent.followup('change twice')).rejects.toMatchObject({ code: 'EXECUTION_IDENTITY_CHANGED' })
  expect(f.counts()).toEqual({ confirms: 3, sends: 1, hooks: 2, claims: 2 })
})
it('establishes first actual F without an unanchored E rebuild and readmits identity loss honestly', async () => {
  const f = fixture(); f.set('F'); await f.agent.run('first F'); expect(f.counts().confirms).toBe(1)
  f.set(undefined); await f.agent.followup('lost')
  expect(f.counts().confirms).toBe(3); expect(f.counts().sends).toBe(2)
  expect(f.session.events.filter(e => e.type === 'model/exchange-accepted').at(-1)?.version).toBe(1)
})
it('requires explicit format readiness before an old standalone Session sends', async () => {
  const f = fixture({ formatVersion: 3, events: [] } as Session)
  await expect(f.agent.run('old')).rejects.toMatchObject({ code: 'CONTEXT_FORMAT_PRECONDITION' })
  expect(f.counts().sends).toBe(0)
})
it('requires the same readiness before a standalone manual summary can send', async () => {
  const ctx = createContext(), session: Session = { formatVersion: 3, events: [{ type: 'user/message', text: 'recorded work', seq: 0 }] }
  let sends = 0
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: '', compact: { contextWindow: 20000, minSummaryChars: 1, retainTokens: 0, prune: false }, model: { async *stream() { sends++; yield { type: 'text/chunk', text: 'complete summary' }; yield { type: 'end' } } } })
  await expect(agent.compact!()).rejects.toMatchObject({ code: 'CONTEXT_FORMAT_PRECONDITION' })
  expect(sends).toBe(0)
})
it('preserves a compatible earlier anchor after later accepted missing or invalid usage', async () => {
  const f = fixture(); await f.agent.run('anchor'); f.usage({}); await f.agent.followup('missing'); f.usage({ inputTokens: -1, inputTokenSemantics: 'includes-cache' }); await f.agent.followup('invalid')
  expect(f.session.events.filter(e => e.type === 'context/usage' && e.version === 2 && e.op === 'sample')).toHaveLength(1)
  expect(f.agent.contextBudget!()).toMatchObject({ kind: 'ready', snapshot: { estimateSource: 'provider-anchor-plus-projection' } })
})
it('keeps a prior compatible sample after a transient failed send followed by accepted missing usage', async () => {
  const f = fixture(undefined, true); await f.agent.run('anchor'); f.fail(); f.usage({})
  await f.agent.followup('transient then missing')
  expect(f.counts().sends).toBe(3)
  expect(f.session.events.filter(e => e.type === 'context/usage' && e.version === 2 && e.op === 'sample')).toHaveLength(1)
  expect(f.session.events.filter(e => e.type === 'context/usage' && e.version === 2 && e.op === 'retire')).toHaveLength(0)
  expect(f.agent.contextBudget!()).toMatchObject({ kind: 'ready', snapshot: { estimateSource: 'provider-anchor-plus-projection' } })
})
it('does not reset retry allowance after a real send when mode is always', async () => {
  const f = fixture(undefined, true); await f.agent.run('anchor'); f.fail(); f.epochs.push(E, { ...E, authEpoch: 'F' })
  await expect(f.agent.followup('retry then epoch change')).rejects.toMatchObject({ code: 'EXECUTION_IDENTITY_CHANGED' })
  expect(f.counts()).toEqual({ confirms: 3, sends: 2, hooks: 2, claims: 2 })
  expect(f.session.events.filter(e => e.type === 'model/exchange-accepted')).toHaveLength(1)
})
it('treats provider usage observed without a send callback as output and refuses an epoch rebuild', async () => {
  const f = fixture(); await f.agent.run('anchor'); f.preUsage(); f.set('F')
  await expect(f.agent.followup('usage proves a response before late confirmation')).rejects.toMatchObject({ code: 'EXECUTION_IDENTITY_CHANGED' })
  expect(f.counts()).toEqual({ confirms: 2, sends: 1, hooks: 2, claims: 2 })
})
it('records only the successful retry send and its current physical attempt', async () => {
  const f = fixture(undefined, true); f.fail(); await f.agent.run('retry')
  const acceptance: any = f.session.events.find(e => e.type === 'model/exchange-accepted'), sample: any = f.session.events.find(e => e.type === 'context/usage' && e.version === 2 && e.op === 'sample')
  expect(f.counts().sends).toBe(2)
  expect(acceptance.attemptId).toBe((f.session.events[acceptance.stepStartSeq] as any).attemptId)
  expect(sample.checkpoint.accepted.attemptId).toBe(acceptance.attemptId)
  expect(sample.checkpoint.request.sendId).toBe(acceptance.request.sendId)
})
it('ignores an old settled collector after the next turn establishes F', async () => {
  const f = fixture(); await f.agent.run('E'); const old = f.confirmers[0]!, accepted: any = f.session.events.find(e => e.type === 'model/exchange-accepted')
  f.set('F'); await f.agent.followup('F')
  old({ version: 1, sendId: 'late', semanticId: accepted.request.semanticId, payloadId: accepted.request.payloadId, payloadKind: accepted.request.payloadKind, identity: { ...E, authEpoch: 'G' } })
  await f.agent.followup('still F')
  expect(f.counts()).toEqual({ confirms: 4, sends: 3, hooks: 3, claims: 3 })
})
it('keeps a raw custom completion structural and uncalibrated without a receipt', async () => {
  const ctx = createContext(), session = createSession()
  await createAgent(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: '', model: { async *stream() { yield { type: 'usage', usage: { inputTokens: 100, inputTokenSemantics: 'includes-cache' } }; yield { type: 'text/chunk', text: 'answer' }; yield { type: 'end' } } } }).run('custom')
  expect(session.events.find(e => e.type === 'model/exchange-accepted')?.version).toBe(1)
  expect(session.events.some(e => e.type === 'context/usage')).toBe(false)
})
it('retains the exact accepted fact and measured usage when the append observer throws after insertion', async () => {
  const session = createSession(event => { if (event.type === 'model/exchange-accepted') throw Error('observer failed after append') })
  const f = fixture(session)
  await expect(f.agent.run('accepted before observer failure')).rejects.toThrow('observer failed after append')
  expect(session.events.filter(e => e.type === 'context/usage' && e.version === 2 && e.op === 'sample')).toHaveLength(1)
  expect(session.events.some(e => e.type === 'step/failed')).toBe(false)
})
