import {join} from 'node:path'
import {types} from 'node:util'
import {contextWorkspaceIdentity,contextOutputServiceRoot,contextSourceIdentity,contextPathKey as pathKey,type ContextOutputConfig,type ContextResultRef,type ContextAccess,type SeedDependencyTransferScope} from '@i-harness/context-output'
import {isStrictFactData,sameManagedArtifactRef,type ManagedArtifactRef,type BootstrapDependencyRequest,type BootstrapDependencyOutcome} from '@i-harness/core-session'
import {createCodeRetrievalService,type CodeRetrievalConfig,type CodeRetrievalOptions} from '@i-harness/code-retrieval'
import type {SessionCoordinator,BootstrapDependencyPort,BootstrapTargetPreparationPort} from '@i-harness/session-persistence'
import type {SessionProjectContext,ResultReadScopeResolver} from '@i-harness/session-executor'
import {createProcessAwareResultService} from '@i-harness/session-executor/internal/process-result-service'
import {lookupProcessReadContext} from '@i-harness/session-persistence/internal/process-read-context'
import {createNativeCodeSourceReader,type NativeReferenceSource} from './context-source-reader.ts'
import {captureBootstrapProject,type BootstrapProjectCapture,type BootstrapProjectPreparation} from './bootstrap-project.ts'

export async function createNativeContextRuntime(options:{
  workspace:string;storageRoot:string;coordinator:Pick<SessionCoordinator,'profile'|'onDocumentDeleted'>
  // A durable binding is independent of its currently confirmed scope. An
  // absent scope for a bound consumer is revoked authority, never unassigned.
  projectFor(sessionId:string):Promise<{projectId?:string;scope?:SessionProjectContext;revision?:string}>
  resultReadScopeFor?:ResultReadScopeResolver
  prepareBootstrapInheritance?(capture:BootstrapProjectCapture):BootstrapProjectPreparation
  contextConfig?:Partial<ContextOutputConfig>;codeConfig?:Partial<CodeRetrievalConfig>
  references?:NativeReferenceSource[]|((workspaceKey:string)=>NativeReferenceSource[]);resolveCredential?(ref:string):string|undefined
  visibleRefsFor?(sessionId:string):Promise<readonly (ContextResultRef|ManagedArtifactRef)[]>
  registerJob?:CodeRetrievalOptions['registerJob']
}) {
  const{canonical,workspaceKey}=await contextWorkspaceIdentity(options.workspace)
  const prepareProject=options.prepareBootstrapInheritance
  const humanSessionId=`native-index-human:${workspaceKey}`
  let references=structuredClone(typeof options.references==='function'?options.references(workspaceKey):options.references??[]),closed=false
  let timer:ReturnType<typeof setInterval>|undefined,refreshing:Promise<unknown>|undefined
  async function projectScope(sessionId:string){
    if(sessionId===humanSessionId)return undefined
    const {meta}=await options.coordinator.profile(sessionId)
    if(meta.archived)throw new Error('Native context session is archived')
    const selected=await options.projectFor(sessionId)
    if(selected.projectId && (!selected.scope || selected.scope.id!==selected.projectId))throw new Error('Native context project scope is not currently confirmed')
    return selected.scope
  }
  async function sourceFor(sessionId:string){
    const scope=await projectScope(sessionId)
    const sourceId=contextSourceIdentity(workspaceKey,canonical,scope)
    return{sourceId,readonly:true}
  }
  const bridge=createProcessAwareResultService({root:contextOutputServiceRoot(options.storageRoot),workspaceId:workspaceKey,config:options.contextConfig,
    coordinatorFor:()=>options.coordinator as SessionCoordinator,sourceFor,guardedRead,
    ...(options.coordinator.onDocumentDeleted?{documentDeletions:listener=>options.coordinator.onDocumentDeleted!((id,manifest)=>listener([id,...manifest.documents]))}:{}),
    genericVisible:async(sessionId,ref)=>Boolean((await options.visibleRefsFor?.(sessionId))?.some(visible=>'version' in visible&&sameManagedArtifactRef(visible,ref))),
    authorize:async(access,ref)=>{
      try{
        if(ref.workspaceId!==workspaceKey||!ref.source||(await sourceFor(access.sessionId)).sourceId!==ref.source.sourceId)return false
        return access.sessionId===ref.sessionId||Boolean((await options.visibleRefsFor?.(access.sessionId))?.some(visible=>!('version' in visible)&&visible.id===ref.id))
      }catch{return false}
    }})
  const contextOutput=bridge.service
  // The supplied service is Gateway's fast path. Capture broker currentness
  // around its real readers as source identity alone cannot detect ABA.
  async function guardedRead<T>(sessionId:string, operation:()=>Promise<T>):Promise<T>{
    const process=lookupProcessReadContext(options.coordinator as SessionCoordinator,sessionId)
    process?.assertCurrent()
    if(closed)throw new Error('Native context is closed')
    const getter=await options.resultReadScopeFor?.(sessionId)
    process?.assertCurrent()
    const captured=getter?.() ?? await options.projectFor(sessionId)
    process?.assertCurrent()
    const assertCurrent=async()=>{
      if(closed)throw new Error('Native context is closed')
      const {meta}=await options.coordinator.profile(sessionId)
      process?.assertCurrent()
      if(meta.archived)throw new Error('Native context session is archived')
      const current=getter?.() ?? await options.projectFor(sessionId)
      process?.assertCurrent()
      if(closed||current.revision!==captured.revision)throw new Error('Result read scope changed')
    }
    await assertCurrent()
    const page=await operation()
    await assertCurrent()
    return page
  }
  function prepareBootstrapTransfer(input:BootstrapProjectCapture,sourceAccess:ContextAccess|undefined):{targetPreparation:BootstrapTargetPreparationPort;dependencies:BootstrapDependencyPort;close():void}{
    if(closed||!prepareProject)throw new Error('Bootstrap project preparation unavailable')
    const capture=captureBootstrapProject(input)
    // ContextAccess carries a label and cancellation only. Capture its container
    // before awaiting, without executing accessors or adopting caller mutations.
    if(sourceAccess!==undefined){
      if(!sourceAccess||typeof sourceAccess!=='object'||types.isProxy(sourceAccess)||![Object.prototype,null].includes(Object.getPrototypeOf(sourceAccess)))throw new TypeError('Invalid bootstrap source access')
      const fields=Object.getOwnPropertyDescriptors(sourceAccess)
      if(!Object.hasOwn(fields,'sessionId')||Reflect.ownKeys(sourceAccess).some(key=>typeof key!=='string'||!['sessionId','signal'].includes(key))||Object.values(fields).some(field=>!field.enumerable||!('value' in field)))throw new TypeError('Invalid bootstrap source access fields')
      if(typeof sourceAccess.sessionId!=='string'||!sourceAccess.sessionId||sourceAccess.sessionId.length>256||/[\u0000-\u001f\u007f]/.test(sourceAccess.sessionId)||sourceAccess.signal!==undefined&&(types.isProxy(sourceAccess.signal)||!(sourceAccess.signal instanceof AbortSignal)))throw new TypeError('Invalid bootstrap source access')
      if(capture.sourceSessionId!==undefined&&capture.sourceSessionId!==sourceAccess.sessionId)throw new TypeError('Bootstrap source identity conflict')
    }
    const access=sourceAccess===undefined?undefined:Object.freeze({...sourceAccess})
    let active=true,manifestDigest:string|undefined,scope:SeedDependencyTransferScope|undefined
    const available=()=>active&&!closed&&capture.targetAvailable()
    const preparation=prepareProject({...capture,targetAvailable:available})
    const assertTargetCurrent=()=>{if(!available())throw new Error('Bootstrap transfer closed');preparation.targetPreparation.assertTargetCurrent()}
    // A manifest becomes admissible only after the real broker checked the
    // original invocation against the coordinator's retained reservation.
    const targetPreparation:BootstrapTargetPreparationPort={
      async confirm(request,current,facts){
        if(!available())return{kind:'blocked',reason:'unavailable'}
        if(!request||typeof request!=='object'||!isStrictFactData(request))return{kind:'blocked',reason:'conflict'}
        const digest=Object.getOwnPropertyDescriptor(request,'manifestDigest')?.value
        const result=await preparation.targetPreparation.confirm(request,current,facts)
        if(result.kind==='confirmed'){assertTargetCurrent();manifestDigest=digest}
        return result
      },
      async reconcile(request,facts){
        if(!available())return{kind:'blocked',reason:'unavailable'}
        if(!request||typeof request!=='object'||!isStrictFactData(request))return{kind:'blocked',reason:'conflict'}
        const digest=Object.getOwnPropertyDescriptor(request,'manifestDigest')?.value
        const result=await preparation.targetPreparation.reconcile(request,facts)
        if(result.kind==='confirmed'){assertTargetCurrent();manifestDigest=digest}
        return result
      },assertTargetCurrent,
    }
    const invoke=(request:BootstrapDependencyRequest,current?:()=>boolean):Promise<BootstrapDependencyOutcome>=>{
      try{
        if(!active||closed)return Promise.resolve({kind:'blocked',reason:'unavailable'})
        if(!isStrictFactData(request)||!request||request.operationId!==capture.invocation.operationId||request.targetSessionId!==capture.invocation.targetSessionId||request.manifestDigest!==manifestDigest
          ||capture.sourceSessionId!==undefined&&request.sourceSessionId!==capture.sourceSessionId||access!==undefined&&request.sourceSessionId!==access.sessionId)return Promise.resolve({kind:'blocked',reason:'conflict'})
        if(current!==undefined&&(!access||capture.sourceSessionId!==access.sessionId))return Promise.resolve({kind:'blocked',reason:'policy'})
        assertTargetCurrent()
        scope??=contextOutput.registerSeedDependencyTransfer({
          binding:{operationId:request.operationId,manifestDigest:request.manifestDigest,sourceSessionId:request.sourceSessionId,targetSessionId:request.targetSessionId,targetDocumentId:request.targetSessionId},
          // Without original access this registration is permanently PASSIVE.
          // The coordinator's original label does not recreate source authority.
          sourceAccess:access??{sessionId:request.sourceSessionId},
          sourceAvailable:()=>Boolean(access)&&active&&!closed&&capture.sourceAvailable(),
          assertSourceCurrent(){if(!access||!active||closed)throw new Error('Bootstrap source unavailable');preparation.assertSourceCurrent()},
          targetAvailable:available,assertTargetCurrent,
          targetScope(){assertTargetCurrent();const target=preparation.targetScope();return{source:{sourceId:contextSourceIdentity(workspaceKey,canonical,target.scope),readonly:true},revision:target.revision}},
        })
        return current===undefined?contextOutput.reconcileSeedDependencies(scope,request):contextOutput.confirmSeedDependencies(scope,request,current)
      }catch{return Promise.resolve({kind:'blocked',reason:'policy'})}
    }
    return{targetPreparation,dependencies:{confirm:(request,current)=>typeof current==='function'?invoke(request,current):Promise.resolve({kind:'blocked',reason:'conflict'}),reconcile:request=>invoke(request)},close(){active=false;preparation.close()}}
  }
  let codeRetrieval:ReturnType<typeof createCodeRetrievalService>
  const reader=createNativeCodeSourceReader({workspace:canonical,references:()=>references,config:()=>codeRetrieval.status().config,
    authorize:async(actor,sourceId)=>{
      if(closed)return false
      try{
        const scope=await projectScope(actor)
        if(scope&&!scope.roots.some(root=>pathKey(root)===pathKey(canonical)))return false
        return sourceId==='workspace'||references.some(ref=>ref.id===sourceId)
      }catch{return false}
    }})
  codeRetrieval=createCodeRetrievalService({root:join(options.storageRoot,'code-retrieval'),workspaceId:workspaceKey,reader,config:options.codeConfig,resolveCredential:options.resolveCredential,registerJob:options.registerJob})
  async function autoRefresh(){
    const status=codeRetrieval.status()
    if(closed||refreshing||!status.enabled||!status.config.autoRefresh||status.activeJobs)return
    const work=(async()=>{const{jobId}=await codeRetrieval.startIndex({sessionId:humanSessionId});await codeRetrieval.wait(jobId)})()
    refreshing=work
    try{await work}catch{/* The service preserves job error/outcome for its UI. */}finally{if(refreshing===work)refreshing=undefined}
  }
  return{workspaceId:workspaceKey,workspaceKey,humanSessionId,contextOutput,codeRetrieval,sourceFor,prepareBootstrapTransfer,
    async configureReferences(next:NativeReferenceSource[]){
      if(JSON.stringify(references)===JSON.stringify(next))return
      // Visibility changes before awaiting drainage, so old snippets cannot
      // borrow a superseded source binding during the transition.
      references=structuredClone(next)
      await codeRetrieval.cancel();await codeRetrieval.clear()
    },
    async inheritFork(parentId:string,targetId:string,refs:readonly (ContextResultRef|ManagedArtifactRef)[]){
      const target=(await options.coordinator.profile(targetId)).meta
      if(target.parentSession!==parentId)throw new Error('Native reference target is not this fork')
      for(const ref of refs){
        if('expiresAt' in ref&&ref.expiresAt<=Date.now())continue
        try{await contextOutput.grant({sessionId:parentId},[ref.id],targetId)}catch(error){
          const message=error instanceof Error?error.message:''
          if(/unavailable|expired|not found|unknown reference|not readable|not authorized/i.test(message))continue
          throw error
        }
      }
    },
    syncAutoRefresh(){
      const active=!closed&&codeRetrieval.status().enabled&&codeRetrieval.status().config.autoRefresh
      if(!active&&timer){clearInterval(timer);timer=undefined}
      if(active&&!timer){timer=setInterval(()=>{void autoRefresh()},30000);timer.unref?.();void autoRefresh()}
    },
    async close(){
      if(closed)return;closed=true;bridge.retireBridge();if(timer)clearInterval(timer)
      await codeRetrieval.cancel();await refreshing
      await Promise.all([contextOutput.close(),codeRetrieval.close()])
    },
  }
}
