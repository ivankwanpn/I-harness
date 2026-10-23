import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent } from '../src/index.ts'
import { createRetryingClient, resolveRetryPolicy } from '@i-harness/llm-seam'
import { expect, it } from 'vitest'
import { append, createSession, createNondurableFactOwner, committedFactSeqs } from '@i-harness/core-session'
import { createModelStep } from '../src/agent/model-step.ts'

async function fixture(fail?: 'audit' | 'result' | 'end') {
  const session = createSession()
  append(session, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  append(session, { type: 'step/start', actionId: 'action', attemptId: 'attempt' })
  const facts = createNondurableFactOwner(session).beginAction().facts
  const failure = new Error('original provider failure'), saveFailure = new Error('save failure'), attempts: string[] = []
  const agent = facts.agent, tools = facts.tools
  const wrapped = { ...facts, agent: { ...agent,
    async auditAssistant(e: Parameters<typeof agent.auditAssistant>[0]) { attempts.push('audit'); if (fail === 'audit') throw saveFailure; return agent.auditAssistant(e) },
    async lifecycle(e: Parameters<typeof agent.lifecycle>[0]) { attempts.push(e.type); if (fail === 'end' && e.type === 'step/end') throw saveFailure; return agent.lifecycle(e) },
  }, tools: { ...tools, async result(e: Parameters<typeof tools.result>[0]) { attempts.push('result'); if (fail === 'result') throw saveFailure; return tools.result(e) } } }
  const lifecycle = { turnOpen: true, stepOpen: true, providerCompleted: false, stepFailed: false }, reasoning: string[] = []
  const step = createModelStep({ session, facts: wrapped }, reasoning, async ev => {
    const seq = committedFactSeqs(await tools.call({ type: 'tool/call', callId: ev.call.id!, name: ev.call.name, args: ev.call.args }))[0]!
    return { callId: ev.call.id!, name: ev.call.name, args: ev.call.args, eventSeq: seq }
  }, lifecycle, 1, undefined, () => 1)
  await step.accept({ type: 'text/chunk', text: 'audit text' })
  await step.accept({ type: 'reasoning', text: 'audit thought' })
  await step.accept({ type: 'tool_call', call: { id: 'call', name: 'effect', args: {} } })
  return { session, step, attempts, failure, saveFailure }
}
it.each([undefined, 'audit', 'result', 'end'] as const)('reentered terminal settlement joins its original operation (%s)', async fault => {
  const f = await fixture(fault)
  const first = await f.step.fail(f.failure).catch(e => e), second = await f.step.fail(f.failure).catch(e => e)
  if (fault) { expect(first.cause).toBe(f.failure); expect(second.cause).toBe(f.failure); expect(first.errors).toContain(f.saveFailure) }
  else { expect(first).toBe(f.failure); expect(second).toBe(f.failure) }
  expect(f.attempts.filter(x => x === 'audit')).toHaveLength(1)
  expect(f.attempts.filter(x => x === 'result')).toHaveLength(fault === 'audit' ? 0 : 1)
  const events = f.session.events
  expect(events.filter(e => e.type === 'tool/dispatch' || e.type === 'model/exchange-accepted')).toEqual([])
  if (!fault) {
    expect(events.filter(e => e.type === 'tool/result')).toEqual([expect.objectContaining({ callId: 'call', name: 'effect', isError: true, output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH', error: expect.any(String) } })])
    expect(events.slice(-3).map(e => e.type)).toEqual(['tool/result', 'step/failed', 'step/end'])
    expect(events.filter(e => e.type === 'reasoning').map(e => e.text)).toEqual(['audit thought'])
  }
})
it('discard retains observed native audit metadata and ending bits once', async () => {
  const f = await fixture()
  await f.step.accept({ type: 'end', truncated: true, thinkingBlocks: [{ type: 'thinking', thinking: 'signed', signature: 'signature' }] })
  await f.step.discard(); await f.step.discard()
  expect(f.session.events.filter(e => e.type === 'assistant/message')).toEqual([expect.objectContaining({ text: 'audit text', thinkingBlocks: [{ type: 'thinking', thinking: 'signed', signature: 'signature' }] })])
  expect(f.session.events.at(-1)).toMatchObject({ type: 'step/end', truncated: true })
})

it('real retry waiting retains its original provider cause when local audit saving fails', async () => {
  const f = await fixture('audit')
  const client = createRetryingClient({ async *stream() { yield { type: 'usage', usage: { inputTokens: 13 } }; throw f.failure } }, resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1 } }))
  let error: unknown
  try { for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: '', retryOutput: 'discard' })) await f.step.accept(ev) } catch (caught) { error = caught }
  expect(error).toMatchObject({ cause: f.failure })
  expect((error as AggregateError).errors).toContain(f.saveFailure)
})

it.each([false, true])('throwing usage sink preserves primary failure and local audit (retry=%s)', async retry => {
  const session = createSession(), ctx = createContext(), tools = createToolRegistry(ctx)
  const failure = Object.assign(new Error('provider original'), { code: 'SERVER' }), telemetryFailure = new Error('sink failure')
  let sends = 0, usage = 0
  const base = { async *stream() {
    sends++
    yield { type: 'text/chunk' as const, text: 'failed audit' }
    yield { type: 'tool_call' as const, call: { id: 'call', name: 'effect', args: {} } }
    yield { type: 'usage' as const, usage: { inputTokens: 13 } }
    throw failure
  } }
  const model = retry ? createRetryingClient(base, resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1 } })) : base
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: '', telemetry: { emit(event) { if (event.type === 'provider/usage') { usage++; throw telemetryFailure } }, close() {} } })
  const error = await agent.run('start').catch(e => e)
  const primary = (e: unknown): unknown => e instanceof AggregateError ? primary(e.cause) : e
  expect(primary(error)).toBe(failure); expect(usage).toBe(1); expect(sends).toBe(1)
  expect(session.events.filter(e => e.type === 'tool/result')).toHaveLength(1)
  expect(session.events.filter(e => e.type === 'assistant/message')).toHaveLength(1)
  expect(session.events.filter(e => e.type === 'model/exchange-accepted' || e.type === 'tool/dispatch')).toEqual([])
})

it('a throwing error observer retains the provider cause and observed usage', async () => {
  const session = createSession(), ctx = createContext(), original = Object.assign(new Error('original'), { code: 'SERVER' }), observer = new Error('observer')
  let usage = 0
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: '', model: { async *stream() {
    yield { type: 'tool_call', call: { id: 'call', name: 'effect', args: {} } }
    yield { type: 'usage', usage: { inputTokens: 12 } }
    yield { type: 'error', error: original }
  } }, telemetry: { emit(e) { if (e.type === 'provider/error') throw observer; if (e.type === 'provider/usage') usage++ }, close() {} } })
  const error = await agent.run('fail').catch(e => e)
  expect(error.cause?.cause).toBe(original)
  expect(error.errors).toContain(observer)
  expect(usage).toBe(1)
  expect(session.events.filter(e => e.type === 'tool/result')).toHaveLength(1)
})
