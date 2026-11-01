import { mkdtemp, readFile, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { expect, vi } from 'vitest'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { subscribe, decodeFactBatch } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '../../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '@i-harness/context-output'
import { createOpenAICompatibleClient } from '../../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../../core-agent/test/helpers/provider-loopback.ts'
import { createSessionService, createDurableSessionLoader } from '../../src/index.ts'
import { RecipientDeliveryRecoveryError } from '../../src/lifecycle/recipient-delivery.ts'
import { createTelemetry, type TelemetryEvent } from '@i-harness/telemetry'

/** Actual service/action/Body/Shell/reservation/retention/receiver/lane. Only
 * loopback provider and the original supervisor's physical backend are held. */
export async function createExecDeliveryFixture(install:(backend:TransportExecutionBackend)=>void, options:{exitCode?:number|null;foreground?:boolean;promotion?:boolean;holdIo?:boolean;holdReceipt?:boolean;unknownReceipt?:boolean;receiptFailure?:'false'|'undefined';transientAdmission?:boolean;holdParent?:boolean;retentionDebt?:boolean;nativeDebt?:boolean;nestedCode?:boolean;holdPromotion?:boolean;artifactRefused?:boolean;candidateFailures?:readonly unknown[]}={}) {
  const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'exec-recipient-'))
  let journalRoot=join(root,'sessions'),backend=createJsonlBackend(journalRoot)
  let coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
  await coordinator.create({sessionId:'parent'})
  let document=await coordinator.openManagedDocument('parent')
  const recoveryHeld=Promise.withResolvers<void>()
  let execSource:import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>|undefined
  const beginAction=document.beginAction.bind(document)
  document.beginAction=signal=>{const action=beginAction(signal),register=action.registerSettlementSource.bind(action),capture=action.captureExecDeliverySource.bind(action);let original:import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>|undefined
    action.registerSettlementSource=(...args)=>{const source=register(...args);original=source;return source}
    action.captureExecDeliverySource=(...args)=>{if(!original)throw new Error('Missing directly action-registered Exec source');execSource=original;const hold=original.holdRecovery.bind(original);original.holdRecovery=()=>{hold();recoveryHeld.resolve()};return capture(...args)}
    return action}
  let refusals=0
  let allowAdmissions=false
  const admissionCaptures:string[]=[],admissionAttempts:string[]=[]
  if(options.candidateFailures){const register=document.registerReceivedInputSource.bind(document);document.registerReceivedInputSource=(...args)=>{const source=register(...args),capture=source.captureDeliveryAdmission.bind(source);source.captureDeliveryAdmission=(...input)=>{const fact=capture(...input),index=admissionCaptures.length;admissionCaptures.push(input[0].inputId);const admit=fact.admit.bind(fact);return{...fact,async admit(){admissionAttempts.push(input[0].inputId);if(!allowAdmissions)throw options.candidateFailures![index];return admit()}}};return source}}
  if(options.transientAdmission){const register=document.registerReceivedInputSource.bind(document);document.registerReceivedInputSource=(...args)=>{const source=register(...args),capture=source.captureDeliveryAdmission.bind(source);source.captureDeliveryAdmission=(...input)=>{if(++refusals<=3)throw new RecipientDeliveryRecoveryError({kind:'retryable',phase:'temporary-admission'});return capture(...input)};return source}}
  const output=createContextOutputService({root:join(root,'results'),workspaceId:'exec-recipient',config:{enabled:false}})
  let recoveryReady=false
  const debt=Promise.withResolvers<void>()
  if(options.retentionDebt){const begin=output.beginResult.bind(output);output.beginResult=async(...args)=>{const sink=await begin(...args);if(args[1]!=='exec-frames-v1')return sink;return{write:sink.write.bind(sink),reconcileWrite:sink.reconcileWrite.bind(sink),async finish(completeness){const result=await sink.finish(completeness);if(!recoveryReady){debt.resolve();return{kind:'recovery-required',operationId:'original-physical-finish'}}return result},async reconcile(){return recoveryReady?sink.reconcile():{kind:'recovery-required',operationId:'original-physical-finish'}}}}}
  if(options.artifactRefused){const begin=output.beginResult.bind(output);output.beginResult=(...args)=>{if(args[1]==='exec-frames-v1')throw Object.assign(new Error('Actual native artifact quota refusal'),{code:'ARTIFACT_QUOTA'});return begin(...args)}}
  const rootExit=Promise.withResolvers<void>(),io=Promise.withResolvers<void>(),streamDone=Promise.withResolvers<void>()
  const issued=Promise.withResolvers<void>(),terminal=Promise.withResolvers<void>(),receipt=Promise.withResolvers<void>(),consumed=Promise.withResolvers<void>()
  const receiptPrepared=Promise.withResolvers<void>(),receiptGate=Promise.withResolvers<void>(),receiptUnknown=Promise.withResolvers<void>(),parentEntered=Promise.withResolvers<void>(),parentGate=Promise.withResolvers<void>()
  const promotionPrepared=Promise.withResolvers<void>(),promotionGate=Promise.withResolvers<void>()
  if(!options.holdPromotion)promotionGate.resolve()
  if(!options.holdReceipt)receiptGate.resolve()
  if(!options.holdParent)parentGate.resolve()
  let allowReceipt=false,unknownKey:Parameters<NonNullable<typeof backend.reconcileOwnedBatch>>[3]['key']|undefined
  // Stable delegates were installed by the test's original journal factory,
  // before createJsonlBackend captured its descriptor identity.
  const receiptKeys:string[]=[],append=vi.mocked(backend.appendOwnedBatch!).getMockImplementation()!,reconcile=vi.mocked(backend.reconcileOwnedBatch!).getMockImplementation()!
  vi.mocked(backend.appendOwnedBatch!).mockImplementation(async(...args)=>{const events=decodeFactBatch(args[3].bytes).events,isReceipt=events.some(e=>e.type==='agent/delivery-received');if(isReceipt){receiptPrepared.resolve();await receiptGate.promise;receiptKeys.push(args[3].key.batchId)}if(events.some(e=>e.type==='agent/input/promoted'&&e.inputId.startsWith('delivery-'))){promotionPrepared.resolve();await promotionGate.promise}const outcome=await append(...args);if(isReceipt&&(options.unknownReceipt||options.receiptFailure)){unknownKey=args[3].key;receiptUnknown.resolve();if(options.receiptFailure)throw options.receiptFailure==='false'?false:undefined;return{kind:'unknown',key:args[3].key}}return outcome})
  vi.mocked(backend.reconcileOwnedBatch!).mockImplementation(async(...args)=>{if(args[3].key.batchId===unknownKey?.batchId){receiptKeys.push(args[3].key.batchId);if(!allowReceipt)return{kind:'unknown',key:args[3].key}}return reconcile(...args)})
  let launches=0,cancels=0,releases=0
  install({async probe(){return{id:'exec-recipient-fixture',availability:'available',assurance:'unverified',features:{writeIsolation:false,readIsolation:false,denyPaths:false,pipes:true,pty:false,retainedTree:true}}},async prepare(spec,policy){return{policy,async rollback(){rootExit.resolve();io.resolve()},async commit(check){check();launches++;expect(document.view.events.filter(e=>e.type==='agent/delivery-source'&&e.kind==='exec')).toHaveLength(options.nestedCode?0:launches);issued.resolve()
    const lease=createExecutionLease({receipt:{executionId:options.candidateFailures?`exec-recipient-native-${launches}`:'exec-recipient-native',backendId:'exec-recipient-fixture',policyFingerprint:policy.fingerprint,owner:spec.owner,assurance:'unverified'},rootExited:rootExit.promise.then(()=>({exitCode:options.exitCode===undefined?0:options.exitCode})),waitTreeEmpty:()=>rootExit.promise,settleIo:async()=>{await streamDone.promise;await io.promise},async releaseResources(){releases++;if(options.nativeDebt&&!recoveryReady){debt.resolve();throw new Error('Original native release held')}},async terminate(){cancels++;rootExit.resolve();io.resolve()}})
    return{...lease,get settled(){return lease.settled},pid:1,io:{async write(){},async endInput(){},output:(async function*(){try{yield{channel:'stdout' as const,data:Buffer.from('original retained Exec output')};await rootExit.promise}finally{streamDone.resolve()}})()}}
  }}}})
  if(!options.holdIo)io.resolve()
  const rounds=Array.from({length:15},(_,index)=>async(response:import('node:http').ServerResponse)=>{if(index===1){parentEntered.resolve();await parentGate.promise}const delta=index===0?{tool_calls:Array.from({length:options.candidateFailures?.length??1},(_,command)=>({index:command,id:command===0?'original-shell':`original-shell-${command}`,type:'function',function:{name:options.nestedCode?'code_exec':'shell',arguments:JSON.stringify(options.nestedCode?{code:'text(await tools.shell({command:"controlled",background:true}));'}:{command:'controlled',background:!options.foreground&&!options.promotion})}}))}:{content:'parent finished'};response.end('data: '+JSON.stringify({choices:[{delta,finish_reason:index===0?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')})
  const server=await createLoopbackProvider('/v1/chat/completions',rounds)
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  const telemetryEvents:TelemetryEvent[]=[],telemetry=createTelemetry([{onEvent(event){telemetryEvents.push(event)}}])
  const mount=()=>createSessionService({workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),contextOutput:output,telemetry,model,modelPolicy:'test-mock',approveAll:true,sandbox:'danger-full-access',codeMode:{mode:options.nestedCode?'only':'off'},contextWindow:100000,...options.promotion?{shellBackgroundAfterMs:1}:{},agentShell:()=>({id:'controlled',label:'controlled',command:'controlled',dialect:'posix'})})
  let service=mount()
  const listen=()=>subscribe(document.view,event=>{if(event.type==='exec/end')terminal.resolve();if(event.type==='agent/delivery-received'&&event.key.kind==='exec')receipt.resolve();if(event.type==='agent/input/promoted'&&event.inputId.startsWith('delivery-'))consumed.resolve()})
  let off=listen()
  return{root,get backend(){return backend},get coordinator(){return coordinator},get document(){return document},output,get service(){return service},requests:server.requests,issued:issued.promise,terminal:terminal.promise,receipt:receipt.promise,consumed:consumed.promise,recoveryHeld:recoveryHeld.promise,errors:()=>telemetryEvents.filter(event=>event.type==='session/error'),
    launches:()=>launches,cancels:()=>cancels,releases:()=>releases,refusals:()=>refusals,receiptKeys,admissionCaptures,admissionAttempts,releaseAdmissions:()=>{allowAdmissions=true},receiptPrepared:receiptPrepared.promise,receiptUnknown:receiptUnknown.promise,parentEntered:parentEntered.promise,promotionPrepared:promotionPrepared.promise,releasePromotion:()=>promotionGate.resolve(),debt:debt.promise,releaseDebt:()=>{recoveryReady=true},
    start:()=>service.submit('parent','run original command',new AbortController().signal),releaseRoot:()=>rootExit.resolve(),releaseIo:()=>io.resolve(),
    async checkpoint(){const assembly=await service.assemblyFor('parent');await assembly.managedDocument?.settleFinishedActions();return assembly},
    async requestOriginalCheckpoint(){if(!execSource)throw new Error('Missing original Exec source');await execSource.close()},
    journal:()=>readFile(join(journalRoot,'parent.jsonl')),
    releaseReceipt:()=>receiptGate.resolve(),releaseUnknownReceipt:()=>{allowReceipt=true},releaseParent:()=>parentGate.resolve(),
    async reopen(){off();await service.close();await coordinator.close();journalRoot=join(root,'sessions');backend=createJsonlBackend(journalRoot);coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);document=await coordinator.openManagedDocument('parent');off=listen();service=mount();await service.assemblyFor('parent')},
    /** Reopen the exact persisted pre-close cut. Graceful close durably stops
     * the original observation action; this controlled crash image retains its
     * still-open pending receipt without inventing events or claiming a kill. */
    async reopenPendingSnapshot(){
      const bytes=await readFile(join(journalRoot,'parent.jsonl'))
      const closing=service.close();promotionGate.resolve();await closing;off();await coordinator.close()
      const saved=join(root,'pending-crash-image');await cp(join(root,'sessions'),saved,{recursive:true});await writeFile(join(saved,'parent.jsonl'),bytes)
      journalRoot=saved;backend=createJsonlBackend(saved);coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);document=await coordinator.openManagedDocument('parent');off=listen();service=mount();await service.assemblyFor('parent');return bytes
    },
    async close(){allowAdmissions=true;recoveryReady=true;rootExit.resolve();io.resolve();receiptGate.resolve();parentGate.resolve();promotionGate.resolve();allowReceipt=true;off();const failures:unknown[]=[];for(const close of[()=>service.close(),()=>coordinator.close(),()=>output.close(),()=>server.close()])try{await close()}catch(cause){failures.push(cause)}if(failures.length){console.info('original-exec-cleanup-causes',inspect(failures,{depth:9}));throw new AggregateError(failures,'Original Exec fixture cleanup failed')}},
  }
}
