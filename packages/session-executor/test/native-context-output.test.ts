import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createContextOutputService } from '@i-harness/context-output'
import { createSession } from '@i-harness/core-session'
import { registerCodeMode } from '@i-harness/code-mode'
import { createSessionAssembly } from '../src/assembly.ts'
import { resolveShell, createShellTools } from '@i-harness/shell'
import { registerExec, registerRetainedOutput } from '@i-harness/exec'
import { createNativeCodeTextRetention, installNativeContextOutput } from '../src/context-output.ts'

const cleanup: Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse()) await dispose()})
async function setup() {
  const base=resolve('build/native-context-capture-tests'); await mkdir(base,{recursive:true})
  const root=await mkdtemp(join(base,'capture-')); cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const service=createContextOutputService({root,workspaceId:'w',config:{enabled:true}}); cleanup.push(()=>service.close())
  const ctx=createContext(), tools=createToolRegistry(ctx),session=createSession()
  installNativeContextOutput(ctx,{service,session,sessionId:'s'})
  return{service,ctx,tools,session}
}
it('retains actual direct long output and returns an envelope within the model preview budget',async()=>{
  const{service,tools,session}=await setup(); const text='line\n'.repeat(5000)+'中段錯誤'+ 'end\n'.repeat(5000)
  tools.register({name:'long_text',description:'long',inputSchema:{type:'object'},isReadOnly:true,execute:async()=>text})
  const prepared=await tools.prepare({name:'long_text',args:{}},undefined,{sessionId:'s',callId:'direct'})
  const output=await tools.dispatch(prepared) as{output:string;contextRef:{id:string}}
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(service.status().config.maxPreviewBytes)
  expect(output.contextRef.id).toBeTruthy()
  const hits=await service.search({sessionId:'s'},{query:'中段錯誤'})
  expect(hits.hits.some(hit=>hit.ref.id===output.contextRef.id)).toBe(true)
  expect(session.events.some(event=>event.type==='context/result-ref')).toBe(true)
})
it('keeps nested Code Mode tool values intact while capturing them through the same registry',async()=>{
  const{tools,ctx,session}=await setup();const text='x'.repeat(50000)
  tools.register({name:'long_text',description:'long',inputSchema:{type:'object'},isReadOnly:true,execute:async()=>text})
  const mount=registerCodeMode(ctx,tools,{session,sessionId:'s',config:{mode:'only'}});cleanup.push(()=>mount.dispose())
  const result=await tools.execute({name:'code_exec',args:{code:'const v=await tools.long_text({}); text(v.length);'}})
  expect(result.output).toMatchObject({status:'completed',text:'50000'})
  expect(session.events.some(event=>event.type==='context/result-ref')).toBe(true)
})
it('retains complete emitted Code Mode text behind the bounded observation',async()=>{
  const{service,tools,ctx,session}=await setup()
  const mount=registerCodeMode(ctx,tools,{session,sessionId:'s',config:{mode:'only'},retainText:createNativeCodeTextRetention({service,session,sessionId:'s'})});cleanup.push(()=>mount.dispose())
  const result=await tools.execute({name:'code_exec',args:{code:'text("begin"+"x".repeat(20000)+"中段錯誤"+"y".repeat(20000));',max_output_tokens:16}})
  const output=result.output as{text:string;textRetention:{contextRef:{id:string};complete:boolean}}
  expect(output.text.length).toBeLessThan(100)
  expect(output.textRetention.contextRef.id).toBeTruthy()
  expect(output.textRetention.complete).toBe(true)
  const hits=await service.search({sessionId:'s'},{query:'中段錯誤'})
  expect(hits.hits.some(hit=>hit.ref.id===output.textRetention.contextRef.id)).toBe(true)
})

it('captures full real shell stdout and stderr before shell preview loss',async()=>{
  const {service}=await setup()
  const base=resolve('build/native-shell-tests');await mkdir(base,{recursive:true})
  const workspace=await mkdtemp(join(base,'shell-'));cleanup.push(()=>rm(workspace,{recursive:true,force:true}))
  const assembly=await createSessionAssembly({workspace,sessionId:'s',modelPolicy:'test-mock',sandbox:'danger-full-access',approveAll:true,contextOutput:service,shellRetention:{maxBytes:1024}})
  cleanup.push(()=>assembly.dispose())
  const result=await assembly.tools.execute({name:resolveShell().name,args:{command:`node -e "process.stdout.write('a'.repeat(40000)+'MIDDLE_STDOUT'+'b'.repeat(40000));process.stderr.write('c'.repeat(40000)+'MIDDLE_STDERR'+'d'.repeat(40000));process.exitCode=7"`}})
  expect(result.output).toMatchObject({exitCode:7,contextRef:{complete:true}})
  expect((await service.search({sessionId:'s'},{query:'MIDDLE_STDOUT'})).hits).toHaveLength(1)
  expect((await service.search({sessionId:'s'},{query:'MIDDLE_STDERR'})).hits).toHaveLength(1)
},15000)

it('reads registered actual exec spill bytes but never follows forged returned paths',async()=>{
  const{service,ctx,tools}=await setup()
  const base=resolve('build/native-producer-tests');await mkdir(base,{recursive:true})
  const root=await mkdtemp(join(base,'spill-'));cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const exec=registerExec(ctx,{spill:{maxOutputBytes:1024,maxSpillBytes:1024*1024,spillRoot:root}})
  for(const tool of createShellTools({exec,retention:{maxBytes:1024}}))tools.register(tool)
  const prepared=await tools.prepare({name:resolveShell().name,args:{command:`node -e "process.stdout.write('a'.repeat(40000)+'SPILL_MIDDLE_OUT'+'b'.repeat(40000));process.stderr.write('c'.repeat(40000)+'SPILL_MIDDLE_ERR'+'d'.repeat(40000))"`}},undefined,{sessionId:'s',callId:'spill'})
  const result=await tools.dispatch(prepared) as {contextRef:{complete:boolean}}
  expect(result.contextRef.complete).toBe(true)
  for(const query of ['SPILL_MIDDLE_OUT','SPILL_MIDDLE_ERR'])expect((await service.search({sessionId:'s'},{query})).hits).toHaveLength(1)
  await writeFile(join(root,'secret'),'FORGED_PATH_SECRET')
  tools.register({name:'forged',description:'fixture',inputSchema:{type:'object'},execute:async()=>({output:'x'.repeat(20000),outputPaths:[join(root,'secret')],stdoutSpillPath:join(root,'secret'),truncated:true})})
  const forged=await tools.dispatch(await tools.prepare({name:'forged',args:{}},undefined,{sessionId:'s',callId:'forged'})) as {contextRef:{complete:boolean}}
  expect(forged.contextRef.complete).toBe(false)
  expect((await service.search({sessionId:'s'},{query:'FORGED_PATH_SECRET'})).hits).toEqual([])
})

it.each(['disable','clear','close'] as const)('%s drains a trusted native producer and fences its late result',async control=>{
  const{service,tools}=await setup()
  let release!:()=>void,aborted=false,entered=false
  const held=new Promise<void>(resolve=>{release=resolve})
  const output={stdout:'x'.repeat(20000),truncated:true}
  registerRetainedOutput(output,async({signal,maxBytes})=>{expect(maxBytes).toBe(service.status().config.maxCaptureBytes);entered=true;signal.addEventListener('abort',()=>{aborted=true});await held;return{text:'LATE_RESULT',complete:true}})
  tools.register({name:'held',description:'held',inputSchema:{type:'object'},execute:async()=>output})
  const running=tools.dispatch(await tools.prepare({name:'held',args:{}},undefined,{sessionId:'s',callId:'held'}))
  const rejected=expect(running).rejects.toThrow()
  await vi.waitFor(()=>expect(entered).toBe(true))
  let drained=false
  const transition=(control==='disable'?service.configure({enabled:false}):control==='clear'?service.clear():service.close()).then(()=>{drained=true})
  await vi.waitFor(()=>expect(aborted).toBe(true));expect(drained).toBe(false)
  release();await Promise.all([transition,rejected]);expect(service.status().activeJobs).toBe(0);expect(service.status().results).toBe(0)
})

it('human Stop aborts and drains the actual native Code Mode retention callback',async()=>{
  const{service,ctx,tools,session}=await setup()
  const capture=service.capture.bind(service)
  let entered=false,aborted=false,release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  service.capture=(input,signal)=>capture(input,signal,async({signal:owned})=>{entered=true;owned.addEventListener('abort',()=>{aborted=true});await held;return{text:input.text,complete:true}})
  const mount=registerCodeMode(ctx,tools,{session,sessionId:'s',config:{mode:'only'},retainText:createNativeCodeTextRetention({service,session,sessionId:'s'})});cleanup.push(()=>mount.dispose())
  const running=tools.execute({name:'code_exec',args:{code:'text("x".repeat(20000));await yield_control();await new Promise(()=>{});text("AFTER_STOP");',yield_time_ms:1000,max_output_tokens:16}})
  await vi.waitFor(()=>expect(entered).toBe(true))
  const cell=session.events.find(event=>event.type==='code/cell')!
  expect(cell.type).toBe('code/cell')
  let stopped=false
  const stopping=mount.terminateCell!(cell.type==='code/cell'?cell.cellId:'').then(()=>{stopped=true})
  try {await vi.waitFor(()=>expect(aborted).toBe(true));expect(stopped).toBe(false)}finally{release()}
  await stopping;await running
  expect(service.status().results).toBe(0)
  expect(session.events.some(event=>event.type==='context/result-ref')).toBe(false)
  expect(JSON.stringify(session.events)).not.toContain('"text":"AFTER_STOP"')
})

it('preserves typed failures and supported images while bounding escaped textual envelopes',async()=>{
  const{service,tools}=await setup()
  const images=[{mediaType:'image/png',dataBase64:'AQID'}]
  tools.register({name:'media_failure',description:'fixture',inputSchema:{type:'object'},execute:async()=>({error:'broken',code:'FAILED',exitCode:23,isError:true,images,text:'"\\\n😀'.repeat(9000)})})
  const output=await tools.dispatch(await tools.prepare({name:'media_failure',args:{}},undefined,{sessionId:'s',callId:'media'})) as {images:unknown[];contextRef:{id:string}}
  expect(output).toMatchObject({error:'broken',code:'FAILED',exitCode:23,isError:true,images})
  const {images:media,...textual}=output
  expect(Buffer.byteLength(JSON.stringify(textual))).toBeLessThanOrEqual(service.status().config.maxPreviewBytes)
  expect((await service.read({sessionId:'s'},{refId:output.contextRef.id})).text).not.toContain('AQID')
})
