import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { HarnessClient, SdkTimeoutError } from '@i-harness/sdk'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionAssembly } from '@i-harness/session-executor'
import { acquireResultReadStore } from '../../../packages/session-executor/src/lifecycle/result-store.ts'
import { controlledModel } from '../../../packages/session-executor/test/controlled-model.ts'
import type { ExecService } from '@i-harness/exec'
import type { ManagedArtifactRef, ExecFrameCursor, ResultDependencyCatalog, SessionEvent } from '@i-harness/core-session'

const repo=resolve(fileURLToPath(new URL('../../../',import.meta.url)))
const loader=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href,entry=join(repo,'apps/cli/src/index.ts')
it('actual stdio prepares, forks, nests and cold retries one original operation without assembling sessions',async()=>{
  const base=process.env.IH_LEGACY_FORK_EVIDENCE_ROOT??tmpdir();await mkdir(base,{recursive:true})
  const root=await mkdtemp(join(base,'cli-fork-')),workspace=join(root,'w'),sessions=join(root,'s'),config=join(root,'c')
  await mkdir(workspace);await mkdir(config);await writeFile(join(config,'settings.json'),JSON.stringify({contextSubsystems:{contextOutput:{enabled:true}}}))
  const original=createSessionCoordinator(createJsonlBackend(sessions),{lock:{enabled:true}})
  await original.create({sessionId:'source',title:'original title'});await original.append('source',[{type:'turn/start'},{type:'user/message',text:'actual wire source'},{type:'turn/end'}]);await original.close()
  const sourceBefore=await readFile(join(sessions,'source.jsonl')),receipts:unknown[]=[]
  let ordinal=0
  function start(){
    const label=++ordinal,child=spawn(process.execPath,['--import',loader,entry,'sdk','--session-dir',sessions],{cwd:workspace,env:{...process.env,IH_CONFIG_DIR:config},windowsHide:true,stdio:'pipe'})
    const exiting=once(child,'exit');let stderr='';child.stderr.on('data',chunk=>{stderr+=String(chunk)})
    const client=new HarnessClient(child.stdout,child.stdin,{child})
    return{client,async close(){await client.close();const[code,signal]=await exiting;await writeFile(join(root,`stderr-${label}.log`),stderr);receipts.push({label,code,signal,stderrFile:`stderr-${label}.log`});return{code,signal}}}
  }
  let processOwner:ReturnType<typeof start>|undefined=start()
  try{
    let client=processOwner.client
    const info=await client.initialize();expect(info.capabilities['session-fork-bootstrap']).toEqual(['1']);expect(info.capabilities['session-fork']).toBeUndefined()
    const prepared=await client.prepareForkSession({version:1,sourceSessionId:'source'})
    if(prepared.kind!=='prepared')throw new Error('Actual stdio prepare unavailable')
    const attempt=client.createForkAttempt(prepared.prepared),one=attempt.run(),two=attempt.run()
    expect(one).toBe(two)
    const child=await one;if(child.kind!=='ready')throw new Error('Actual stdio fork not ready')
    const nested=await client.forkSession(child.sessionId)
    expect((await client.dashboard()).sessions.every(row=>row.live===false)).toBe(true)
    expect(await processOwner.close()).toEqual({code:0,signal:null});processOwner=undefined
    expect(await readFile(join(sessions,'source.jsonl'))).toEqual(sourceBefore)
    const offline=createSessionCoordinator(createJsonlBackend(sessions),{lock:{enabled:true}})
    await offline.updateMeta('source',{archived:true});await offline.updateMeta(child.sessionId,{archived:true});await offline.close()
    processOwner=start();client=processOwner.client;await client.initialize()
    const adopted=await client.retryForkSession(JSON.parse(JSON.stringify(nested.operation)))
    expect(adopted).toMatchObject({kind:'adopted',sessionId:nested.sessionId,operation:nested.operation})
    expect((await client.dashboard()).sessions.every(row=>row.live===false)).toBe(true)
    expect(await processOwner.close()).toEqual({code:0,signal:null});processOwner=undefined
    const backend=createJsonlBackend(sessions),target=await backend.read(nested.sessionId)
    expect(target.events.filter(event=>event.type==='session/bootstrap')).toHaveLength(1)
    expect((await backend.list()).sort()).toEqual(['source',child.sessionId,nested.sessionId].sort())
    receipts.push({operation:nested.operation,targets:2,sourceBytesUnchangedBeforeExplicitArchive:true,liveAssemblies:0})
  }finally{
    await processOwner?.close();await writeFile(join(root,'stdio-receipts.json'),JSON.stringify(receipts,null,2));console.info(JSON.stringify({control:'actual CLI public fork wire',evidence:root}))
    if(!process.env.IH_LEGACY_FORK_EVIDENCE_ROOT)await rm(root,{recursive:true,force:true})
  }
},30000)

// Three SDK processes, two actual forks and cold reads; measured full workload 76.24s.
it('actual stdio retains a genuine catalog/member and selected legacy results through nested cold recovery',async()=>{
  const started=Date.now()
  const base=process.env.IH_LEGACY_FORK_EVIDENCE_ROOT??tmpdir();await mkdir(base,{recursive:true})
  const root=await mkdtemp(join(base,'cli-retained-')),workspace=join(root,'w'),sessions=join(root,'s'),config=join(root,'c'),settings=join(config,'settings.json'),effects=join(workspace,'native-effects')
  await mkdir(workspace);await mkdir(config);await writeFile(settings,JSON.stringify({contextSubsystems:{contextOutput:{enabled:true}}}))
  const original=createSessionCoordinator(createJsonlBackend(sessions),{lock:{enabled:true}})
  await original.create({sessionId:'source',title:'retained source'});await original.create({sessionId:'foreign'})
  const lease=await acquireResultReadStore({workspace,coordinator:original,sessionId:'source',contextOutputSettingsPath:settings,readCallerAvailable:()=>true}),owner=lease.service!
  const descriptor=await lease.sourceFor!('source')
  const visible=await owner.capture({sessionId:'source',callId:'managed-call',label:'visible',text:'VISIBLE legacy wire',complete:true,source:descriptor})
  const hidden=await owner.capture({sessionId:'source',callId:'managed-call',label:'hidden',text:'HIDDEN-ONLY-SECRET-BODY',complete:true,source:descriptor})
  const future=await owner.capture({sessionId:'source',callId:'future-call',label:'future',text:'FUTURE-ONLY-SECRET-BODY',complete:true,source:descriptor})
  const foreignLease=await acquireResultReadStore({workspace,coordinator:original,sessionId:'foreign',contextOutputSettingsPath:settings,readCallerAvailable:()=>true})
  const foreign=await owner.capture({sessionId:'foreign',callId:'foreign-call',label:'foreign',text:'FOREIGN-ONLY-SECRET-BODY',complete:true,source:await foreignLease.sourceFor!('foreign')});await foreignLease.release()
  if(!visible||!hidden||!future||!foreign)throw new Error('Actual legacy publications unavailable')
  const managedScope=owner.registerResultScope({operationId:'original-managed-text',sessionId:'source',callId:'managed-call',source:descriptor},()=>true)
  const sink=await owner.beginResult(managedScope,'text-utf8-v1');await sink.write(Buffer.from('VISIBLE managed wire'));const managed=await sink.finish('complete')
  if(managed.kind!=='committed')throw new Error('Actual managed text unavailable')
  await original.append('source',[{type:'turn/start'},{type:'user/message',text:'retain managed and legacy'},{type:'step/start'},{type:'tool/call',callId:'managed-call',name:'read',args:{}},
    {type:'assistant/message',text:''},{type:'tool/dispatch',callId:'managed-call',eventSeq:3},{type:'tool/result',callId:'managed-call',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'managed retained',media:[],retention:{kind:'artifact',ref:managed.ref}}},
    {type:'context/result-ref',ref:hidden},{type:'step/end'},{type:'compaction/summary',text:'retained output state',shadowedSeqs:[7]},{type:'turn/end'},{type:'context/result-ref',ref:visible}])
  let sourceModels=0,nativeLaunches=0
  const nativeLine='original-native'+String.fromCharCode(10)
  let assembly:Awaited<ReturnType<typeof createSessionAssembly>>
  assembly=await createSessionAssembly({workspace,coordinator:original,sessionId:'source',contextOutput:owner,contextOutputSourceFor:lease.sourceFor,contextOutputLegacyReadObservation:lease.withLegacyReadObservation,
    modelPolicy:'test-mock',sandbox:'danger-full-access',approveAll:true,codeMode:{mode:'off'},model:controlledModel(async function*(){
      if(++sourceModels===1)yield{type:'tool_call',call:{id:'native-call',name:'native_wire',args:{}}};else yield{type:'text/chunk',text:'native stored'};yield{type:'end'}
    }),additionalTools:[{name:'native_wire',description:'actual original native fixture',inputSchema:{type:'object'},async execute(){nativeLaunches++;const value=await assembly.ctx.services.get<ExecService>('exec/service')!.run({argv:[process.execPath,'-e',`require('fs').appendFileSync(${JSON.stringify(effects)},${JSON.stringify(nativeLine)});process.stdout.write('VISIBLE native member wire');process.stderr.write('native wire stderr')`]});return{exitCode:value.exitCode}}}]})
  await assembly.agent.run('publish actual native result once')
  const nativeResult=assembly.session.events.find(event=>event.type==='tool/result'&&event.callId==='native-call')
  if(nativeResult?.type!=='tool/result'||nativeResult.envelope?.dependencies?.kind!=='artifact-set')throw new Error('Genuine native catalog missing')
  const catalogRef=nativeResult.envelope.dependencies.ref,atSeq=assembly.session.events.findLast(event=>event.type==='turn/end')!.seq!
  let catalogBytes='',catalogOffset=0
  for(;;){const page=await owner.readResult({sessionId:'source'},{ref:catalogRef,offset:catalogOffset,maxBytes:4096});if(page.data.kind!=='text')throw new Error('Actual original catalog not text');catalogBytes+=page.data.text;if(page.eof)break;catalogOffset=page.nextOffset!}
  const catalog=JSON.parse(catalogBytes)as ResultDependencyCatalog,member=catalog.entries[0]
  if(catalog.entries.length!==1||member?.retention.kind!=='artifact')throw new Error('Genuine native catalog membership missing')
  const memberRef=member.retention.ref
  const sourceDocument=await original.openManagedDocument('source')
  await sourceDocument.inputs.start(undefined,{type:'user/message',text:'beyond explicit selected boundary'})
  const action=sourceDocument.beginAction(),settlement=action.registerSettlementSource(async()=>{})
  const futureFact=await settlement.retention.capture({type:'context/result-ref',ref:future}).admit();if(futureFact.kind!=='committed')throw new Error('Actual future ref fact unavailable')
  await settlement.close();action.finish();await sourceDocument.agent.lifecycle({type:'turn/end'})
  await assembly.dispose();await lease.release();await original.close()
  expect(sourceModels).toBe(2);expect(nativeLaunches).toBe(1)
  const sourceBefore=await readFile(join(sessions,'source.jsonl')),requests:string[]=[],receipts:unknown[]=[]
  const phaseMark=(phase:string)=>{receipts.push({phase,elapsedMs:Date.now()-started})}
  phaseMark('source-closed')
  let script=0,ordinal=0,phase='disabled'
  const plan=[{id:'read-visible',name:'context_output_read',args:{refId:visible.id}},{id:'search-visible',name:'context_output_search',args:{query:'VISIBLE'}},
    {id:'read-hidden',name:'context_output_read',args:{refId:hidden.id}},{id:'read-future',name:'context_output_read',args:{refId:future.id}},{id:'read-foreign',name:'context_output_read',args:{refId:foreign.id}},{id:'status',name:'context_output_status',args:{}}]
  const model=createServer((req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404).end();return}
    let body='';req.on('data',chunk=>{body+=String(chunk)});req.on('end',()=>{
      requests.push(body);const call=(phase==='disabled'?plan.slice(0,1):plan)[script++],delta=call?{tool_calls:[{index:0,id:phase+'-'+call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]}:{content:'legacy reads finished'}
      res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:call?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
    })
  })
  model.listen(0,'127.0.0.1');await once(model,'listening');const address=model.address();if(!address||typeof address==='string')throw new Error('Actual fixture model address unavailable')
  const modelSettings={codeMode:{mode:'off'},contextSubsystems:{contextOutput:{enabled:false}},llm:{providers:{fixture:{protocol:'openai-completions',baseURL:`http://127.0.0.1:${address.port}`,apiKeyEnv:'FIXTURE_KEY',models:[{id:'fixture-model'}]}},defaultModel:{provider:'fixture',model:'fixture-model'}}}
  await writeFile(settings,JSON.stringify(modelSettings))
  await writeFile(join(config,'credentials.json'),JSON.stringify({refs:{FIXTURE_KEY:'fixture-key'}}))
  function start(dropReady=false){
    const label=++ordinal,child=spawn(process.execPath,['--import',loader,entry,'sdk','--session-dir',sessions],{cwd:workspace,env:{...process.env,IH_CONFIG_DIR:config},windowsHide:true,stdio:'pipe'}),exiting=once(child,'exit'),dropped=Promise.withResolvers<void>(),decoder=new StringDecoder('utf8')
    let stderr='',buffer='',drops=0
    child.stderr.on('data',chunk=>{stderr+=String(chunk)})
    const filtered=new Transform({transform(chunk,_encoding,done){buffer+=decoder.write(chunk);for(;;){const newline=buffer.indexOf('\n');if(newline<0)break;const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let message:any;try{message=JSON.parse(line)}catch{}if(dropReady&&drops===0&&message?.result?.kind==='ready'){drops++;receipts.push({phase:'dropped actual post-READY reply',operation:message.result.operation,sessionId:message.result.sessionId});dropped.resolve();continue}this.push(line+'\n')}done()},flush(done){buffer+=decoder.end();if(buffer)this.push(buffer);done()}})
    child.stdout.pipe(filtered)
    const client=new HarnessClient(filtered,child.stdin,{child}),request=client.request.bind(client)
    client.request=(method,params,timeout)=>{
      if(!dropReady||drops!==0||method!=='session/fork/begin')return request(method,params,timeout)
      // Lose the caller's reply only AFTER the real server publishes READY.
      // A slow preparation or an actual refusal must not impersonate this cut.
      return Promise.race([request(method,params,0),dropped.promise.then(()=>{throw new SdkTimeoutError(method,250)})])
    }
    return{client,dropped:dropped.promise,async close(){await client.close();const[code,signal]=await exiting;await writeFile(join(root,`stderr-${label}.log`),stderr);receipts.push({label,code,signal,drops});expect({code,signal}).toEqual({code:0,signal:null})}}
  }
  async function textPage(client:HarnessClient,id:string,ref:ManagedArtifactRef){let offset=0,text='';for(;;){const page=await client.readResultPage(id,{ref,offset,maxBytes:4096});if('kind'in page||!('data'in page)||page.data.kind!=='text')throw new Error('Actual stdio retained text unavailable');expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);text+=page.data.text;if(page.eof)return text;offset=page.nextOffset!}}
  function toolValue(events:SessionEvent[],id:string){const result=events.find(event=>event.type==='tool/result'&&event.callId===id);if(result?.type!=='tool/result'||!result.envelope)throw new Error('Actual legacy tool result missing');return result.envelope}
  let processOwner:ReturnType<typeof start>|undefined=start(true)
  try{
    let client=processOwner.client;await client.initialize()
    const prepared=await client.prepareForkSession({version:1,sourceSessionId:'source',selection:{kind:'completed',atSeq}});if(prepared.kind!=='prepared')throw new Error('Actual retained prepare unavailable')
    const attempt=client.createForkAttempt(prepared.prepared);receipts.push({phase:'operation saved before begin',operation:attempt.operation})
    const lost=await attempt.run().catch(error=>error);expect(lost).toMatchObject({name:'ForkOperationError',kind:'transport'});expect(lost.operation).toBe(attempt.operation);expect(attempt.lastOutcome).toBeUndefined()
    await processOwner.dropped;phaseMark('actual-ready-dropped')
    const child=await attempt.run();if(child.kind!=='adopted')throw new Error('Actual retained child not adopted after dropped READY')
    const grandchild=await client.forkSession(child.sessionId)
    phaseMark('nested-ready')
    expect(requests).toHaveLength(0);expect((await client.dashboard()).sessions.every(row=>!row.live)).toBe(true)
    script=0;phase='disabled';const disabledRead=await client.run({sessionId:grandchild.sessionId,prompt:'probe disabled retained read'})
    expect(toolValue(disabledRead.events,'disabled-read-visible').execution.outcome).toBe('failed')
    expect(JSON.stringify(toolValue(disabledRead.events,'disabled-read-visible').retention)).toContain('disabled')
    const beforeDisabledRetry=requests.length,liveBeforeDisabledRetry=(await client.dashboard()).sessions.filter(row=>row.live).length
    expect((await client.retryForkSession(grandchild.operation)).kind).toBe('adopted');expect(requests.length).toBe(beforeDisabledRetry)
    expect((await client.dashboard()).sessions.filter(row=>row.live).length).toBe(liveBeforeDisabledRetry)
    receipts.push({phase:'disabled transfer/read-denial/passive',modelRequestsDuringFork:0,assembliesDuringFork:0,modelRequestsDuringPassive:0,newAssembliesDuringPassive:0,disabledReadDenied:true})
    await processOwner.close();processOwner=undefined;phaseMark('disabled-closed')
    // Existing service semantics disable reads too. Prove disabled transfer
    // first, then explicitly enable this isolated saved feature for reads.
    modelSettings.contextSubsystems.contextOutput.enabled=true;await writeFile(settings,JSON.stringify(modelSettings))
    processOwner=start();client=processOwner.client;await client.initialize()
    script=0;phase='enabled';const firstReads=await client.run({sessionId:grandchild.sessionId,prompt:'read retained observations'})
    expect(toolValue(firstReads.events,'enabled-read-visible').retention).toMatchObject({kind:'inline',value:{text:'VISIBLE legacy wire'}})
    expect(toolValue(firstReads.events,'enabled-search-visible').retention).toMatchObject({kind:'inline',value:{hits:[{ref:{id:visible.id}}]}})
    for(const id of ['read-hidden','read-future','read-foreign'])expect(toolValue(firstReads.events,'enabled-'+id).execution.outcome).toBe('failed')
    expect(toolValue(firstReads.events,'enabled-status').retention).toMatchObject({kind:'inline',value:{results:4}})
    await processOwner.close();processOwner=undefined;phaseMark('enabled-closed');expect(await readFile(join(sessions,'source.jsonl'))).toEqual(sourceBefore)
    const offline=createSessionCoordinator(createJsonlBackend(sessions),{lock:{enabled:true}}),coldLease=await acquireResultReadStore({workspace,coordinator:offline,sessionId:grandchild.sessionId,contextOutputSettingsPath:settings,readCallerAvailable:()=>true})
    await coldLease.service!.clear('source');await coldLease.service!.clear(child.sessionId);await coldLease.release()
    await offline.updateMeta('source',{archived:true});await offline.updateMeta(child.sessionId,{archived:true});await offline.close();phaseMark('sources-cleared-archived')
    processOwner=start();client=processOwner.client;await client.initialize();const beforeCold=requests.length
    expect(await textPage(client,grandchild.sessionId,managed.ref)).toBe('VISIBLE managed wire')
    expect(JSON.parse(await textPage(client,grandchild.sessionId,catalogRef))).toEqual(catalog)
    let cursor:ExecFrameCursor|undefined,stdout='',stderr=''
    for(;;){const page=await client.readResultPage(grandchild.sessionId,{ref:memberRef,viaCatalog:catalogRef,...(cursor?{cursor}:{}),maxBytes:4096});if('kind'in page||!('frames'in page))throw new Error('Actual inherited native member unavailable');expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);for(const frame of page.frames){const value=Buffer.from(frame.data,'base64').toString();if(frame.channel==='stdout')stdout+=value;else stderr+=value}if(page.eof)break;cursor=page.nextCursor!}
    expect(stdout).toBe('VISIBLE native member wire');expect(stderr).toBe('native wire stderr');expect(requests.length).toBe(beforeCold)
    phaseMark('cold-pages-read')
    script=0;phase='cold';const coldReads=await client.run({sessionId:grandchild.sessionId,prompt:'cold read retained observations'})
    expect(toolValue(coldReads.events,'cold-read-visible').retention).toMatchObject({kind:'inline',value:{text:'VISIBLE legacy wire'}})
    expect(toolValue(coldReads.events,'cold-search-visible').retention).toMatchObject({kind:'inline',value:{hits:[{ref:{id:visible.id}}]}})
    for(const id of ['read-hidden','read-future','read-foreign'])expect(toolValue(coldReads.events,'cold-'+id).execution.outcome).toBe('failed')
    phaseMark('cold-tools-read')
    expect(toolValue(coldReads.events,'cold-status').retention).toMatchObject({kind:'inline',value:{results:2}})
    const beforeRetry=requests.length;expect((await client.retryForkSession(grandchild.operation)).kind).toBe('adopted');expect(requests.length).toBe(beforeRetry)
    expect(await readFile(effects,'utf8')).toBe(nativeLine)
    expect(requests.every(body=>!['HIDDEN-ONLY-SECRET-BODY','FUTURE-ONLY-SECRET-BODY','FOREIGN-ONLY-SECRET-BODY'].some(secret=>body.includes(secret)))).toBe(true)
    receipts.push({operation:grandchild.operation,sourceModels,nativeLaunches,modelRequestsDuringFork:0,originalCatalog:catalog,legacy:visible,disabledNewCapture:true,coldAfterSourceClear:true})
  }finally{
    await processOwner?.close();await new Promise<void>((resolve,reject)=>{model.close(error=>error?reject(error):resolve());model.closeAllConnections()});await writeFile(join(root,'retained-receipts.json'),JSON.stringify(receipts,null,2));console.info(JSON.stringify({control:'actual CLI nested managed catalog member and legacy',evidence:root}));if(!process.env.IH_LEGACY_FORK_EVIDENCE_ROOT)await rm(root,{recursive:true,force:true})
  }
},90000)
