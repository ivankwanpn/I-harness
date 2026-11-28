import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiClient } from '../src/index.ts'
import type { LLMRequest } from '@i-harness/llm-seam'
import { PNG, JPEG, GIF } from '../../image-validation/test/fixtures.ts'
afterEach(() => vi.unstubAllGlobals())
const request: LLMRequest = { systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }] }
it("applies Google's evidenced parameter restrictions to the actual endpoint and model resource", async () => {
  const options = { generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } } }
  const google = createGeminiClient({ apiKey: "test", baseUrl: "https://generativelanguage.googleapis.com/v1beta/", model: "models/gemini-3.8-flash", options })
  await expect(google.prepare!(request)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  const custom = { apiKey: "test", baseUrl: "https://proxy.invalid", model: "gemini-3.8-flash", options }
  const proxy = createGeminiClient(custom)
  custom.baseUrl = "https://generativelanguage.googleapis.com"
  await expect(proxy.prepare!(request)).resolves.toMatchObject({ measurement: { input: { modelId: "gemini-3.8-flash" } } })
})
const contents = [{ role: 'model', parts: [{ functionCall: { id: 'a', name: 'read', args: {} } }, { functionCall: { id: 'b', name: 'read', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { id: 'b', name: 'read', response: {} } }, { functionResponse: { id: 'a', name: 'read', response: {} } }] }]
it('validates actual raw sibling closure without historical authority', async () => {
  const client = createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents } })
  expect((await client.prepare!(request)).validation).toMatchObject({ coverage: 'final-protocol' })
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents: contents.slice(0, 1) } }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'message-order' } })
})
it('reads optional ProtoJSON null and exact integer aliases without rewriting args', async () => {
  const client = createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { generation_config: { max_output_tokens: '2048', thinking_config: { thinking_budget: null } } } })
  expect((await client.prepare!(request)).measurement.output).toMatchObject({ effectiveCap: 2048 })
})
it('retains direct tool image bytes after all sibling outcomes', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  let sent: any
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response('') })
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', inputModalities: ['text', 'image'] }).prepare!({ ...request, messages: [...request.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }] }, { role: 'tool', toolCallId: 'a', content: [{ type: 'image', image: { mediaType: 'image/png', dataBase64: image } }] }] })
  for await (const _ of prepared.stream()) {}
  expect(JSON.stringify(sent)).toContain(image)
  expect(JSON.stringify(sent)).not.toContain('[image]')
})
it('preserves actual error outcome and image bytes without inventing successful output', async () => {
  let sent: any
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response('') })
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', inputModalities: ['text', 'image'] }).prepare!({ ...request, messages: [...request.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'read', args: {} }] }, { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'original error' }, { type: 'image', image: { mediaType: 'image/png', dataBase64: image } }], isError: true }, { role: 'tool', toolCallId: 'b', content: 'B' }, { role: 'user', content: 'human' }] })
  for await (const _ of prepared.stream()) {}
  expect(sent.contents[2].parts[0]).toEqual({ functionResponse: { id: 'a', name: 'read', response: { error: { output: 'original error' } } } })
  expect(sent.contents[2].parts[1]).toEqual({ functionResponse: { id: 'b', name: 'read', response: { output: 'B' } } })
  expect(sent.contents[3]).toEqual({ role: 'user', parts: [{ text: 'Images from tool call "a":' }, { inlineData: { mimeType: 'image/png', data: image } }] })
  expect(sent.contents[4]).toEqual({ role: 'user', parts: [{ text: 'human' }] })
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
})

it('places each supported Gemini 3 tool image inside its own function response', async () => {
  let body: any
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('') })
  const input: LLMRequest = { ...request, messages: [...request.messages,
    {role:'assistant',content:'',toolCalls:[{id:'first',name:'read',args:{}},{id:'second',name:'read',args:{}}]},
    {role:'tool',toolCallId:'second',isError:true,content:[{type:'text',text:'partial'}, {type:'image',image:{mediaType:'image/jpeg',dataBase64:JPEG}}]},
    {role:'tool',toolCallId:'first',content:[{type:'image',image:{mediaType:'image/png',dataBase64:PNG}}]},
    {role:'user',content:'Use those results.'},
  ] }
  const target = createGeminiClient({ apiKey:'test', model:'models/gemini-3.8-flash', inputModalities:['text','image'] })
  const p = await target.prepare!(input)
  for await (const _ of p.stream()) {}
  expect(body.contents[2].parts).toEqual([
    {functionResponse:{id:'second',name:'read',response:{error:{output:'partial'}},parts:[{inlineData:{mimeType:'image/jpeg',data:JPEG}}]}},
    {functionResponse:{id:'first',name:'read',response:{output:''},parts:[{inlineData:{mimeType:'image/png',data:PNG}}]}},
  ])
  expect(body.contents.slice(3)).toEqual([{role:'user',parts:[{text:'Use those results.'}]}])
  expect(p.measurement.input.components.images.imageCount).toBe(2)
})

it('looks up a reused call id in its own exchange and keeps a successful error-shaped payload successful', async () => {
  let body: any
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { body=JSON.parse(String(init.body));return new Response('') })
  const p=await createGeminiClient({apiKey:'test',model:'fixture'}).prepare!({...request,messages:[...request.messages,
    {role:'assistant',content:'',toolCalls:[{id:'reused',name:'read',args:{}}]}, {role:'tool',toolCallId:'reused',content:'{"error":"a log field"}'},
    {role:'assistant',content:'',toolCalls:[{id:'reused',name:'write',args:{}}]}, {role:'tool',toolCallId:'reused',isError:true,content:'failed'},
  ]})
  for await(const _ of p.stream()) {}
  expect(body.contents[2].parts[0].functionResponse).toEqual({id:'reused',name:'read',response:{output:{error:'a log field'}}})
  expect(body.contents[4].parts[0].functionResponse).toEqual({id:'reused',name:'write',response:{error:{output:'failed'}}})
})

it('uses the sent call order when returning same-name results to a positional Gemini 2.5 route', async () => {
  let body: any
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { body=JSON.parse(String(init.body));return new Response('') })
  const prepared=await createGeminiClient({apiKey:'test',model:'gemini-2.5-flash'}).prepare!({...request,messages:[...request.messages,
    { role:'assistant',content:'',toolCalls:[{id:'issued-b',name:'read',args:{file:'b'}},{id:'issued-a',name:'read',args:{file:'a'}}],
      providerContinuation:{kind:'anthropic',model:'other',contentOrder:[{kind:'tool',index:1,id:'issued-a'},{kind:'tool',index:0,id:'issued-b'}]} },
    {role:'tool',toolCallId:'issued-b',content:'B'}, {role:'tool',toolCallId:'issued-a',content:'A'},
  ]})
  for await(const _ of prepared.stream()) {}
  expect(body.contents[1].parts.map((p: any)=>p.functionCall.id)).toEqual(['issued-a','issued-b'])
  expect(body.contents[2].parts.map((p: any)=>[p.functionResponse.id,p.functionResponse.response.output])).toEqual([['issued-a','A'],['issued-b','B']])
})

it('classifies remote function media separately from local bytes and rejects a known unsupported GIF before sending', async () => {
  const target = createGeminiClient({apiKey:'test',model:'gemini-3.8-flash',inputModalities:['text','image']})
  await expect(target.prepare!({...request,messages:[{role:'user',content:[{type:'image',image:{mediaType:'image/gif',dataBase64:GIF}}]}]})).rejects.toMatchObject({code:'INVALID_ARGUMENT'})
  const remote = createGeminiClient({apiKey:'test',model:'fixture',options:{contents:[
    {role:'model',parts:[{functionCall:{name:'read',id:'x',args:{}}}]},
    {role:'user',parts:[{functionResponse:{name:'read',id:'x',response:{},parts:[{fileData:{mimeType:'image/png',fileUri:'https://fixture.invalid/image'}}]}}]},
  ]}})
  const facts = (await remote.prepare!(request)).measurement.input
  expect(facts.coverage).toBe('incomplete')
  expect(facts.components.images).toMatchObject({imageCount:1,binaryBytes:0})
})
it('validates and measures supported raw FunctionResponse media at its original native position', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const raw = [{ role: 'model', parts: [{ functionCall: { id: 'a', name: 'read', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { id: 'a', name: 'read', response: { output: 'pixels' }, parts: [{ inline_data: { mime_type: 'image/png', data: image } }] } }] }]
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents: raw } }).prepare!(request)
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
  const malformed = structuredClone(raw) as any
  malformed[1].parts[0].functionResponse.parts = [null]
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents: malformed } }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})
