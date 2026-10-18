import { expect, it } from 'vitest'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { summarizeFixture } from './fixtures/summary.ts'
import { checkpointOfLength } from './fixtures/checkpoint.ts'
const image = { mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }
it.each([true, false])('preserves selected image objects or blocks before generation (vision=%s)', async vision => {
  const bodies: any[] = []
  const model = createOpenAICompatibleClient({ model: 'fixture', apiKey: 'controlled', inputModalities: vision ? ['text', 'image'] : ['text'], fetch: async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response('data: '+JSON.stringify({ choices: [{ delta: { content: checkpointOfLength(600) } }] })+'\n\ndata: [DONE]\n\n')
  } } as any)
  const promise = summarizeFixture(model, '', 1024, undefined, undefined, 500, undefined, { systemPrompt: '', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'exact image caption' }, { type: 'image', image }] }] })
  if (vision) { expect((await promise).text).toBe(checkpointOfLength(600)); expect(JSON.stringify(bodies)).toContain(image.dataBase64); expect(JSON.stringify(bodies)).toContain('exact image caption') }
  else { await expect(promise).rejects.toMatchObject({ kind: 'opaque' }); expect(bodies).toEqual([]) }
})
it('portable source keeps text, tool names/arguments/results and images without signatures as ordinary text', async () => {
  const { portableSource } = await import('../src/summary/source.ts'), { summarySource } = await import('./fixtures/summary.ts')
  const source = summarySource([{ role: 'assistant', content: 'exact answer', toolCalls: [{ id: 'c', name: 'read', args: { path: 'literal.ts' } }], thinkingBlocks: [{ type: 'thinking', thinking: 'ordinary reasoning', signature: 'SECRET-SIGNATURE' }] }, { role: 'tool', toolCallId: 'c', content: 'exact result' }, { role: 'user', content: [{ type: 'text', text: 'caption' }, { type: 'image', image }] }])
  const encoded = portableSource(source.groups), text = JSON.stringify(encoded)
  for (const literal of ['exact answer', 'ordinary reasoning', 'read', 'literal.ts', 'exact result', 'caption', image.dataBase64]) expect(text).toContain(literal)
  expect(text).not.toContain('SECRET-SIGNATURE')
})
it('portable opaque-only native continuation is a typed block', async () => {
  const { portableSource } = await import('../src/summary/source.ts'), { summarySource } = await import('./fixtures/summary.ts')
  expect(() => portableSource(summarySource([{ role: 'assistant', content: '', thinkingBlocks: [{ type: 'redacted_thinking', data: 'OPAQUE' }] }]).groups)).toThrow(expect.objectContaining({ kind: 'source-unrepresentable' }))
})
it('inherited native opaque-only source also blocks without claiming semantic coverage', async () => {
  const { selectedSource } = await import('../src/summary/source.ts'), { summarySource } = await import('./fixtures/summary.ts')
  expect(() => selectedSource(summarySource([{ role: 'assistant', content: '', thinkingBlocks: [{ type: 'redacted_thinking', data: 'OPAQUE' }] }]).groups, false)).toThrow(expect.objectContaining({ kind: 'source-unrepresentable' }))
})
it('keeps ordinary reasoning indices after a redacted block and refuses incomplete native order',async()=>{
 const {portableSource}=await import('../src/summary/source.ts'),{summarySource}=await import('./fixtures/summary.ts')
 const message={role:'assistant' as const,content:'answer',thinkingBlocks:[{type:'redacted_thinking' as const,data:'encrypted'},{type:'thinking' as const,thinking:'visible reasoning',signature:'signature'}],providerContinuation:{kind:'anthropic' as const,model:'m',contentOrder:[{kind:'reasoning' as const,index:1},{kind:'text' as const,text:'answer'}]}}
 expect(JSON.stringify(portableSource(summarySource([message]).groups))).toContain('visible reasoning')
 expect(()=>portableSource(summarySource([{...message,providerContinuation:{...message.providerContinuation,contentOrder:[{kind:'text',text:'answer'}]}}]).groups)).toThrow(expect.objectContaining({kind:'source-unrepresentable'}))
})
