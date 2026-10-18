import { expect, it } from 'vitest'
import { append, createSession, deriveMessages } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history, spyModel, closedExchange, autoCap, autoConfig } from './fixtures/history.ts'
import { prepareTextFixture, checkpointOfLength } from './fixtures/checkpoint.ts'

it('auto publishes one positional replacement and truthfully certifies the full request target', async () => {
  const session = history(20, 400), model = spyModel()
  const result = await createCompactionHarness({ model: model.model, config: autoConfig, maxOutputTokens: autoCap }).maybeCompact(session)
  expect(result).toMatchObject({ compacted: true, outcome: 'ready', publication: 'nondurable', summary: checkpointOfLength(600) })
  expect(session.events.at(-1)).toMatchObject({ type: 'context/soft-reduction', op: 'terminal', outcome: 'target-ready', publication: 'committed' })
  expect(session.events.filter(event => event.type.startsWith('compaction/'))).toHaveLength(1)
  expect(deriveMessages(session).map(message => message.content)).toEqual([checkpointOfLength(600)])
  expect(model.requests).toHaveLength(1)
})
it('below-target auto has a typed unchanged publication disposition and no model call', async () => {
  const session = createSession(), model = spyModel()
  append(session, { type: 'user/message', text: 'hi' })
  expect(await createCompactionHarness({ model: model.model, config: autoConfig }).maybeCompact(session)).toEqual({ compacted: false, shadowedSeqs: [], outcome: 'ready', publication: 'none' })
  expect(model.requests).toEqual([])
})
it('manual requests still summarize below pressure only when they strictly reduce prepared input', async () => {
  const session = history(), model = spyModel(), engine = createCompactionHarness({ model: model.model, config: autoConfig })
  expect((await engine.maybeCompact(session)).compacted).toBe(false)
  expect((await engine.compact(session)).compacted).toBe(true)
  const before = session.events.length
  expect((await engine.compact(session)).compacted).toBe(false)
  expect(session.events).toHaveLength(before)
})
it.each(['error', 'empty', 'oversize', 'invalid'] as const)('failed %s checkpoint never publishes a rewrite', async mode => {
  const session = history(), before = JSON.stringify(session)
  const engine = createCompactionHarness({ model: { prepare: prepareTextFixture, async *stream() {
    if (mode === 'error') throw Error('controlled summary failure')
    if (mode !== 'empty') yield { type: 'text/chunk', text: mode === 'oversize' ? 'x'.repeat(10000) : 'x'.repeat(600) }
    yield { type: 'end' }
  } }, config: autoConfig })
  expect(await engine.compact(session)).toMatchObject({ compacted: false, outcome: 'blocked', publication: 'none', reason: 'summarizer-failed' })
  expect(JSON.stringify(session)).toBe(before)
})
it('no complete selected unit is reported as a closed source block without generation', async () => {
  const session = createSession(), model = spyModel()
  append(session, { type: 'turn/start' }); append(session, { type: 'step/start' }); append(session, { type: 'user/message', text: 'active H' })
  expect(await createCompactionHarness({ model: model.model, config: autoConfig }).compact(session)).toMatchObject({ compacted: false, blockedReason: 'no-eligible-source' })
  expect(model.requests).toEqual([])
})
it('explicit reset retains raw archive, active H, newest whole retained groups and unknown effects', async () => {
  for (let retainLast = 0; retainLast < 16; retainLast++) {
    const session = createSession(), model = spyModel()
    append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'exact active H' })
    closedExchange(session, 'old-a', 2000, true); closedExchange(session, 'old-b', 2000, true)
    const before = session.events.slice()
    const result = await createCompactionHarness({ model: model.model, config: autoConfig }).resetWindow(session, retainLast)
    expect(session.events.slice(0, before.length)).toEqual(before)
    const messages = deriveMessages(session), calls = new Set(messages.flatMap(message => message.role === 'assistant' ? message.toolCalls?.map(call => call.id) ?? [] : []))
    for (const message of messages) if (message.role === 'tool') expect(calls.has(message.toolCallId)).toBe(true)
    expect(messages.some(message => message.content === 'exact active H')).toBe(true)
    expect(result.reset === true).toBe(result.compacted)
    expect(model.requests).toEqual([])
  }
})
it('empty reset returns unchanged and no false receipt', async () => {
  expect(await createCompactionHarness({ model: spyModel().model, config: autoConfig }).resetWindow(createSession(), 20)).toEqual({ compacted: false, shadowedSeqs: [], outcome: 'unchanged', publication: 'none' })
})
it('a one-event reset hint that lands on step/end retains the whole latest physical exchange',async()=>{
 const session=createSession();closedExchange(session,'older',2000,true);closedExchange(session,'latest',2000,true)
 const result=await createCompactionHarness({model:spyModel().model,config:autoConfig}).resetWindow(session,1)
 expect(result.compacted).toBe(true)
 expect(JSON.stringify(deriveMessages(session))).toContain('latest-done')
 expect(JSON.stringify(deriveMessages(session))).not.toContain('older-done')
})
