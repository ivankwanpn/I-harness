import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { fromJSONL } from '@i-harness/core-session'
import { createSessionService } from '@i-harness/session-executor'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { HarnessClient, SdkRunError, SdkTimeoutError } from '../src/client.ts'
import { createSdkServer } from '../src/server.ts'

const frame = (value:unknown) => 'data: '+JSON.stringify(value)+'\n\n'
const done = 'data: [DONE]\n\n'

it.each([false,true])('preserves one dispatched tool through Stop, restart and resume (caller timeout=%s)', async timedOut => {
  const root=await mkdtemp(join(tmpdir(),'ih-stop-tool-'))
  const followup=Promise.withResolvers<void>(), disconnected=Promise.withResolvers<void>()
  const bodies: Array<{messages: Array<{role:string;content:unknown;tool_call_id?:string}>}> = []
  let effects=0
  const provider=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk
    bodies.push(JSON.parse(text))
    res.writeHead(200,{'content-type':'text/event-stream'})
    if(bodies.length===1) {
      res.end(frame({choices:[{index:0,delta:{tool_calls:[{index:0,id:'effect-1',type:'function',function:{name:'effect',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+done)
    } else if(bodies.length===2) {
      res.once('close',()=>disconnected.resolve())
      res.write(frame({choices:[{delta:{content:'Unfinished continuation'},finish_reason:null}]}))
      followup.resolve()
    } else {
      const answer=timedOut && bodies.length===3 ? 'The queued successor finished.' : 'Resumed after the confirmed result.'
      res.end(frame({choices:[{delta:{content:answer},finish_reason:'stop'}]})+done)
    }
  })
  provider.listen(0,'127.0.0.1');await once(provider,'listening')
  const address=provider.address()
  if(!address||typeof address==='string') throw Error('Missing local provider port')
  const model=createOpenAICompatibleClient({model:'fixture',apiKey:'synthetic-local-only',baseUrl:'http://127.0.0.1:'+address.port})
  function open(){
    const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
    const service=createSessionService({workspace:root,coordinator,model,contextWindow:16000,maxOutputTokens:128,
      managedRuntime:{systemPrompt:'Test',tools:[{name:'effect',description:'Record one local effect',inputSchema:{type:'object'},async execute(){effects++;return {marker:'confirmed-effect',count:effects}}}]}})
    const input=new PassThrough(),output=new PassThrough()
    const server=createSdkServer(service,{coordinator,onWrite:message=>{input.write(JSON.stringify(message)+'\n')}})
    const jobs=new Set<Promise<unknown>>()
    output.on('data',line=>{const work=server.handleLine(String(line));jobs.add(work);void work.finally(()=>jobs.delete(work))})
    const client=new HarnessClient(input,output)
    return {client,coordinator,async drain(){await Promise.allSettled([...jobs])},async close(){
      await server.close();await service.close();await coordinator.close();input.end();output.end()
    }}
  }
  let host=open()
  try {
    await host.coordinator.create({sessionId:'s'})
    await host.client.initialize()
    const preview=Promise.withResolvers<void>()
    const off=host.client.onNotification(frame=>{
      if(frame.method!=='session/event')return
      const event=(frame.params as {event?:{type?:string;text?:string}})?.event
      if(event?.type==='assistant/chunk'&&event.text==='Unfinished continuation')preview.resolve()
    })
    const first=host.client.run({sessionId:'s',prompt:'Call the tool once.',...(timedOut?{timeoutMs:30}:{})}).catch((error:unknown)=>error)
    try {await Promise.all([followup.promise,preview.promise])} finally {off()}
    expect(effects).toBe(1)
    expect(bodies[1]!.messages).toContainEqual(expect.objectContaining({role:'tool',tool_call_id:'effect-1',content:expect.stringContaining('confirmed-effect')}))
    if(timedOut) expect(await first).toBeInstanceOf(SdkTimeoutError)
    const successor=timedOut ? host.client.run({sessionId:'s',prompt:'Independent queued question.'}) : undefined
    if(successor) await expect.poll(async()=>(await host.client.status('s')).queued,{timeout:5000}).toBeGreaterThan(0)
    await expect(host.client.cancel('s')).resolves.toMatchObject({cancelled:true})
    const outcome=await first
    if(!timedOut) {
      expect(outcome).toBeInstanceOf(SdkRunError)
      const own=(outcome as SdkRunError).events
      expect(own.filter(e=>e.type==='tool/result')).toHaveLength(1)
      expect(own.filter(e=>e.type==='step/failed')).toHaveLength(1)
      expect(own).toContainEqual(expect.objectContaining({type:'assistant/chunk',text:'Unfinished continuation'}))
    }
    await disconnected.promise
    if(successor) {
      const second=await successor
      expect(second.text).toBe('The queued successor finished.')
      expect(second.events.some(e=>e.type==='tool/result'||e.type==='step/failed')).toBe(false)
    }
    await host.drain()
    await host.close()
    const stopped=fromJSONL(await readFile(join(root,'s.jsonl'),'utf8'))
    expect(stopped.events.filter(e=>e.type==='tool/dispatch')).toHaveLength(1)
    expect(stopped.events.filter(e=>e.type==='tool/result')).toHaveLength(1)
    expect(stopped.events.filter(e=>e.type==='turn/end')).toHaveLength(timedOut?2:1)
    expect(stopped.events.filter(e=>e.type==='model/exchange-accepted')).toHaveLength(timedOut?2:1)
    // The observed partial text is kept for the user alongside a failed
    // step. Only an accepted assistant message can enter the next request.
    const interrupted=stopped.events.find(e=>e.type==='assistant/message'&&e.text==='Unfinished continuation')
    expect(interrupted?.seq).toBeDefined()
    expect(stopped.events.filter(e=>e.type==='step/failed')).toHaveLength(1)
    expect(stopped.events.some(e=>e.type==='model/exchange-accepted'&&e.assistantSeq===interrupted!.seq)).toBe(false)
    host=open();await host.client.initialize()
    const visible=await host.client.history('s',{limit:1000})
    expect(visible.events.filter(e=>e.type==='tool/result')).toEqual(stopped.events.filter(e=>e.type==='tool/result'))
    const resumed=await host.client.run({sessionId:'s',prompt:'Continue from the confirmed result.'})
    expect(resumed.text).toBe('Resumed after the confirmed result.')
    expect(resumed.events.some(e=>e.type==='tool/result'||e.type==='step/failed')).toBe(false)
    expect(bodies).toHaveLength(timedOut?4:3)
    expect(bodies.at(-1)!.messages.filter(m=>m.role==='tool'&&m.tool_call_id==='effect-1')).toHaveLength(1)
    expect(JSON.stringify(bodies.at(-1)!.messages)).not.toContain('Unfinished continuation')
    expect(effects).toBe(1)
  } finally {provider.closeAllConnections();await host.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
},60000)
