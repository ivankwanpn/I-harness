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
import { installNativeContextOutput } from '../src/context-output.ts'
import { createCodeTextRetention } from '../src/lifecycle/code-text-retention.ts'
import type { CodeModeTextRetention } from '@i-harness/code-mode'
import type { ManagedArtifactRef, ResultDependencyCatalog, ExecFrameCursor } from '@i-harness/core-session'
import { controlledModel } from './controlled-model.ts'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { acquireAssemblyResultStore } from '../src/lifecycle/result-store.ts'

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
async function readRetainedText(service:ReturnType<typeof createContextOutputService>,sessionId:string,ref:ManagedArtifactRef){
  let offset=0,encoded=''
  for(;;){
    const page=await service.readResult({sessionId},{ref,offset})
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
    if(page.data.kind!=='text')throw new Error('Expected a text page')
    encoded+=page.data.text
    if(page.eof)break
    offset=page.nextOffset!
  }
  return JSON.parse(encoded) as string
}

it('retains complete emitted Code Mode text behind the bounded observation',async()=>{
  const{service,tools,ctx,session}=await setup()
  const mount=registerCodeMode(ctx,tools,{session,sessionId:'s',config:{mode:'only'},retainText:createCodeTextRetention({service,sessionId:'s'})});cleanup.push(()=>mount.dispose())
  const result=await tools.execute({name:'code_exec',args:{code:'text("begin"+"x".repeat(20000)+"中段錯誤"+"y".repeat(20000));',max_output_tokens:16}})
  const output=result.output as{text:string;textRetention:CodeModeTextRetention}
  expect(output.text.length).toBeLessThan(100)
  const envelope=output.textRetention.envelope!
  expect(envelope.retention).toMatchObject({kind:'artifact',ref:{codec:'json-utf8-v1',completeness:'complete'}})
  expect(output.textRetention.complete).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(output.textRetention))).toBeLessThanOrEqual(64_000)
  expect(envelope.preview).toBe('')
  const ref=envelope.retention.kind==='artifact'?envelope.retention.ref:undefined
  expect(await readRetainedText(service,'s',ref!)).toBe('begin'+'x'.repeat(20000)+'中段錯誤'+'y'.repeat(20000))
  expect(session.events.some(event=>event.type==='context/result-ref')).toBe(false)
})

it('captures full real shell stdout and stderr before shell preview loss',async()=>{
  const base=resolve('build/native-shell-tests');await mkdir(base,{recursive:true})
  const workspace=await mkdtemp(join(base,'shell-'));cleanup.push(()=>rm(workspace,{recursive:true,force:true}))
  const coordinator=createSessionCoordinator(createJsonlBackend(join(workspace,'sessions')),{lock:{enabled:true}})
  cleanup.push(()=>coordinator.close());await coordinator.create({sessionId:'s'})
  const settings=join(workspace,'settings.json');await writeFile(settings,JSON.stringify({contextSubsystems:{contextOutput:{enabled:true}}}))
  const lease=await acquireAssemblyResultStore({workspace,coordinator,sessionId:'s',contextOutputSettingsPath:settings})
  cleanup.push(()=>lease.release())
  const service=lease.service;if(!service)throw new Error('Actual automatic result store unavailable')
  const command=`node -e "process.stdout.write('a'.repeat(40000)+'MIDDLE_STDOUT'+'b'.repeat(40000));process.stderr.write('c'.repeat(40000)+'MIDDLE_STDERR'+'d'.repeat(40000));process.exitCode=7"`
  let modelCalls=0
  const assembly=await createSessionAssembly({workspace,coordinator,sessionId:'s',modelPolicy:'test-mock',sandbox:'danger-full-access',approveAll:true,contextOutput:service,contextOutputSourceFor:lease.sourceFor,contextOutputLegacyReadObservation:lease.withLegacyReadObservation,shellRetention:{maxBytes:1024},
    model:controlledModel(async function*(){
      if(++modelCalls===1)yield{type:'tool_call',call:{id:'actual-shell',name:resolveShell().name,args:{command}}}
      else yield{type:'text/chunk',text:'captured'}
      yield{type:'end'}
    })})
  cleanup.push(()=>assembly.dispose())
  const native=assembly.ctx.services.get<import('@i-harness/exec').ExecService>('exec/service')!
  const launches=vi.spyOn(native,'run')
  await assembly.agent.run('capture actual shell output once')
  expect(modelCalls).toBe(2);expect(launches).toHaveBeenCalledTimes(1)
  const result=assembly.session.events.find(event=>event.type==='tool/result'&&event.callId==='actual-shell')
  if(result?.type!=='tool/result'||!result.envelope)throw new Error('Actual shell result envelope missing')
  if(result.envelope.retention.kind!=='inline')throw new Error('Actual bounded shell result observation unavailable')
  expect(result.envelope.retention.value).toMatchObject({exitCode:7})
  // The shipping assembly retains native frames through actual managed
  // dependency membership; BASE already disables its legacy capture cascade.
  const dependencies=result.envelope?.dependencies
  expect(dependencies).toMatchObject({kind:'artifact-set',count:1})
  if(dependencies?.kind!=='artifact-set')throw new Error('Actual native dependency catalog unavailable')
  let offset=0,encoded=''
  for(;;){
    const page=await service.readResult({sessionId:'s'},{ref:dependencies.ref,offset,maxBytes:4096})
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
    if(page.data.kind!=='text')throw new Error('Actual catalog is not JSON text')
    encoded+=page.data.text
    if(page.eof)break
    offset=page.nextOffset!
  }
  const catalog=JSON.parse(encoded) as ResultDependencyCatalog
  expect(catalog).toMatchObject({version:1,kind:'result-dependencies'})
  expect(catalog.entries).toHaveLength(dependencies.count)
  const member=catalog.entries[0]!
  if(member.retention.kind!=='artifact')throw new Error('Actual native member unavailable')
  expect(member.retention.ref).toMatchObject({codec:'exec-frames-v1',completeness:'complete'})
  const chunks:{stdout:Buffer[];stderr:Buffer[]}={stdout:[],stderr:[]},bytes={stdout:0,stderr:0}
  const frameBytes=new Map<string,number>()
  let cursor:ExecFrameCursor|undefined
  for(;;){
    const page=await service.readExecResult({sessionId:'s'},{ref:member.retention.ref,viaCatalog:dependencies.ref,...(cursor?{cursor}:{}),maxBytes:4096})
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
    for(const frame of page.frames){
      const key=frame.channel+':'+frame.frame
      expect(frame.offset).toBe(frameBytes.get(key)??0)
      const value=Buffer.from(frame.data,'base64');chunks[frame.channel].push(value);bytes[frame.channel]+=value.length
      frameBytes.set(key,(frameBytes.get(key)??0)+value.length)
    }
    if(page.eof)break
    if(!page.nextCursor)throw new Error('Actual native member cursor missing')
    cursor=page.nextCursor
  }
  expect(bytes).toEqual({stdout:80013,stderr:80013})
  expect(Buffer.concat(chunks.stdout).toString()).toBe('a'.repeat(40000)+'MIDDLE_STDOUT'+'b'.repeat(40000))
  expect(Buffer.concat(chunks.stderr).toString()).toBe('c'.repeat(40000)+'MIDDLE_STDERR'+'d'.repeat(40000))
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

it('human Stop joins already accepted emitted text and preserves its original saved output',async()=>{
  const{service,ctx,tools,session}=await setup()
  const actual=createCodeTextRetention({service,sessionId:'s'})
  let entered=false,release!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve})
  const mount=registerCodeMode(ctx,tools,{session,sessionId:'s',config:{mode:'only'},retainText:async input=>{
    entered=true
    await held
    return actual(input)
  }});cleanup.push(()=>mount.dispose())
  const running=tools.execute({name:'code_exec',args:{code:'text("x".repeat(20000));await yield_control();await new Promise(()=>{});text("AFTER_STOP");',yield_time_ms:1000,max_output_tokens:16}})
  await vi.waitFor(()=>expect(entered).toBe(true))
  const cell=session.events.find(event=>event.type==='code/cell')!
  expect(cell.type).toBe('code/cell')
  let stopped=false
  const stopping=mount.terminateCell!(cell.type==='code/cell'?cell.cellId:'').then(()=>{stopped=true})
  try {await new Promise<void>(done=>setImmediate(done));expect(stopped).toBe(false)}finally{release()}
  await stopping
  const first=await running
  const initial=first.output as{status:string;cell_id:string}
  const result=initial.status==='running'?await tools.execute({name:'code_wait',args:{cell_id:initial.cell_id}}):first
  const output=result.output as{status:string;textRetention:CodeModeTextRetention}
  expect(output.status).toBe('terminated')
  expect(output.textRetention).toMatchObject({stored:true,complete:true})
  const ref=output.textRetention.envelope?.retention.kind==='artifact'?output.textRetention.envelope.retention.ref:undefined
  expect(ref).toBeDefined()
  const page=await service.readResult({sessionId:'s'},{ref:ref!})
  expect(page.data.kind).toBe('text')
  expect(service.status().results).toBe(0)
  expect(session.events.some(event=>event.type==='context/result-ref')).toBe(false)
  expect(JSON.stringify(session.events)).not.toContain('"text":"AFTER_STOP"')
  expect(session.events.filter(event=>event.type==='code/output'||event.type==='code/cell').map(event=>event.type==='code/cell'?event.state:event.type)).toEqual(['started','code/output','terminated'])
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
