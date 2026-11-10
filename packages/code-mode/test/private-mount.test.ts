import {expect,it,vi} from 'vitest'
const gate=vi.hoisted(()=>({enabled:false,target:'delivery' as 'delivery'|'codecall'|'handoff'|'handoff-unknown'|'writer'|'writer-unknown',unknownKey:undefined as string|undefined,blockReconcile:false,reconcileEntered:undefined as (()=>void)|undefined,waitObserved:undefined as (()=>void)|undefined,sourceMutation:undefined as (()=>void)|undefined,capturedExec:undefined as import('@i-harness/core-tools').ToolExec|undefined,records:undefined as ReturnType<typeof import('../../core-agent/src/tool-batch/record.ts').createBatchRecords>|undefined,onSynthetic:undefined as (()=>void)|undefined,resultWrites:0,resultUnknown:false,resultAllowed:true,resultKey:'',observeSynthetic:false,syntheticExecution:undefined as import('@i-harness/core-session').ResultExecution|undefined,worker:0,bodies:0,modelDispatch:0,entered:undefined as (()=>void)|undefined,wait:undefined as Promise<void>|undefined}))
const audit=vi.hoisted(()=>({bind:0,attach:0,modelAttach:0,instruction:0}))
vi.mock('../../core-agent/src/tool-batch/record.ts',async load=>{
 const actual=await load<typeof import('../../core-agent/src/tool-batch/record.ts')>()
 return {...actual,createBatchRecords(...args:Parameters<typeof actual.createBatchRecords>){
  const records=actual.createBatchRecords(...args),set=records.setSlot;
  if(gate.observeSynthetic)gate.records=records
  records.setSlot=(index,slot)=>{if(gate.observeSynthetic&&'synthetic'in slot){gate.syntheticExecution=slot.execution;gate.onSynthetic?.()}return Reflect.apply(set,records,[index,slot])}
  return records
 }}
})
vi.mock('../../core-tools/src/registry/prepared-body.ts',async load=>{const actual=await load<typeof import('../../core-tools/src/registry/prepared-body.ts')>();return {...actual,attachPreparedModelOrigin(...args:Parameters<typeof actual.attachPreparedModelOrigin>){audit.modelAttach++;return actual.attachPreparedModelOrigin(...args)}}})
vi.mock('../../core-tools/src/code-origin.ts',async load=>{const actual=await load<typeof import('../../core-tools/src/code-origin.ts')>();return {...actual,claimPreparedCodeInvocation(...args:Parameters<typeof actual.claimPreparedCodeInvocation>){const claim=actual.claimPreparedCodeInvocation(...args);if(claim)gate.capturedExec=args[1];if(!claim||!('kind'in claim.context)||!claim.retainPrivateCell)return claim;return {...claim,assertCurrent:claim.assertCurrent.bind(claim),consume:claim.consume.bind(claim),hasCodeSourceIssuer:claim.hasCodeSourceIssuer.bind(claim),takeCodeSourceIssuer:claim.takeCodeSourceIssuer.bind(claim),retainPrivateCell(){const original=claim.retainPrivateCell!();return {assertOpen(){return original.assertOpen()},certifyInstructionCall(...args:Parameters<import('@i-harness/core-tools/internal/code-origin').PrivateCodeCellDelegation['certifyInstructionCall']>){audit.instruction++;const [toolCapture,action,source,capture,outcome]=args;expect(()=>original.certifyInstructionCall({...toolCapture},action,source,capture,outcome)).toThrow();expect(()=>original.certifyInstructionCall(toolCapture,{...action} as typeof action,source,capture,outcome)).toThrow();expect(()=>original.certifyInstructionCall(toolCapture,action,{...source} as typeof source,capture,outcome)).toThrow();expect(()=>original.certifyInstructionCall(toolCapture,action,source,{...capture},outcome)).toThrow();expect(()=>original.certifyInstructionCall(toolCapture,action,source,capture,{...outcome})).toThrow();return original.certifyInstructionCall(...args)},bind(...[cellId,source,capture,outcome]:Parameters<import('@i-harness/core-tools/internal/code-origin').PrivateCodeCellDelegation['bind']>){audit.bind++;expect(()=>original.bind(cellId,{...source} as typeof source,capture,outcome)).toThrow();expect(()=>original.bind(cellId,source,{...capture} as object,outcome)).toThrow();expect(()=>original.bind(cellId,source,capture,{...outcome})).toThrow();expect(()=>original.bind('foreign-cell',source,capture,outcome)).toThrow();return original.bind(cellId,source,capture,outcome)},attach(...[prepared,action,source,capture,outcome]:Parameters<import('@i-harness/core-tools/internal/code-origin').PrivateCodeCellDelegation['attach']>){audit.attach++;expect(()=>original.attach({...prepared},action,source,capture,outcome)).toThrow();expect(()=>original.attach(prepared,{...action} as typeof action,source,capture,outcome)).toThrow();expect(()=>original.attach(prepared,action,{...source} as typeof source,capture,outcome)).toThrow();expect(()=>original.attach(prepared,action,source,{...capture} as object,outcome)).toThrow();expect(()=>original.attach(prepared,action,source,capture,{...outcome})).toThrow();original.attach(prepared,action,source,capture,outcome);expect(()=>original.attach(prepared,action,source,capture,outcome)).toThrow();return},revoke(){return original.revoke()}}}}}}})
vi.mock('@i-harness/core-session/internal/execution',async load=>{const actual=await load<typeof import('@i-harness/core-session/internal/execution')>();return {...actual,getManagedExecutionAdmissionWait(...args:Parameters<typeof actual.getManagedExecutionAdmissionWait>){const wait=actual.getManagedExecutionAdmissionWait(...args);if(wait&&gate.enabled&&(gate.target==='writer'||gate.target==='writer-unknown'))gate.waitObserved?.();return wait}}})
vi.mock('node:worker_threads',async load=>{const actual=await load<typeof import('node:worker_threads')>();return {...actual,Worker:class extends actual.Worker{constructor(...args:ConstructorParameters<typeof actual.Worker>){gate.worker++;super(...args)}}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const actual=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...actual,createFactJournalBackend(...args:Parameters<typeof actual.createFactJournalBackend>){const backend=actual.createFactJournalBackend(...args),append=backend.appendOwnedBatch,reconcile=backend.reconcileOwnedBatch;return {...backend,async appendOwnedBatch(...input:Parameters<typeof append>){const raw=Buffer.from(input[3].bytes).toString('utf8'),terminalResult=raw.includes('"type":"tool/result"')&&raw.includes('"callId":"code-call"');if(terminalResult)gate.resultWrites++;if(raw.includes('"type":"agent/delivery-source"')&&raw.includes('"kind":"code"')){const mutate=gate.sourceMutation;gate.sourceMutation=undefined;mutate?.()}if(raw.includes('"type":"tool/dispatch"')&&raw.includes('"callId":"code-call"'))gate.modelDispatch++;const match=gate.enabled&&raw.includes(gate.target==='delivery'?'"sourceNamespace":"code"':gate.target==='codecall'?'"type":"code/call"':gate.target==='writer'||gate.target==='writer-unknown'?'"callId":"interference"':'"type":"agent/delivery-handoff"'),target=gate.target;if(match&&target==='handoff'){gate.entered?.();await gate.wait}const result=await append(...input);if(terminalResult&&gate.resultUnknown&&result.kind==='committed'){gate.resultKey=input[3].key.batchId;return {kind:'unknown' as const,key:input[3].key}}if(match&&target!=='handoff'){if(target==='handoff-unknown'||target==='writer-unknown')gate.unknownKey=input[3].key.batchId;gate.entered?.();await gate.wait;if((target==='handoff-unknown'||target==='writer-unknown')&&result.kind==='committed')return {kind:'unknown' as const,key:input[3].key}}return result},async reconcileOwnedBatch(...input:Parameters<typeof reconcile>){if(gate.resultUnknown&&!gate.resultAllowed&&input[3].key.batchId===gate.resultKey)return {kind:'unknown' as const,key:input[3].key};if(gate.blockReconcile&&input[3].key.batchId===gate.unknownKey){gate.reconcileEntered?.();return {kind:'unknown' as const,key:input[3].key}}return reconcile(...input)}}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry} from '@i-harness/core-tools'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {registerCodeMode} from '../src/register.ts'

it('private original mount interrupts a restored cell and refuses manual Code execution',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'private-code-mount-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'private-code'})
 const execution=await acquireManagedExecution(coordinator,'private-code'),ctx=createContext(),tools=createToolRegistry(ctx),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx)
 const action=execution.owner.beginAction()
 expect((await action.facts.code.record({type:'code/cell',cellId:'old',sessionId:'private-code',state:'started'})).kind).toBe('committed');action.finish()
 let mount:ReturnType<typeof registerCodeMode>|undefined
 try {
  const options={kind:'managed-execution' as const,execution,domain,sessionId:'private-code',config:{mode:'mixed' as const}}
  expect(()=>registerCodeMode(ctx,tools,{...options,domain:{...domain}} as any)).toThrow();expect(()=>registerCodeMode(ctx,tools,{...options,extra:true} as any)).toThrow();let reads=0;const getter=Object.defineProperty({...options},'config',{enumerable:true,get(){reads++;return {mode:'mixed'}}});expect(()=>registerCodeMode(ctx,tools,getter as any)).toThrow();expect(reads).toBe(0);expect(()=>registerCodeMode(ctx,tools,new Proxy(options,{get(){throw Error('trap')}}))).toThrow()
  mount=registerCodeMode(ctx,tools,{kind:'managed-execution',execution,domain,sessionId:'private-code',config:{mode:'mixed'}} as any)
  await mount.ready!()
  expect(execution.observe().codeState().unfinished).toEqual([])
  await expect(tools.get('code_exec')!.execute({code:'text("must not run")'},{})).rejects.toThrow()
 }finally{await mount?.dispose();await coordinator.close()}
},20000)


it.each(['model-projection-success-receipt-unknown','source-hook-epoch-receipt-unknown','model-hook-epoch-unknown','source-hook-epoch','source-foreign','source-hook-revoked','simple','nested','held-stop','held-call','yielded','zero-delay','nested-stop','handoff-stop','handoff-unknown-stop','hook-writer','model-hook-writer','hook-stop-writer','model-hook-stop','model-prepare-writer','model-attach-writer','model-double-next','hook-unknown','model-hook-unknown'] as const)('private original model Code call reaches Worker and retains final output: %s',async mode=>{
 const {mkdir}=await import('node:fs/promises')
 const {createToolRegistryWithModelOrigin}=await import('@i-harness/core-tools/model-origin')
 const {declareToolResultOutcome}=await import('@i-harness/core-tools')
 const epoch=mode==='source-hook-epoch'||mode==='source-hook-epoch-receipt-unknown',unknownPhysical=mode==='model-hook-epoch-unknown',projectedRetry=mode==='model-projection-success-receipt-unknown',projectionCase=epoch||unknownPhysical||projectedRetry
 let physicalExec:import('@i-harness/core-tools').ToolExec|undefined
 const {captureExecutionHookChannel,onExecutionCascade,onExecutionEvent}=await import('@i-harness/core-plugin')
 const {createManagedAgent}=await import('../../core-agent/src/index.ts')
 const {createManagedAgentModelOriginOwner}=await import('../../core-agent/src/tool-batch/managed-model-origin.ts')
 const {createExecutionGenerationLifecycle}=await import('../../session-executor/src/lifecycle/generation-actions.ts')
 const {createOpenAICompatibleClient}=await import('../../llm-openai-compatible/src/index.ts')
 const {createLoopbackProvider}=await import('../../core-agent/test/helpers/provider-loopback.ts')
 const {createContextOutputService}=await import('../../context-output/src/index.ts')
 const {createCodeFinalOutputRetention}=await import('../../session-executor/src/lifecycle/code-final-output-retention.ts')
 const {createToolResultRetention}=await import('../../session-executor/src/lifecycle/result-retention.ts')
 const {createCodeTextRetention}=await import('../../session-executor/src/lifecycle/code-text-retention.ts')
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'private-code-chain-'));await mkdir(join(root,'sessions'))
 const backend=createJsonlBackend(join(root,'sessions')),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'private-code'});const execution=await acquireManagedExecution(coordinator,'private-code'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution)
 const output=createContextOutputService({root:join(root,'output'),workspaceId:'private-code-test'})
 let permanentHookCalls=0,originalPostCalls=0,projectionCalls=0
 if(epoch||unknownPhysical)onExecutionEvent(ctx,'tools/post-execute',()=>{originalPostCalls++})
 if(projectedRetry)onExecutionCascade(ctx,'tools/project-synthetic-result',async()=>{projectionCalls++;return {error:'redacted original tool failure',code:'PROJECTED_FAILURE'}})
 const probeEntered=Promise.withResolvers<void>(),probeRelease=Promise.withResolvers<void>(),hookEntered=Promise.withResolvers<void>(),hookRelease=Promise.withResolvers<void>(),hookResumed=Promise.withResolvers<void>(),ownerWait=Promise.withResolvers<void>(),hookFailed=Promise.withResolvers<unknown>()
 if(mode==='model-double-next')onExecutionCascade(ctx,'tools/execute',async(input,next)=>{if((input as {name:string}).name!=='probe')return next();const first=next();expect(()=>next()).toThrow(/called next\(\) twice/);return await first})
 if(mode==='model-prepare-writer')onExecutionEvent(ctx,'tools/pre-execute',async input=>{if((input as {name:string}).name==='probe'){hookEntered.resolve();await hookRelease.promise;hookResumed.resolve()}})
 if(mode==='nested-stop'||mode==='hook-writer'||mode==='model-hook-writer'||mode==='hook-stop-writer'||mode==='model-hook-stop'||mode==='hook-unknown'||mode==='model-hook-unknown')onExecutionCascade(ctx,'tools/execute',async(input,next)=>{if((input as {name:string}).name==='probe'){hookEntered.resolve();await hookRelease.promise;hookResumed.resolve()}try{return await next()}catch(error){hookFailed.resolve(error);throw error}})
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'private-code'},resultRetention:createToolResultRetention(output,async()=>({sourceId:'actual-native-source'}))},origin.verifier)
 pair.registry.register({name:'probe',description:'nested original probe',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},async execute(args,exec){gate.bodies++;if(unknownPhysical||projectedRetry){physicalExec=exec;throw Error('RAW_UNPROJECTED_SECRET')};const value=(args as {value:string}).value;if(value==='bad')throw Error('actual nested failure');if(value==='wait'){probeEntered.resolve();await probeRelease.promise}return value}})
 const mount=registerCodeMode(ctx,pair.registry,{kind:'managed-execution',execution,domain:origin.domain,sessionId:'private-code',config:{mode:'mixed'},retainText:createCodeTextRetention({service:output,sessionId:'private-code',sourceFor:async()=>({sourceId:'actual-native-source'})}),finalOutput:createCodeFinalOutputRetention({service:output,sourceFor:async()=>({sourceId:'actual-native-source'})})})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'code-call',function:unknownPhysical||projectedRetry||mode==='model-hook-writer'||mode==='model-hook-stop'||mode==='model-hook-unknown'||mode==='model-prepare-writer'||mode==='model-attach-writer'||mode==='model-double-next'?{name:'probe',arguments:JSON.stringify({value:'success'})}:{name:'code_exec',arguments:JSON.stringify({code:mode==='simple'||mode==='held-stop'?'store("persisted",7);text("original private output")':mode==='hook-writer'||mode==='hook-stop-writer'||mode==='hook-unknown'?'text(await tools.probe({value:"success"}))':(mode==='yielded'||mode==='zero-delay'||mode==='handoff-stop'||mode==='handoff-unknown-stop')?'await tools.probe({value:"wait"});text(await tools.probe({value:"success"}))':'text(await tools.probe({value:"success"}));try{await tools.probe({value:"bad"})}catch(e){text("caught")}',yield_time_ms:mode==='zero-delay'?0:mode==='yielded'||mode==='handoff-stop'||mode==='handoff-unknown-stop'?1000:60000})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire(true))},async r=>{if(mode==='zero-delay')await probeEntered.promise;r.end(wire(false))}])
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),failedCell=Promise.withResolvers<never>()
 void failedCell.promise.catch(()=>{})
 const {subscribeManagedExecution}=await import('@i-harness/core-session/internal/execution'),off=subscribeManagedExecution(origin.domain,event=>{if(event.type==='code/cell'&&event.state==='failed')failedCell.reject(Error(event.error??'Original Code cell failed'))})
 let primary:unknown,restoreSourceHook:(()=>void)|undefined
 try {
  if(mode==='zero-delay'){let steps=0;onExecutionEvent(ctx,'agent/pre-step',async()=>{if(++steps===2)await entered.promise})}
  await mount.ready!()
  let writer:ReturnType<typeof execution.owner.beginAction>|undefined,pendingWriter:Promise<unknown>|undefined
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,...mode==='model-attach-writer'?{async flush(){if(gate.modelDispatch===1&&!pendingWriter){writer=execution.owner.beginAction();gate.target='writer';gate.enabled=true;pendingWriter=writer.captureToolCall!({type:'tool/call',callId:'interference',name:'probe',args:{value:'other'}}).admit();await entered.promise}}}:{},hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'original',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'private-code',action,undefined,deps)})
  gate.worker=0;gate.bodies=0;gate.modelDispatch=0;audit.bind=0;audit.attach=0;audit.modelAttach=0;gate.target=mode==='held-call'||mode==='zero-delay'?'codecall':mode==='handoff-stop'?'handoff':mode==='handoff-unknown-stop'?'handoff-unknown':'delivery';gate.enabled=!projectionCase&&mode!=='nested'&&mode!=='yielded'&&mode!=='nested-stop'&&mode!=='hook-writer'&&mode!=='model-hook-writer'&&mode!=='hook-stop-writer'&&mode!=='model-hook-stop'&&mode!=='model-prepare-writer'&&mode!=='model-attach-writer'&&mode!=='model-double-next'&&mode!=='hook-unknown'&&mode!=='model-hook-unknown';gate.entered=entered.resolve;gate.wait=release.promise;gate.waitObserved=ownerWait.resolve
  gate.observeSynthetic=projectionCase;gate.syntheticExecution=undefined;gate.records=undefined;gate.resultWrites=0;gate.resultUnknown=mode==='source-hook-epoch-receipt-unknown'||projectedRetry;gate.resultAllowed=!gate.resultUnknown;gate.resultKey=''
  gate.onSynthetic=unknownPhysical?()=>{gate.onSynthetic=undefined;expect(physicalExec).toBeDefined();expect(declareToolResultOutcome(physicalExec!,'unknown')).toBe(true);onExecutionEvent(ctx,'tools/pre-execute',()=>{permanentHookCalls++})}:undefined
  const stop=new AbortController()
  let sourceMutations=0
  if(mode==='source-foreign'||mode==='source-hook-revoked'||epoch){
   gate.enabled=false
   gate.sourceMutation=()=>{sourceMutations++;if(mode==='source-foreign'){if(!gate.capturedExec)throw Error('Original Code exec missing');gate.capturedExec.callId='foreign-code-call'}else if(epoch)onExecutionEvent(ctx,'tools/pre-execute',()=>{permanentHookCalls++});else{const original=ctx.emit;ctx.emit=async()=>undefined;restoreSourceHook=()=>{ctx.emit=original}}}
  }
  const running=agent.run('run Code',stop.signal,undefined,undefined,{provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
  if(projectionCase){
   const failure=await running.then(()=>undefined,error=>error)
   const hasHookFailure=(error:unknown):boolean=>error instanceof Error&&((error as Error&{code?:string}).code==='EXECUTION_HOOK_SURFACE_CHANGED'||error.cause!==undefined&&hasHookFailure(error.cause))||error instanceof AggregateError&&error.errors.some(hasHookFailure)
   if(!projectedRetry)expect(hasHookFailure(failure)).toBe(true)
   else expect(failure).toBeDefined()
   expect(gate.syntheticExecution).toEqual({outcome:'failed',dispatch:'dispatched'})
   expect(sourceMutations).toBe(epoch?1:0);expect(gate.bodies).toBe(unknownPhysical||projectedRetry?1:0);expect(gate.worker).toBe(0)
   const slot=gate.records!.getSlot(0)!
   if(!('synthetic'in slot))throw Error('Original synthetic failure required')
   const projection=slot.projected
   expect(projection?.kind).toBe(projectedRetry?'projected':'revoked')
   if(unknownPhysical||gate.resultUnknown){
    expect((await backend.read('private-code')).events.filter(e=>e.type==='tool/result'&&e.callId==='code-call')).toHaveLength(unknownPhysical?0:1)
    expect(slot.recorded).toBeUndefined()
    await expect(gate.records!.drainSettled()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
    expect(slot.projected).toBe(projection)
    if(unknownPhysical){await expect(coordinator.close()).rejects.toThrow();expect(declareToolResultOutcome(physicalExec!,'failed')).toBe(true)}
    gate.resultAllowed=true
   }
   expect(originalPostCalls).toBe(0);expect(permanentHookCalls).toBe(0)
   // The genuine hook epoch stays revoked: cleanup must settle the original
   // failed call without restoring authority or entering the Worker body.
   await gate.records!.drainSettled();await gate.records!.drainSettled()
   await mount.dispose();await coordinator.close()
   const events=(await backend.read('private-code')).events
   expect(events.filter(e=>e.type==='tool/call'&&e.callId==='code-call')).toHaveLength(1)
   const results=events.filter(e=>e.type==='tool/result'&&e.callId==='code-call')
   expect(results).toHaveLength(1)
   expect(results[0]).toMatchObject({envelope:{execution:{outcome:'failed',dispatch:'dispatched'},retention:{kind:'inline',value:{code:projectedRetry?'PROJECTED_FAILURE':'TOOL_RESULT_PROJECTION_UNAVAILABLE'}}}})
   expect(JSON.stringify(results)).not.toContain('Managed facts require reconciliation')
   expect(JSON.stringify(results)).not.toContain('RAW_UNPROJECTED_SECRET')
   expect(gate.resultWrites).toBe(1);expect(slot.projected).toBe(projection);expect(projectionCalls).toBe(projectedRetry?1:0)
   const cold=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract)
   try{expect((await cold.snapshot!('private-code')).session.events.filter(e=>e.type==='tool/result'&&e.callId==='code-call')).toEqual(results)}finally{await cold.close()}
   expect(events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='code'||e.type==='code/store'||e.type==='code/end')).toHaveLength(0)
   expect(gate.bodies).toBe(unknownPhysical||projectedRetry?1:0);expect(originalPostCalls).toBe(0);expect(permanentHookCalls).toBe(0)
   return
  }
  if(mode==='source-foreign'||mode==='source-hook-revoked'){
   await running.catch(()=>{})
   restoreSourceHook?.()
   expect(sourceMutations).toBe(1);expect(gate.worker).toBe(0);expect(gate.bodies).toBe(0)
   const events=(await backend.read('private-code')).events
   expect(events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='code')).toHaveLength(0)
   expect(events.filter(e=>e.type==='code/store'||e.type==='code/end')).toHaveLength(0)
   return
  }
  if(mode!=='nested'&&mode!=='yielded'&&mode!=='zero-delay'&&mode!=='nested-stop'&&mode!=='hook-writer'&&mode!=='model-hook-writer'&&mode!=='hook-stop-writer'&&mode!=='model-hook-stop'&&mode!=='model-prepare-writer'&&mode!=='model-attach-writer'&&mode!=='model-double-next'&&mode!=='hook-unknown'&&mode!=='model-hook-unknown'&&mode!=='handoff-stop'&&mode!=='handoff-unknown-stop'){await entered.promise;if(mode==='held-call'){expect(gate.worker).toBe(1);expect(gate.bodies).toBe(0)}else expect(gate.worker).toBe(0);if(mode==='held-stop')stop.abort();gate.enabled=false;release.resolve()}
  if(mode==='held-stop'){await expect(running).rejects.toThrow();expect(gate.worker).toBe(0);return}
  void running.catch(()=>{})
  if(mode==='zero-delay'){await Promise.race([entered.promise,running.then(()=>{throw Error('Agent returned before call ACK')},error=>{throw error})]);expect(server.requests).toHaveLength(1);gate.enabled=false;release.resolve()}
  if(mode==='handoff-unknown-stop'){
   await Promise.race([entered.promise,running.then(()=>{throw Error('Agent returned before unknown handoff')},error=>{throw error})])
   const {receivedExecutionInputsFor}=await import('../../session-executor/src/lifecycle/execution-inputs.ts'),recipient=receivedExecutionInputsFor(execution).codeDelivery(origin.domain),stop=recipient.requestClose('user-stop'),reconcileEntered=Promise.withResolvers<void>()
   void stop.settled.catch(()=>{});gate.blockReconcile=true;gate.reconcileEntered=reconcileEntered.resolve;gate.enabled=false;release.resolve()
   await reconcileEntered.promise;gate.blockReconcile=false;probeRelease.resolve();await running.catch(()=>{});await mount.dispose();const receipt=await recipient.closeReceipt(stop.fenceId);await execution.close()
   const observed=(await backend.read('private-code')).events;expect(receipt).toMatchObject({fenceId:stop.fenceId,durability:'durable'});expect(observed.filter(e=>e.type==='agent/delivery-handoff'&&e.kind==='code')).toHaveLength(1);expect(observed.filter(e=>e.type==='code/end')).toHaveLength(1);const results=observed.filter(e=>e.type==='tool/result'&&e.callId==='code-call');expect(results).toHaveLength(1);expect(results[0]).toMatchObject({envelope:{execution:{dispatch:'dispatched'},retention:{kind:'inline',value:{status:'running'}}}});expect(gate.worker).toBe(1);expect(server.requests).toHaveLength(1);return
  }  if(mode==='handoff-stop'){
   await Promise.race([entered.promise,running.then(()=>{throw Error('Agent returned before handoff')},error=>{throw error})])
   const {receivedExecutionInputsFor}=await import('../../session-executor/src/lifecycle/execution-inputs.ts'),recipient=receivedExecutionInputsFor(execution).codeDelivery(origin.domain),stop=recipient.requestClose('user-stop')
   gate.enabled=false;release.resolve();probeRelease.resolve();await stop.settled;await running.catch(()=>{});await mount.dispose()
   const observed=(await backend.read('private-code')).events;expect(observed.filter(e=>e.type==='agent/delivery-handoff'&&e.kind==='code')).toHaveLength(0);expect(observed.filter(e=>e.type==='code/end')).toHaveLength(1);return
  }  if(mode==='hook-writer'||mode==='model-hook-writer'||mode==='hook-stop-writer'||mode==='model-hook-stop'||mode==='hook-unknown'||mode==='model-hook-unknown'||mode==='model-prepare-writer'){
   await Promise.race([hookEntered.promise,running.then(()=>{throw Error('Agent returned before nested hook')},error=>{throw error})])
   const writer=execution.owner.beginAction();gate.target=mode==='hook-unknown'||mode==='model-hook-unknown'?'writer-unknown':'writer';gate.blockReconcile=mode==='hook-unknown'||mode==='model-hook-unknown';gate.enabled=true;const writerCapture=writer.captureToolCall!({type:'tool/call',callId:'interference',name:'probe',args:{value:'other'}}),write=writerCapture.admit()
   await entered.promise;hookRelease.resolve();await hookResumed.promise;await ownerWait.promise;expect(gate.bodies).toBe(0);if(mode==='model-prepare-writer'){expect(gate.modelDispatch).toBe(0);expect(audit.modelAttach).toBe(0)}if(mode==='hook-stop-writer'||mode==='model-hook-stop')stop.abort();gate.enabled=false;release.resolve();const writerOutcome=await write;if(mode==='hook-unknown'||mode==='model-hook-unknown'){expect(writerOutcome.kind).toBe('unknown');await hookFailed.promise;expect(gate.bodies).toBe(0);gate.blockReconcile=false;await writerCapture.reconcile();writer.finish();await running.catch(()=>{});return}writer.finish();if(mode==='hook-stop-writer'||mode==='model-hook-stop'){await running.catch(()=>{});expect(gate.bodies).toBe(0);return}
  }  if(mode==='model-attach-writer'){
   await Promise.race([entered.promise,running.then(()=>{throw Error('Agent returned before writer')},error=>{throw error})]);await ownerWait.promise;expect(gate.modelDispatch).toBe(1);expect(audit.modelAttach).toBe(0);expect(gate.bodies).toBe(0);gate.enabled=false;release.resolve();await pendingWriter;writer!.finish()
  }  if(mode==='nested-stop'){await Promise.race([hookEntered.promise,running.then(()=>{throw Error('Agent returned before hook')},error=>{throw error})]);const stopping=mount.cancel('stop nested');hookRelease.resolve();await stopping;await running.catch(()=>{});expect(gate.bodies).toBe(0);return}
  if(mode==='yielded'||mode==='zero-delay')await Promise.race([probeEntered.promise,failedCell.promise,running.then(()=>{throw Error('Agent returned before nested body')},error=>{throw error})])
  expect((await running).finalText).toBe('done');if(mode==='simple')expect(gate.worker).toBe(1);gate.enabled=false
  if(mode==='model-hook-writer'||mode==='model-prepare-writer'||mode==='model-attach-writer'||mode==='model-double-next'){expect(gate.bodies).toBe(1);expect(gate.modelDispatch).toBe(1);expect(audit.modelAttach).toBe(1);expect(server.requests).toHaveLength(2);expect((await backend.read('private-code')).events.some(e=>e.type==='agent/delivery-source'&&e.kind==='code')).toBe(false);return}
  if(mode==='yielded'||mode==='zero-delay'){expect(gate.bodies).toBe(1);expect(server.requests).toHaveLength(2);const started=(await backend.read('private-code')).events.find(e=>e.type==='code/cell'&&e.state==='started');if(!started||started.type!=='code/cell')throw Error('Original cell required');probeRelease.resolve();await pair.registry.get('code_wait')!.execute({cell_id:started.cellId,yield_time_ms:60000},{});await mount.dispose()}
  const events=(await backend.read('private-code')).events,source=events.find(e=>e.type==='agent/delivery-source'&&e.kind==='code'),start=events.find(e=>e.type==='code/cell'&&e.state==='started'),terminal=events.find(e=>e.type==='code/end')
  expect(source).toBeDefined();expect(start).toBeDefined();expect(terminal).toMatchObject({execution:{dispatch:'dispatched',outcome:'succeeded'},result:{kind:'artifact'},output:{header:{sessionId:'private-code'},footer:{status:'completed'},unavailableTextCount:0}});expect(source!.seq!).toBeLessThan(start!.seq!);if(mode==='hook-writer')expect(gate.bodies).toBe(1);if(mode==='nested'||mode==='held-call'||mode==='yielded'||mode==='zero-delay'){expect(audit.bind).toBe(1);expect(audit.attach).toBe(2);expect(events.filter(e=>e.type==='code/call'&&e.name==='probe')).toHaveLength(2);expect(events.filter(e=>e.type==='code/result'&&e.name==='probe')).toHaveLength(2)}
  if(mode==='simple'){expect(events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='code')).toHaveLength(1);expect(events.filter(e=>e.type==='code/cell'&&e.state==='started')).toHaveLength(1);expect(events.filter(e=>e.type==='code/end')).toHaveLength(1);expect(events.filter(e=>e.type==='code/store')).toHaveLength(1);await mount.dispose();await execution.close();const reopened=await acquireManagedExecution(coordinator,'private-code');try{expect(reopened.observe().codeState().store).toEqual({kind:'value',entries:[['persisted',7]]})}finally{await reopened.close()}}
 }catch(error){primary=error;throw error}finally{restoreSourceHook?.();off();release.resolve();probeRelease.resolve();hookRelease.resolve();gate.enabled=false;gate.blockReconcile=false;gate.sourceMutation=undefined;gate.capturedExec=undefined;gate.observeSynthetic=false;gate.onSynthetic=undefined;gate.records=undefined;gate.resultUnknown=false;gate.resultAllowed=true;const failures:unknown[]=[];for(const close of [()=>mount.dispose(),()=>coordinator.close(),()=>output.close(),()=>server.close()])try{await close()}catch(error){failures.push(error)}if(failures.length){const describe=(value:unknown):string=>value instanceof AggregateError?`${value.message} [${value.errors.map(describe).join('; ')}]`:value instanceof Error?`${value.message} (${(value as Error & {code?:string}).code??'no-code'})${value.cause===undefined?'':` <- ${describe(value.cause)}`}`:String(value);throw new AggregateError(primary===undefined?failures:[primary,...failures],`Original private Code fixture cleanup failed: ${[...(primary===undefined?[]:[primary]),...failures].map(describe).join('; ')}`)}}
},30000)


















it('runs instruction-backed private Code with a genuine nested call',async()=>{
 const {mkdir,writeFile}=await import('node:fs/promises'),{captureExecutionHookChannel}=await import('@i-harness/core-plugin')
 const {createToolRegistryWithModelOrigin}=await import('@i-harness/core-tools/model-origin'),{committedFactSeqs}=await import('@i-harness/core-session')
 const {createManagedAgent}=await import('../../core-agent/src/index.ts'),{createManagedAgentModelOriginOwner}=await import('../../core-agent/src/tool-batch/managed-model-origin.ts')
 const {createExecutionGenerationLifecycle}=await import('../../session-executor/src/lifecycle/generation-actions.ts'),{createRuntimeContextSource}=await import('../../session-executor/src/lifecycle/action-facts.ts')
 const {createMainInstructionManager,isOriginalAcceptedInstructionOrigin,retainOriginalInstructionCell}=await import('../../session-executor/src/context/instructions/manager.ts'),{createProjectInstructionEnvironment}=await import('../../session-executor/src/context/instructions/host.ts')
 const {createOpenAICompatibleClient}=await import('../../llm-openai-compatible/src/index.ts'),{createLoopbackProvider}=await import('../../core-agent/test/helpers/provider-loopback.ts')
 const {createContextOutputService}=await import('../../context-output/src/index.ts'),{createCodeFinalOutputRetention}=await import('../../session-executor/src/lifecycle/code-final-output-retention.ts')
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'private-code-instruction-'));await mkdir(join(root,'sessions'));await writeFile(join(root,'AGENTS.md'),'Actual project instruction for controlled Code refusal.')
 const backend=createJsonlBackend(join(root,'sessions')),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'instruction'})
 const execution=await acquireManagedExecution(coordinator,'instruction'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),environment=createProjectInstructionEnvironment(),runtime=createRuntimeContextSource(execution.owner)
 const manager=createMainInstructionManager({domain:origin.domain,environment,cwd:root,authority:()=>({kind:'unbound',revision:'actual',workspaceRoot:root}),available:()=>true,async publish(signal,retain){const pin=retain(),source=runtime(signal),observed=execution.observe();try{committedFactSeqs(await source.captureRuntimeContext({type:'runtime/context',version:1,sections:[{name:'instructions',text:manager.text()}]},()=>{observed.assertCurrent();return true}).admit())}finally{source.finish();await pin.release()}}})
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'instruction'},instructionsRequired:true,instructionOriginVerifier:isOriginalAcceptedInstructionOrigin,instructionCellRetainer:retainOriginalInstructionCell},origin.verifier),output=createContextOutputService({root:join(root,'output'),workspaceId:'instruction'})
 pair.registry.register({name:'probe',description:'original nested call',inputSchema:{type:'object'},async execute(){return 'nested-ok'}})
 const mount=registerCodeMode(ctx,pair.registry,{kind:'managed-execution',execution,domain:origin.domain,sessionId:'instruction',config:{mode:'mixed'},finalOutput:createCodeFinalOutputRetention({service:output,sourceFor:async()=>({sourceId:'instruction-source'})})})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'instructed-code',function:{name:'code_exec',arguments:JSON.stringify({code:'text(await tools.probe({}))',yield_time_ms:60000})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`,server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire(true))},async r=>{r.end(wire(false))}])
 try{const {receivedExecutionInputsFor}=await import('../../session-executor/src/lifecycle/execution-inputs.ts');committedFactSeqs(await receivedExecutionInputsFor(execution).facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run Code',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}));await mount.ready!();gate.worker=0;audit.instruction=0;const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),requestContext:manager,tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:()=>manager.text(),budget:{contextWindow:16000},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'instruction',action,undefined,deps)});expect(await agent.run('run Code')).toMatchObject({finalText:'done'});const events=(await backend.read('instruction')).events;expect(events.some(e=>e.type==='tool/call'&&e.name==='code_exec')).toBe(true);expect(events.some(e=>e.type==='agent/delivery-source'&&e.kind==='code')).toBe(true);expect(events.some(e=>e.type==='code/call'&&e.name==='probe')).toBe(true);expect(events.some(e=>e.type==='code/end')).toBe(true);expect(gate.worker).toBe(1);expect(audit.instruction).toBe(1)}finally{for(const [name,close] of [["mount",()=>mount.dispose()],["manager",()=>manager.close()],["environment",()=>environment.close()],["coordinator",()=>coordinator.close()],["output",()=>output.close()],["server",()=>server.close()]] as const)await Promise.race([close().catch(error=>{throw Error(`cleanup ${name}: ${error instanceof AggregateError?error.errors.map(String).join(";"):String(error)}`)}),new Promise((_,reject)=>setTimeout(()=>reject(Error(`cleanup timeout ${name}`)),5000))])}
},60000)




it('replans an instruction-backed private Code mutation after rules change',async()=>{
 const {mkdir,writeFile,readFile}=await import('node:fs/promises'),{captureExecutionHookChannel}=await import('@i-harness/core-plugin')
 const {createToolRegistryWithModelOrigin}=await import('@i-harness/core-tools/model-origin'),{committedFactSeqs}=await import('@i-harness/core-session')
 const {createManagedAgent}=await import('../../core-agent/src/index.ts'),{createManagedAgentModelOriginOwner}=await import('../../core-agent/src/tool-batch/managed-model-origin.ts')
 const {createExecutionGenerationLifecycle}=await import('../../session-executor/src/lifecycle/generation-actions.ts'),{createRuntimeContextSource}=await import('../../session-executor/src/lifecycle/action-facts.ts')
 const {createMainInstructionManager,isOriginalAcceptedInstructionOrigin,retainOriginalInstructionCell}=await import('../../session-executor/src/context/instructions/manager.ts'),{createProjectInstructionEnvironment}=await import('../../session-executor/src/context/instructions/host.ts')
 const {createOpenAICompatibleClient}=await import('../../llm-openai-compatible/src/index.ts'),{createLoopbackProvider}=await import('../../core-agent/test/helpers/provider-loopback.ts')
 const {createContextOutputService}=await import('../../context-output/src/index.ts'),{createCodeFinalOutputRetention}=await import('../../session-executor/src/lifecycle/code-final-output-retention.ts')
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'private-code-instruction-'));await mkdir(join(root,'sessions'));await writeFile(join(root,'AGENTS.md'),'old rules');await writeFile(join(root,'file'),'before')
 const backend=createJsonlBackend(join(root,'sessions')),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'instruction'})
 const execution=await acquireManagedExecution(coordinator,'instruction'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),environment=createProjectInstructionEnvironment(),runtime=createRuntimeContextSource(execution.owner)
 const manager=createMainInstructionManager({domain:origin.domain,environment,cwd:root,authority:()=>({kind:'unbound',revision:'actual',workspaceRoot:root}),available:()=>true,async publish(signal,retain){const pin=retain(),source=runtime(signal),observed=execution.observe();try{committedFactSeqs(await source.captureRuntimeContext({type:'runtime/context',version:1,sections:[{name:'instructions',text:manager.text()}]},()=>{observed.assertCurrent();return true}).admit())}finally{source.finish();await pin.release()}}})
 const sources:import('../../instructions/src/index.ts').InstructionService[]=[];const create=environment.host.create.bind(environment.host);environment.host.create=scope=>{const original=create(scope);sources.push(original);return original}
 const {createToolResultRetention}=await import('../../session-executor/src/lifecycle/result-retention.ts');const output=createContextOutputService({root:join(root,'output'),workspaceId:'instruction'});const pair=createToolRegistryWithModelOrigin(ctx,{resultRetention:createToolResultRetention(output,async()=>({sourceId:'instruction-source'})),executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'instruction'},instructionsRequired:true,instructionOriginVerifier:isOriginalAcceptedInstructionOrigin,instructionCellRetainer:retainOriginalInstructionCell},origin.verifier)
 const {createFsTools}=await import('../../fs/src/index.ts');for(const tool of createFsTools({workspace:root}))pair.registry.register(tool);const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();pair.registry.register({name:'probe',description:'held nested call',inputSchema:{type:'object'},async execute(){entered.resolve();await release.promise;return 'ready'}})
 const mount=registerCodeMode(ctx,pair.registry,{kind:'managed-execution',execution,domain:origin.domain,sessionId:'instruction',config:{mode:'mixed'},finalOutput:createCodeFinalOutputRetention({service:output,sourceFor:async()=>({sourceId:'instruction-source'})})})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'instructed-code',function:{name:'code_exec',arguments:JSON.stringify({code:`await tools.probe({});try{await tools.write(${JSON.stringify({path:join(root,'file'),text:'unsafe'})})}catch{text('caught');store('bad',true)}`,yield_time_ms:0})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`,server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire(true))},async (r,request)=>{const messages=request.body.messages as {role:string;content:string}[];const tool=messages.findLast(m=>m.role==='tool')!;const cell=JSON.parse(tool.content).cell_id;await entered.promise;await writeFile(join(root,'AGENTS.md'),'new rules');await vi.waitFor(()=>expect(sources[0]!.snapshot().complete).toBe(false));release.resolve();r.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'wait',function:{name:'code_wait',arguments:JSON.stringify({cell_id:cell,yield_time_ms:60000})}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`)},async r=>{r.end(wire(false))}])
 try{const {receivedExecutionInputsFor}=await import('../../session-executor/src/lifecycle/execution-inputs.ts');committedFactSeqs(await receivedExecutionInputsFor(execution).facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run Code',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}));await mount.ready!();gate.worker=0;audit.instruction=0;const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),requestContext:manager,tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:()=>manager.text(),budget:{contextWindow:16000},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'instruction',action,undefined,deps)});await agent.run('run Code').catch(error=>{throw Error('AGENT_PRIMARY: '+String(error),{cause:error})});const events=(await backend.read('instruction')).events;expect(events.some(e=>e.type==='tool/call'&&e.name==='code_exec')).toBe(true);expect(await readFile(join(root,'file'),'utf8')).toBe('before');expect(events.some(e=>e.type==='code/store')).toBe(false);expect(events.some(e=>e.type==='code/cell'&&e.state==='failed'&&e.instructionReplan?.code==='INSTRUCTIONS_REPLAN_REQUIRED')).toBe(true);expect(JSON.stringify(server.requests.at(-1)!.body)).toContain('INSTRUCTIONS_REPLAN_REQUIRED')}catch(error){const describe=(e:unknown):string=>e instanceof AggregateError?e.message+' ['+e.errors.map(describe).join('; ')+']':e instanceof Error?e.message+(e.cause===undefined?'':' <- '+describe(e.cause)):String(e);console.error(describe(error));throw error}finally{release.resolve();for(const [name,close] of [["mount",()=>mount.dispose()],["manager",()=>manager.close()],["environment",()=>environment.close()],["coordinator",()=>coordinator.close()],["output",()=>output.close()],["server",()=>server.close()]] as const)await Promise.race([close().catch(error=>{throw Error(`cleanup ${name}: ${error instanceof AggregateError?error.errors.map(String).join(";"):String(error)}`)}),new Promise((_,reject)=>setTimeout(()=>reject(Error(`cleanup timeout ${name}`)),5000))])}
},120000)




it('refuses an original delegated private execution before Code registration',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'private-code-child-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'child',parentSession:'parent',origin:'subagent',seedLength:0})
 const execution=await acquireManagedExecution(coordinator,'child'),ctx=createContext(),tools=createToolRegistry(ctx),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx)
 try{gate.worker=0;expect(()=>registerCodeMode(ctx,tools,{kind:'managed-execution',execution,domain,sessionId:'child',config:{mode:'mixed'}})).toThrow(/delegated/);expect(tools.get('code_exec')).toBeUndefined();expect(gate.worker).toBe(0)}finally{await coordinator.close()}
},20000)






























