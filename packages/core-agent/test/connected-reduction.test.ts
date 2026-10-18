import { expect, it } from 'vitest'
import { append, createSession, deriveMessages } from '@i-harness/core-session'
import { createAgent } from '../src/index.ts'
import { createSummaryPort } from '@i-harness/compaction'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'

const ctx = { emit: async () => {}, services: { get: () => undefined } } as never
const tools = { schemas: () => [] } as never
function history() {
  const session = createSession()
  append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'H' })
  for (const label of ['E1', 'E2', 'tail']) {
    append(session, { type: 'step/start' }); append(session, { type: 'assistant/message', text: `${label} ${'x'.repeat(label === 'tail' ? 10 : 5000)}` }); append(session, { type: 'step/end' })
  }
  return session
}
it('standalone configured compaction requires an explicit summary factory', async () => {
  const session = history(), model = createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture', fetch: async () => { throw Error('Unexpected transport') } } as any)
  const agent = createAgent(ctx, { session, model, tools, systemPrompt: '', compact: { contextWindow: 20000 } })
  expect(await agent.compact!()).toMatchObject({ compacted: false, outcome: 'blocked', publication: 'none', blockedReason: 'summary-unavailable' })
})
it('unsupported opaque source blocks manual reduction before preparation and preserves its original graph',async()=>{
 const session=history(),cycle:{self?:unknown}={};cycle.self=cycle;let preparations=0
 append(session,{type:'step/start'});append(session,{type:'tool/call',callId:'opaque',name:'read',args:{}});append(session,{type:'tool/result',callId:'opaque',name:'read',output:cycle});append(session,{type:'step/end'})
 const model={async prepare(){preparations++;throw Error('must not prepare')},async *stream(){throw Error('must not stream')}}
 const agent=createAgent(ctx,{session,model,tools,summaryFactory:createSummaryPort,systemPrompt:'',compact:{contextWindow:20000}})
 expect(await agent.compact!()).toMatchObject({compacted:false,outcome:'blocked',publication:'none',blockedReason:'opaque'})
 expect(preparations).toBe(0);expect(cycle.self).toBe(cycle)
})
it('publishes one positional replacement from only the selected native source using actual preparation', async () => {
  const session = history(), requests: any[] = []
  const model = createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture', fetch: async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)))
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: checkpointOfLength(600) } }] })}\n\ndata: [DONE]\n\n`)
  } } as any)
  const agent = createAgent(ctx, { session, model, tools, summaryFactory: createSummaryPort, systemPrompt: 'whole system', compact: { contextWindow: 20000, prune: false } })
  const result = await agent.compact!()
  expect(result).toMatchObject({ compacted: true, outcome: 'ready', publication: 'nondurable', summary: checkpointOfLength(600) })
  expect(requests).toHaveLength(1)
  expect(requests[0].messages.map((message: any) => message.content).join('\n')).toContain('E1 ')
  expect(requests[0].messages.map((message: any) => message.content).join('\n')).not.toContain('tail ')
  expect(deriveMessages(session).map(message => message.content)).toEqual(['H', checkpointOfLength(600), `tail ${'x'.repeat(10)}`])
  expect(session.events.filter(event => event.type === 'compaction/replacement')).toHaveLength(1)
})
