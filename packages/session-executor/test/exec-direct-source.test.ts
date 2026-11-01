import { createExecResultRetention } from '../src/lifecycle/exec-result-retention.ts'
import { registerExecWithReservation, createExecutionSupervisor } from '@i-harness/exec'
import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin'
import { createAgentModelOriginOwner } from '../../core-agent/src/tool-batch/model-origin.ts'
import { createAgent } from '@i-harness/core-agent'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { createRecipientDelivery } from '../src/lifecycle/recipient-delivery.ts'
import { createShellTools } from '@i-harness/shell'
import { createExecServiceWithReservation } from '../../exec/src/service.ts'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecFrameCapture } from '../../output-retention/src/result/exec-frames.ts'
import * as scoped from '../src/scoped-exec.ts'
import { randomUUID } from 'node:crypto'

vi.mock('node:crypto',async original=>{const actual=await original<typeof import('node:crypto')>();return{...actual,randomUUID:vi.fn(actual.randomUUID)}})

vi.mock('../../shell/src/discovery/windows.ts',()=>({bashAvailable:()=>true,resolveBashExe:()=> 'controlled-bash',resolvePwshExe:()=> 'controlled-pwsh',powerShellExecutableAvailable:()=>true}))
it.each([
  ['shell','background',true],['bash','background',true],['pwsh','background',true],
  ['shell','foreground',true],['bash','foreground',true],['pwsh','foreground',true],
  ['shell','promotion',true],['bash','promotion',true],['pwsh','promotion',true],
  ['shell','background',false],['shell','nested',true],['shell','stop',true],
  ['shell','frame-debt',true],['shell','native-debt',true],['shell','unknown-source',true],
  ['shell','manual',true],['shell','code',true],['shell','once',true],['shell','child',true],['shell','close-after-source',true],['shell','null-exit',true],['shell','transform-failure',true],['shell','dispose-in-policy',true],['shell','promotion-race',true],['shell','recipient-unavailable',true],
  ['shell','commit-rollback-debt',true],['shell','commit-falsey-rollback-debt',true],['shell','receipt-cleanup-debt',true],
  ['shell','prepared-policy-debt',true],
  ['shell','commit-rollback-sibling',true],
  ['shell','revoked-probe',true],['shell','revoked-prepare',true],['shell','stop-held-prepare',true],['shell','authority-revocation',true],['shell','healthy-held-prepare',true],
  ['shell','wrapped-supervisor',true],['shell','reconcile-held-prepare',true],
] as const)('owns original %s %s source and post-body completion (direct: %s)', async (name,mode,privileged) => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'exec-source-'))
  const backendStore=createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backendStore, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), ctx = createContext()
  const origin = createAgentModelOriginOwner({view:document.view,factOwner:document})
  const registry = createToolRegistryWithModelOrigin(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:id}},origin.verifier)
  let sourceWrites=0,handoffWrites=0,allowSource=false,retentionReady=false,releaseReady=false
  let stopRequest:ReturnType<ReturnType<typeof createRecipientDelivery>['requestClose']>|undefined
  const appendOwned=backendStore.appendOwnedBatch!,reconcileOwned=backendStore.reconcileOwnedBatch!
  let unknownKey:Parameters<typeof reconcileOwned>[3]['key']|undefined
  backendStore.appendOwnedBatch=async(...args)=>{
    const bytes=Buffer.from(args[3].bytes).toString('utf8')
    const isSource=bytes.includes('"type":"agent/delivery-source"')&&bytes.includes('"kind":"exec"')
    const result=await appendOwned(...args)
    if(bytes.includes('"type":"agent/delivery-handoff"')){handoffWrites++;if(mode==='promotion-race'){gate.resolve();await new Promise<void>(done=>setImmediate(done))}}
    if(isSource){sourceWrites++;if(mode==='close-after-source')stopRequest=received.requestClose('user-stop');if(mode==='unknown-source'){unknownKey=args[3].key;return{kind:'unknown',key:args[3].key}}}
    return result
  }
  backendStore.reconcileOwnedBatch=async(...args)=>!allowSource&&unknownKey&&args[3].key.batchId===unknownKey.batchId?{kind:'unknown',key:args[3].key}:reconcileOwned(...args)
  const gate = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>()
  const admissionGate=Promise.withResolvers<void>(),enteredAdmission=Promise.withResolvers<void>()
  const siblingGate=Promise.withResolvers<void>(),siblingDrained=Promise.withResolvers<void>()
  let launches = 0,cancellations=0
  let rollbacks=0,nativeOutstanding=false,preparedPolicyReads=0
  let authorityCalls=0,policyResolutions=0,siblingCancels=0
  const rejectedAdmission=['commit-rollback-debt','commit-falsey-rollback-debt','receipt-cleanup-debt','prepared-policy-debt','commit-rollback-sibling'].includes(mode)
  const nativeIssued=Promise.withResolvers<void>(),controller=new AbortController()
  const expectedSources=privileged&&mode!=='stop'&&mode!=='transform-failure'&&mode!=='dispose-in-policy'&&mode!=='recipient-unavailable'?1:0
  const backend: TransportExecutionBackend = {
    async probe(){if(mode==='revoked-probe'){enteredAdmission.resolve();await admissionGate.promise};return{id:'source',availability:'available',assurance:'unverified',features:{writeIsolation:false,readIsolation:false,denyPaths:false,pipes:true,pty:false,retainedTree:true}}},
    async prepare(spec,policy){
      const sibling=spec.argv[0]==='sibling',rootGate=sibling?siblingGate:gate,ioGate=sibling?siblingDrained:drained
      if(['revoked-prepare','stop-held-prepare','healthy-held-prepare','reconcile-held-prepare'].includes(mode)){enteredAdmission.resolve();await admissionGate.promise}
      const prepared:Awaited<ReturnType<TransportExecutionBackend['prepare']>>={get policy(){if(!sibling)preparedPolicyReads++;if(mode==='prepared-policy-debt'){nativeOutstanding=true;throw new Error('original prepared policy failure')};return policy},async rollback(){expect(this).toBe(prepared);rollbacks++;if(rejectedAdmission&&!sibling&&!releaseReady)throw mode==='commit-falsey-rollback-debt'?undefined:new Error('original rollback debt');if(!sibling)nativeOutstanding=false;rootGate.resolve();ioGate.resolve()},async commit(check){check();launches++
    expect(document.view.events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='exec'),JSON.stringify({traces,results:document.view.events.filter(e=>e.type==='tool/result')})).toHaveLength(spec.argv[0]==='nested'||sibling?0:expectedSources)
      if(spec.argv[0]!=='nested'&&!sibling)nativeIssued.resolve()
      if(!sibling)nativeOutstanding=true
      if(!sibling&&['commit-rollback-debt','commit-falsey-rollback-debt','commit-rollback-sibling'].includes(mode))throw new Error('original commit failed after native issue')
      const lease=createExecutionLease({receipt:{executionId:'source-native-'+launches,backendId:mode==='receipt-cleanup-debt'?'invalid-receipt':'source',policyFingerprint:policy.fingerprint,owner:spec.owner,assurance:'unverified'},rootExited:rootGate.promise.then(()=>({exitCode:mode==='null-exit'?null:0})),waitTreeEmpty:()=>rootGate.promise,settleIo:async()=>{if(mode==='receipt-cleanup-debt'){if(!releaseReady)throw new Error('original native IO debt');return};await ioGate.promise},async releaseResources(){if(mode==='native-debt'&&!releaseReady)throw new Error('original native release debt');if(!sibling)nativeOutstanding=false},async terminate(){if(sibling)siblingCancels++;else cancellations++;rootGate.resolve()}})
      return{...lease,get settled(){return lease.settled},pid:1,io:{async write(){},async endInput(){},output:(async function*(){try{yield{channel:'stdout' as const,data:Buffer.from('original')};await rootGate.promise}finally{ioGate.resolve()}})()}}
    }};return prepared},
  }
  const originalSupervisor=createExecutionSupervisor()
  const supervisor=mode==='wrapped-supervisor'?{...originalSupervisor,launch(input:Parameters<typeof originalSupervisor.launch>[0]){return originalSupervisor.launch(input)}}:originalSupervisor
  const execPair=registerExecWithReservation(ctx,{execution:{supervisor,defaultOwner:{sessionId:id},selectBackend:()=>backend,validateAuthority(){authorityCalls++;if(mode==='authority-revocation'&&authorityCalls===3)stopRequest=received.requestClose('user-stop')},resolvePolicy:owner=>{policyResolutions++;return compileExecutionPolicy({mode:'danger-full-access',owner,authority:{kind:'unbound',revision:'source',workspaceRoot:resolve('.')}})}},resultRetention:mode==='frame-debt'?{begin({sourceId}){return createExecFrameCapture({sourceId,async openArtifact(){if(mode==='frame-debt')return{async write(){},async reconcileWrite(){return 'ready' as const},async finish(){return retentionReady?{kind:'refused' as const,reason:'quota' as const,observedEncodedBytes:9}:{kind:'recovery-required' as const,operationId:'original-frames'}},async reconcile(){throw new Error('unused')}};throw Object.assign(new Error('quota'),{code:'ARTIFACT_QUOTA'})}})},async settle(frames){return frames.settle()},async observe(frames){return frames.settle()}}:createExecResultRetention(undefined)})
  let received!: ReturnType<typeof createRecipientDelivery>
  const receivedSource=document.registerReceivedInputSource(async()=>{await received.settle()})
  received=createRecipientDelivery(document,receivedSource,id)
  const traces:unknown[]=[]
  let nested=false,scopedDispose:Promise<void>|undefined
  const paired=scoped.createScopedExecWithReservation(execPair,resolve('.'),()=>{if(mode==='dispose-in-policy')scopedDispose=execPair.service.dispose();if(mode==='transform-failure')throw new Error('original scoped transform');if(mode==='nested'&&!nested){nested=true;void execPair.service.runBackground({argv:['nested']})}return undefined},async input=>{const result=await received.prepareExecLaunch(input);traces.push(result);if(mode==='stop')controller.abort();return result},ctx)
  const exec=paired.service
  const inheritedTools=createShellTools({exec,agentShell:()=>({id:'controlled',label:'controlled',command:'controlled',dialect:'posix'}),...(mode==='promotion'||mode==='promotion-race'?{backgroundAfterMs:0}:{}),...(privileged?{directEntry:mode==='once'?((tool:import('@i-harness/core-tools').Tool,leaf:import('@i-harness/core-tools').Tool['execute'])=>{
    const entry=paired.direct(tool,leaf)
    return{enter(exec:import('@i-harness/core-tools').ToolExec){const original=entry.enter(exec);if(!original)return;return{...original,async runBackground(command:import('@i-harness/exec').ExecCommand){
      let reads=0;const duplicate=Object.defineProperty({},'argv',{get(){reads++;return ['duplicate']}}) as import('@i-harness/exec').ExecCommand
      expect(()=>Reflect.apply(original.run,{...original},[duplicate])).toThrow('receiver')
      const first=original.runBackground(command)
      await expect(original.run(duplicate)).rejects.toThrow('consumed');expect(reads).toBe(0)
      return first
    }}}}
  }):paired.direct}:{})})
  for(const tool of inheritedTools)registry.registry.register(tool)
  const { createLoopbackProvider } = await import('../../core-agent/test/helpers/provider-loopback.ts')
  const wire=(tool:boolean)=>'data: '+JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'source-call',function:{name,arguments:JSON.stringify({command:'controlled',background:!['foreground','promotion','promotion-race','stop'].includes(mode)})}}]}:{content:'returned'},finish_reason:tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n'
  const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
  const agent=createAgent(ctx,{session:document.view,sessionId:id,factOwner:document,tools:registry.registry,modelCallOrigin:origin.bind(registry.registry,registry.driver),model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'s',generationFactory:(action,deps)=>createGenerationLifecycle(document.view,id,action,undefined,deps)})
  try{
    if(mode!=='recipient-unavailable')await receivedSource.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'original-human',text:'run the original command',delivery:'steer',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture',originSessionId:id}}).admit()
    const sibling=mode==='commit-rollback-sibling'?await execPair.service.runBackground({argv:['sibling']}):undefined
    const running=agent.run('run the original command',controller.signal,undefined,mode==='recipient-unavailable'?undefined:'original-human')
    if(['revoked-probe','revoked-prepare','stop-held-prepare','healthy-held-prepare','reconcile-held-prepare'].includes(mode)){
      await enteredAdmission.promise
      expect(sourceWrites).toBe(1);expect(launches).toBe(0)
      expect(document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(0)
      if(mode==='stop-held-prepare')controller.abort()
      else if(mode!=='healthy-held-prepare'){
        if(mode==='reconcile-held-prepare')await originalSupervisor.reconcile(id,()=>{})
        stopRequest=received.requestClose('user-stop')
      }
      admissionGate.resolve()
    }
    const revoked=['revoked-probe','revoked-prepare','stop-held-prepare','authority-revocation','reconcile-held-prepare'].includes(mode)
    if(revoked||rejectedAdmission||mode==='stop'||mode==='transform-failure'||mode==='dispose-in-policy'||mode==='unknown-source'||mode==='close-after-source')await running.catch(()=>{})
    else{
      await Promise.race([nativeIssued.promise,running])
      if(mode==='foreground')gate.resolve()
      await running
    }
    await scopedDispose
    if(revoked){
      expect(sourceWrites).toBe(1);expect(launches).toBe(0)
      await stopRequest?.settled
      await execPair.service.dispose()
      expect(document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(1)
      return
    }
    if(rejectedAdmission){
      const issued=mode==='prepared-policy-debt'?0:sibling?2:1
      expect(sourceWrites).toBe(1);expect(launches).toBe(issued);expect(nativeOutstanding).toBe(true)
      expect(document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(0)
      await expect(sibling?document.settleFinishedActions():execPair.service.dispose()).rejects.toThrow()
      expect(document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(0)
      const previousRollbacks=rollbacks
      const grants=policyResolutions
      releaseReady=true;await(sibling?document.settleFinishedActions():execPair.service.dispose())
      expect(nativeOutstanding).toBe(false);expect(sourceWrites).toBe(1);expect(launches).toBe(issued)
      expect(preparedPolicyReads).toBe(1)
      expect(policyResolutions).toBe(grants)
      if(sibling){
        expect(siblingCancels).toBe(0);expect(execPair.service.getJobView(sibling.jobId).status).toBe('running')
        const original=document.view.events.find(e=>e.type==='agent/delivery-source'&&e.kind==='exec')!
        if(original.type!=='agent/delivery-source')throw new Error('Missing original source')
        vi.mocked(randomUUID).mockReturnValueOnce(original.sourceId as ReturnType<typeof randomUUID>)
        const unused=execPair.port.reserve();expect(execPair.port.instanceId(unused)).toBe(original.sourceId);execPair.port.release(unused)
      }
      if(mode==='receipt-cleanup-debt')expect(rollbacks).toBe(0)
      else expect(rollbacks).toBeGreaterThan(previousRollbacks)
      expect(document.view.events.filter(e=>e.type==='exec/end')).toMatchObject([{execution:{dispatch:'unknown',outcome:'unknown'}}])
      return
    }
    if(mode==='close-after-source'){
      expect(launches).toBe(0);expect(sourceWrites).toBe(1)
      await stopRequest?.settled
      await execPair.service.dispose()
      expect(document.view.events.filter(e=>e.type==='exec/end')).toMatchObject([{execution:{dispatch:'not-dispatched',outcome:'unknown'}}])
      return
    }
    if(mode==='unknown-source'){
      expect(launches).toBe(0);expect(sourceWrites).toBe(1)
      expect(document.view.events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='exec')).toHaveLength(0)
      await expect(execPair.service.dispose()).rejects.toThrow()
      allowSource=true
      await execPair.service.dispose()
      expect(launches).toBe(0);expect(sourceWrites).toBe(1)
      expect(document.view.events.filter(e=>e.type==='exec/end')).toMatchObject([{execution:{dispatch:'not-dispatched',outcome:'unknown'}}])
      return
    }
    expect(document.view.events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='exec'),JSON.stringify({traces,results:document.view.events.filter(e=>e.type==='tool/result')})).toHaveLength(expectedSources)
    expect(launches).toBe(mode==='stop'||mode==='transform-failure'||mode==='dispose-in-policy'?0:mode==='nested'?2:1)
    if(mode==='recipient-unavailable'){expect(cancellations).toBe(0);expect(execPair.service.listJobViews()).toMatchObject([{status:'running'}])}
    if(mode==='child'){
      const childRoot=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'exec-child-'))
      const childCoordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(childRoot),{lock:{enabled:true}},taskDocumentStorageContract)
      const child=await childCoordinator.create(), childDoc=await childCoordinator.openManagedDocument(child.id),childCtx=createContext()
      const childOrigin=createAgentModelOriginOwner({view:childDoc.view,factOwner:childDoc})
      const childRegistry=createToolRegistryWithModelOrigin(childCtx,{executionOwner:{view:childDoc.view,factOwner:childDoc,context:childCtx,sessionId:child.id}},childOrigin.verifier)
      let childDelivery!:ReturnType<typeof createRecipientDelivery>
      const childReceived=childDoc.registerReceivedInputSource(async()=>{await childDelivery.settle()})
      childDelivery=createRecipientDelivery(childDoc,childReceived,child.id)
      const childPair=createExecServiceWithReservation({execution:{defaultOwner:{sessionId:child.id},validateAuthority(){},resolvePolicy:owner=>compileExecutionPolicy({mode:'danger-full-access',owner,authority:{kind:'unbound',revision:'child',workspaceRoot:resolve('.')}}),selectBackend:()=>({...backend,async prepare(spec,policy,signal){expect(spec.owner.sessionId).toBe(child.id);expect(childDoc.view.events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='exec')).toHaveLength(1);return backend.prepare(spec,policy,signal)}})},resultRetention:createExecResultRetention(undefined)})
      scoped.createScopedExecWithReservation(childPair,resolve('.'),()=>undefined,input=>childDelivery.prepareExecLaunch(input),childCtx)
      childRegistry.registry.register(inheritedTools.find(tool=>tool.name==='shell')!)
      const childServer=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
      const childAgent=createAgent(childCtx,{session:childDoc.view,sessionId:child.id,factOwner:childDoc,tools:childRegistry.registry,modelCallOrigin:childOrigin.bind(childRegistry.registry,childRegistry.driver),model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:childServer.baseUrl}),systemPrompt:'s',generationFactory:(action,deps)=>createGenerationLifecycle(childDoc.view,child.id,action,undefined,deps)})
      try{
        await childReceived.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'child-human',text:'run child',delivery:'steer',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture',originSessionId:child.id}}).admit()
        await childAgent.run('run child',undefined,undefined,'child-human')
        expect(childDoc.view.events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='exec')).toMatchObject([{recipientSessionId:child.id}])
        expect(document.view.events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='exec')).toHaveLength(1)
        expect(launches).toBe(2)
      }finally{await childPair.service.dispose();await childReceived.close();await childServer.close();await childCoordinator.close();await childCtx.scope.unmount()}
    }
    if(mode==='manual'||mode==='code'){
      const action=document.beginAction(),source=action.registerSettlementSource(async()=>{})
      try{
        const prepared=await registry.registry.prepare({name:'shell',args:{command:'manual',background:true}},undefined,{session:document.view,sessionId:id,callId:'manual-shell',settlementSource:source,...mode==='code'?{resultConsumer:'code' as const}:{}})
        await registry.registry.dispatch(prepared)
        expect(launches).toBe(2);expect(sourceWrites).toBe(1)
      }finally{await source.close();action.finish()}
    }
    if(mode!=='foreground'&&mode!=='child'&&mode!=='promotion-race')expect(document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(0)
    expect(document.view.events.filter(e=>e.type==='agent/delivery-handoff')).toHaveLength(mode==='promotion'||mode==='promotion-race'?1:0)
    if(mode==='promotion-race'){await vi.waitFor(()=>expect(document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(1),{timeout:2000});expect(handoffWrites).toBe(1)}
    gate.resolve()
    if(mode==='frame-debt'||mode==='native-debt'){
      await expect(execPair.service.dispose()).rejects.toThrow()
      expect(document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(0)
      retentionReady=true;releaseReady=true
    }
    await execPair.service.dispose()
    expect(document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(expectedSources)
    if(mode==='null-exit')expect(document.view.events.filter(e=>e.type==='exec/end')).toMatchObject([{execution:{dispatch:'dispatched',outcome:'unknown'},exitCode:null}])
  }finally{siblingGate.resolve();siblingDrained.resolve();admissionGate.resolve();allowSource=true;retentionReady=true;releaseReady=true;gate.resolve();drained.resolve();await execPair.service.dispose().catch(()=>{});await receivedSource.close();await coordinator.close();await server.close();await ctx.scope.unmount()}
})












it('refuses copied or mismatched service pairs before any scoped callback', async()=>{
  const a=createExecServiceWithReservation(),b=createExecServiceWithReservation()
  let effects=0
  const policy=()=>{effects++;return undefined}
  const prepare=async()=>{effects++;return{kind:'unavailable' as const,reason:'recipient-not-bound' as const}}
  try{
    for(const copied of [{...a},{service:a.service,port:b.port}])expect(()=>scoped.createScopedExecWithReservation(copied,resolve('.'),policy,prepare)).toThrow('Original Exec construction pair')
    expect(Reflect.set(a,'service',b.service)).toBe(false)
    expect(Reflect.set(a,'port',b.port)).toBe(false)
    expect(effects).toBe(0)
  }finally{await a.service.dispose();await b.service.dispose()}
})
