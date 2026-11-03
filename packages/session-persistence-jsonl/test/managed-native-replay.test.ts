import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveMessages } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { createGeminiClient } from '../../llm-gemini/src/index.ts'
import { createContext } from '../../core-plugin/src/index.ts'
import { createToolRegistry } from '../../core-tools/src/index.ts'
import { createAgent } from '../../core-agent/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
afterEach(()=>vi.unstubAllGlobals())

it('preserves actual signed numeric/source-order/deep Gemini call data through managed write and cold prepared replay', async()=>{
  const root=await mkdtemp(join(tmpdir(),'ih-f1-native-cold-')),backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}})
  const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
  const depth=6000,deep='{"x":'.repeat(depth)+'1'+'}'.repeat(depth)
  const args='{"10":"ten","2":"two","z":1,"a":2,"deep":'+deep+',"text":"中文\\r\\nline\\nnext","$ref":{"kind":"group","position":99}}'
  let sends=0,bodies=0
  vi.stubGlobal('fetch',async(input:URL|string)=>{
    const url=new URL(String(input))
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.pathname).toContain('/models/fixture:streamGenerateContent')
    if(url.hostname!=='127.0.0.1'||!url.pathname.includes('/models/fixture:streamGenerateContent'))throw new Error('Unmatched controlled transport')
    sends++
    return new Response('data: '+(sends===1?' {"candidates":[{"content":{"parts":[{"functionCall":{"id":"a","name":"read","args":'+args+'},"thoughtSignature":"sig"}]},"finishReason":"STOP"}]}':'{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}')+'\n\n')
  })
  const client=createGeminiClient({apiKey:'controlled',model:'fixture',baseUrl:'http://127.0.0.1:1/v1beta'})
  tools.register({name:'read',description:'fixture',inputSchema:{},execute:async value=>{
    bodies++;expect(Object.keys(value as object)).toEqual(['2','10','z','a','deep','text','$ref'])
    let cursor=(value as {deep:unknown}).deep
    for(let index=0;index<depth;index++)cursor=(cursor as {x:unknown}).x
    expect(cursor).toBe(1);return'real result'
  }})
  try{
    const agent=createAgent(ctx,{session:document.view,factOwner:document,generationFactory:action=>createGenerationLifecycle(document.view,id,action),sessionId:id,tools,systemPrompt:'',model:client})
    expect((await agent.run('preserve the signed call')).finalText).toBe('done')
    await document.close()
    const cold=await coordinator.openManagedDocument(id)
    const prepared=await client.prepare!({systemPrompt:'',tools:[],messages:deriveMessages(cold.view)})
    expect(prepared.validation?.native).toBe('preserved')
    expect([bodies,sends]).toEqual([1,2])
    const call=cold.view.events.find(event=>event.type==='tool/call')!
    expect(call.type==='tool/call'&&Object.keys(call.args as object)).toEqual(['2','10','z','a','deep','text','$ref'])
  }finally{await coordinator.close().catch(()=>{})}
})

it('preserves exact CRLF/Chinese legacy bytes and adds only its required separator before the first format6 frame',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ih-f1-legacy-bytes-')),id='legacy'
  const legacy='{"type":"plan/mode","mode":"on","seq":0}\r\n{"type":"user/message","text":"中文\\r\\nline\\nnext","seq":1}'
  await writeFile(join(root,id+'.jsonl'),JSON.stringify({sessionId:id,createdAt:'fixture',formatVersion:5})+'\n'+legacy)
  const coordinator=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}})
  try{
    const document=await coordinator.openManagedDocument(id)
    expect((await document.metadata.admit({type:'plan/mode',mode:'off'})).kind).toBe('committed')
    const raw=await readFile(join(root,id+'.jsonl')),headerEnd=raw.indexOf(10),header=JSON.parse(raw.subarray(0,headerEnd).toString())
    const count=Buffer.alloc(8);count.writeBigUInt64BE(2n)
    const digest=createHash('sha256').update('ih.fact-legacy.v1\0').update(count).update(legacy).digest('hex')
    expect(header.journal).toEqual({version:1,legacyBodyBytes:Buffer.byteLength(legacy),legacyEventCount:2,legacyPrefixDigest:digest,separatorBytes:1})
    expect(raw.subarray(headerEnd+1,headerEnd+1+Buffer.byteLength(legacy)+1).toString()).toBe(legacy+'\n')
    await document.close()
    expect((await coordinator.openManagedDocument(id)).view.events.map(event=>event.seq)).toEqual([0,1,2])
  }finally{await coordinator.close()}
})
