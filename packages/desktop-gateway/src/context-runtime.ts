import {inspectTaskChildSource,inspectManagedTaskChildSource,isManagedTaskChildHistory,assertOriginalTeamChildHostRequest,assertOriginalColdTeamChildHostRequest,isOriginalColdTeamChildHostInput} from '@i-harness/subagent'
import {join} from 'node:path'
import {AsyncLocalStorage} from 'node:async_hooks'
import {types} from 'node:util'
import {contextWorkspaceIdentity,contextOutputServiceRoot,contextSourceIdentity,contextPathKey as pathKey,type ContextOutputConfig,type ContextResultRef,type ContextAccess,type SeedDependencyTransferScope,type SeedDependencyHostAccess,type LegacyReadObservationRunner} from '@i-harness/context-output'
import {canonicalJsonData,isStrictFactData,freezeJsonData,EMPTY_SEMANTIC_DEPENDENCY_DIGEST,sameManagedArtifactRef,semanticSeedResultRefs,managedResultRefs,rewindCuts,type ManagedArtifactRef,type BootstrapDependencyRequest,type BootstrapDependencyOutcome} from '@i-harness/core-session'
import {createCodeRetrievalService,type CodeRetrievalConfig,type CodeRetrievalOptions} from '@i-harness/code-retrieval'
import type {SessionCoordinator,BootstrapDependencyPort,BootstrapTargetPreparationPort,ExistingSessionBindingObservation} from '@i-harness/session-persistence'
import {createResultObservationScope,createLegacyReadObservationRunner,type ResultObservationCapture,type SessionProjectContext,type ResultReadScopeResolver} from '@i-harness/session-executor'
import {createProcessAwareResultService} from '@i-harness/session-executor/internal/process-result-service'
import {lookupProcessReadContext} from '@i-harness/session-persistence/internal/process-read-context'
import {originalResultOrderingFor} from '@i-harness/session-persistence/internal/result-ordering'
import {originalDeletionPreparationAvailable} from '@i-harness/session-persistence/internal/deletion-preparation'
import {createNativeCodeSourceReader,type NativeReferenceSource} from './context-source-reader.ts'
import {captureBootstrapProject,type BootstrapProjectCapture,type BootstrapProjectPreparation} from './bootstrap-project.ts'
import {captureTaskChildProject,type TaskChildProjectCapture} from './bootstrap-project.ts'
import {hasSelectedSource,selectedSourceFor,createSelectedRuntimeCapture,inspectSelectedTarget} from '@i-harness/session-persistence/internal/selected-source-owner'
import {discoverResultLineage,assertResultLineage,legacyObservationFor} from '../../session-executor/src/lifecycle/result-observation.ts'
import type {createProjectScopeBroker} from './project-scope.ts'
import {readSelectedResultsOperation} from '../../session-persistence/src/selected-results-fork-contract.ts'
import {assertSelectedResultsNodeAdmission} from '../../session-persistence/src/selected-results-node-admission.ts'
import {createCompletedPassiveContext} from '@i-harness/core-session/internal/bootstrap'
import {exportSelectedResultsConversationSeed} from '../../core-session/src/conversation/seed-export.ts'
import {compileSelectedResultsSemanticSeed} from '../../session-persistence/src/semantic-seed.ts'
const selectedSignalAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!
const selectedAborted=(signal?:AbortSignal)=>signal===undefined?false:types.isProxy(signal)?(()=>{throw TypeError('Invalid selected signal')})():Reflect.apply(selectedSignalAborted,signal,[]) as boolean

interface NativeContextOptions {
  workspace:string;storageRoot:string
  // A durable binding is independent of its currently confirmed scope. An
  // absent scope for a bound consumer is revoked authority, never unassigned.
  projectFor(sessionId:string):Promise<{projectId?:string;scope?:SessionProjectContext;revision?:string}>
  resultReadScopeFor?:ResultReadScopeResolver
  prepareBootstrapInheritance?(capture:BootstrapProjectCapture):BootstrapProjectPreparation
  prepareTaskChildInheritance?(capture:TaskChildProjectCapture):BootstrapProjectPreparation
  contextConfig?:Partial<ContextOutputConfig>;codeConfig?:Partial<CodeRetrievalConfig>
  references?:NativeReferenceSource[]|((workspaceKey:string)=>NativeReferenceSource[]);resolveCredential?(ref:string):string|undefined
  visibleRefsFor?(sessionId:string):Promise<readonly (ContextResultRef|ManagedArtifactRef)[]>
  hasVisibleResultRef?(sessionId:string,ref:ContextResultRef|ManagedArtifactRef):Promise<boolean|undefined>
  registerJob?:CodeRetrievalOptions['registerJob']
  prepareSelectedInheritance?:ReturnType<typeof createProjectScopeBroker>['prepareSelectedInheritance']
  retainSelectedProjectRead?:ReturnType<typeof createProjectScopeBroker>['retainSelectedBindingRead']
}
type ObservedBindings = {
  coordinator:Pick<SessionCoordinator,'profile'|'onDocumentDeleted'|'openManagedDocument'|'withExistingSessionBindingObservation'>
  resultReadScopeFor:ResultReadScopeResolver
  withBindingObservation<T>(ids:readonly string[],observation:ExistingSessionBindingObservation,use:()=>Promise<T>):Promise<T>
}
type ProfileOnlyBindings = {coordinator:Pick<SessionCoordinator,'profile'|'onDocumentDeleted'>;withBindingObservation?:undefined}
export async function createNativeContextRuntime(options:NativeContextOptions & (ObservedBindings|ProfileOnlyBindings)) {
  const{canonical,workspaceKey}=await contextWorkspaceIdentity(options.workspace)
  const prepareProject=options.prepareBootstrapInheritance
  const humanSessionId=`native-index-human:${workspaceKey}`
  let references=structuredClone(typeof options.references==='function'?options.references(workspaceKey):options.references??[]),closed=false
  let timer:ReturnType<typeof setInterval>|undefined,refreshing:Promise<unknown>|undefined
  const observations=createResultObservationScope()
  const assertAvailable=()=>{if(closed)throw new Error('Native context is closed')}
  const canonicalSource=(get:()=>import('@i-harness/session-executor').ResultReadScope)=>{
    assertAvailable();const selected=get()
    if(selected.projectId&&selected.scope?.id!==selected.projectId)throw new Error('Native context project scope is not confirmed')
    return{sourceId:contextSourceIdentity(workspaceKey,canonical,selected.scope),readonly:true}
  }
  async function withResultObservation<T>(capture:Omit<ResultObservationCapture,'currentSource'>,use:()=>Promise<T>):Promise<T>{
    assertAvailable()
    if(!options.withBindingObservation)throw new Error('Native context binding observation unavailable')
    return options.withBindingObservation(capture.sessionIds,capture.observation,async()=>{
      const getter=await options.resultReadScopeFor(capture.sessionId)
      if(!getter)throw new Error('Observed native result scope unavailable')
      return observations.run({...capture,currentSource:()=>canonicalSource(getter),assertHostCurrent(){assertAvailable();capture.assertHostCurrent()}},use)
    })
  }
  const withLegacyReadObservation:LegacyReadObservationRunner=async(access,use)=>{
    assertAvailable()
    if(!options.withBindingObservation)throw new Error('Native context binding observation unavailable')
    const captured=options
    let getter:(()=>import('@i-harness/session-executor').ResultReadScope)|undefined
    return createLegacyReadObservationRunner({coordinator:captured.coordinator,observations,assertHostCurrent:assertAvailable,
      resolveSource:async()=>()=>{if(!getter)throw new Error('Observed native result scope unavailable');return canonicalSource(getter)},
      withBindingObservation:(ids,observation,run)=>captured.withBindingObservation(ids,observation,async()=>{
        getter=await captured.resultReadScopeFor(access.sessionId)
        if(!getter)throw new Error('Observed native result scope unavailable')
        return run()
      }),
    })(access,use)
  }
  async function projectScope(sessionId:string){
    if(sessionId===humanSessionId)return undefined
    const {meta}=await options.coordinator.profile(sessionId)
    if(meta.archived)throw new Error('Native context session is archived')
    const selected=await options.projectFor(sessionId)
    if(selected.projectId && (!selected.scope || selected.scope.id!==selected.projectId))throw new Error('Native context project scope is not currently confirmed')
    return selected.scope
  }
  async function sourceFor(sessionId:string){
    const observed=observations.current(sessionId)
    if(observed){assertAvailable();const source=observed.source;observed.assertCurrent();return source}
    const scope=await projectScope(sessionId)
    const sourceId=contextSourceIdentity(workspaceKey,canonical,scope)
    return{sourceId,readonly:true}
  }
  const originalLegacyReads=new WeakMap<import('@i-harness/context-output').LegacyReadObservation,{document:import('@i-harness/session-persistence').ManagedDocument;view:import('@i-harness/core-session').SessionView}>()
  const ordering=originalResultOrderingFor(options.coordinator as SessionCoordinator)
  const bridge=createProcessAwareResultService({root:contextOutputServiceRoot(options.storageRoot),workspaceId:workspaceKey,config:options.contextConfig,requireObservedLegacyRecipients:true,
    coordinatorFor:()=>options.coordinator as SessionCoordinator,originalLegacySourceFor(observation){return originalLegacyReads.get(observation)},...(ordering?{orderingCoordinators:[options.coordinator as SessionCoordinator]}:{}),sourceFor,guardedRead,
    ...(options.coordinator.onDocumentDeleted&&!(ordering&&originalDeletionPreparationAvailable(options.coordinator as SessionCoordinator))?{documentDeletions:listener=>options.coordinator.onDocumentDeleted!((id,manifest)=>listener([id,...manifest.documents]))}:{}),
    genericVisible:async(sessionId,visibleRef)=>{
        const observed=observations.current(sessionId)
        if(observed){
          observed.assertCurrent();if(observed.kind==='managed-task')return observed.artifacts.some(artifact=>sameManagedArtifactRef(artifact.ref,visibleRef));const view=observed.view,cuts=rewindCuts(view)
          return semanticSeedResultRefs(view).some(ref=>sameManagedArtifactRef(ref,visibleRef))
            ||view.events.some(event=>!cuts.some(cut=>event.seq!==undefined&&event.seq>=cut.cutFrom&&event.seq<cut.markerSeq)&&managedResultRefs(event).some(ref=>sameManagedArtifactRef(ref,visibleRef)))
        }
        const owned=await options.hasVisibleResultRef?.(sessionId,visibleRef)
        if(owned!==undefined)return owned
        return Boolean((await options.visibleRefsFor?.(sessionId))?.some(visible=>'version' in visible&&sameManagedArtifactRef(visible,visibleRef)))
    },
    authorize:async(access,ref)=>{
      try{
        if(ref.workspaceId!==workspaceKey||!ref.source||(await sourceFor(access.sessionId)).sourceId!==ref.source.sourceId)return false
        const observed=observations.current(access.sessionId)
        if(observed){observed.assertCurrent();return true}
        if(access.sessionId===ref.sessionId)return true
        const owned=await options.hasVisibleResultRef?.(access.sessionId,ref)
        return owned!==undefined?owned:Boolean((await options.visibleRefsFor?.(access.sessionId))?.some(visible=>!('version' in visible)&&visible.id===ref.id))
      }catch{return false}
    }})
  const contextOutput=bridge.service
  const selectedSources=new Set<{close():Promise<void>;revoke():void}>()
  const selectedAcquisitions=new Set<Promise<unknown>>()
  const selectedCleanupDebt=new Set<{retry():Promise<void>}>()
  const selectedContext=new AsyncLocalStorage<readonly {active:boolean}[]>()
  async function selectedWork<T>(work:()=>Promise<T>):Promise<T>{const entry={active:true};try{return await selectedContext.run([...(selectedContext.getStore()??[]),entry],work)}finally{entry.active=false}}
  let closeFlight:Promise<void>|undefined,disposed=false,cancelled=false,coreClosed=false,codeClosed=false
  function acquireSelectedSourceObservation(sessionId:string) {
    assertAvailable();if(selectedCleanupDebt.size)throw Error('Selected source cleanup unresolved');const flight=Promise.resolve().then(()=>selectedWork(()=>acquireSelectedSource(sessionId)));selectedAcquisitions.add(flight)
    void flight.finally(()=>selectedAcquisitions.delete(flight)).catch(()=>{});return flight
  }
  async function acquireSelectedSource(sessionId:string) {
    assertAvailable();if(selectedCleanupDebt.size)throw Error('Selected source cleanup unresolved');if(!options.retainSelectedProjectRead)throw Error('Selected source unavailable')
    const coordinator=options.coordinator as SessionCoordinator
    if(!hasSelectedSource(coordinator))throw Object.assign(new Error('Selected results are unavailable on this session store'),{code:'SELECTED_RESULTS_UNSUPPORTED'})
    const original=selectedSourceFor(coordinator)
    await coordinator.flush(sessionId);assertAvailable();if(selectedCleanupDebt.size)throw Error('Selected source cleanup unresolved');const document=await coordinator.openManagedDocument(sessionId);assertAvailable();if(selectedCleanupDebt.size)throw Error('Selected source cleanup unresolved')
    let binding:Awaited<ReturnType<typeof original.acquire>>|undefined,revoked=false
    const witness=original.retain(document,()=>{revoked=true;binding?.revoke()})
    const current=()=>{assertAvailable();if(selectedCleanupDebt.size)throw Error('Selected source cleanup unresolved');if(revoked)throw Error('Selected source revoked');witness.assertCurrent();binding?.assertCurrent()}
    try{
      const ids=await discoverResultLineage(coordinator,sessionId,current);current()
      binding=await original.acquire({sessionIds:ids});current();assertResultLineage(binding.observation,ids,sessionId)
      const project=await options.retainSelectedProjectRead(ids,binding,sessionId);current()
      const result=observations.retainSelected({sessionId,sessionIds:ids,observation:binding.observation,document,currentSource(){return canonicalSource(project.sourceGetter)},assertHostCurrent(){current();project.assertCurrent()}})
      let metadata:Awaited<ReturnType<typeof bridge.acquireSelectedMetadata>>|undefined
      let metadataCleanup:ReturnType<typeof bridge.selectedMetadataCleanupFor>
      project.attachResult({revoke(){result.revoke();metadata?.revoke()},async close(){if(metadataCleanup){await metadataCleanup.retry();metadataCleanup=undefined}if(metadata)await metadata.close();await result.close();witness.unsubscribe()}})
      await project.use(()=>result.use(async()=>{const originalRead=legacyObservationFor(result.observation);originalLegacyReads.set(originalRead,{document,view:result.observation.view});try{metadata=await bridge.acquireSelectedMetadata(originalRead)}catch(error){metadataCleanup=bridge.selectedMetadataCleanupFor(error);throw error}current()}));current()
      const retained=metadata!
      const uses=new AsyncLocalStorage<{active:boolean}>()
      const useCurrent=()=>{if(!uses.getStore()?.active)throw Error('Selected source use expired');current();retained.assertCurrent()}
      const inherited=Object.freeze({assertCurrent:useCurrent,legacy(){useCurrent();const iterator=retained.reader.legacy()[Symbol.asyncIterator]();return {[Symbol.asyncIterator](){return this},async next(){useCurrent();const value=await iterator.next();useCurrent();return value},async return(){return iterator.return?iterator.return():{done:true as const,value:undefined}}}}})
      const projectId=project.sourceGetter().projectId
      const source=Object.freeze({document,view:witness.view,inherited,projectId,assertCurrent(){current();project.assertCurrent();result.assertCurrent();retained.assertCurrent()},use<T>(work:()=>Promise<T>){const entry={active:true};return selectedWork(()=>project.use(()=>result.use(()=>uses.run(entry,async()=>{try{return await work()}finally{entry.active=false}}))))},revoke(){binding!.revoke()},async close(){await project.close();selectedSources.delete(source)}})
      selectedSources.add(source);return source
    }catch(error){
      binding?.revoke();let failure=error
      if(binding)try{await binding.release()}catch(cleanup){failure=cleanup}
      const originalCleanup=original.cleanupForError(failure)
      if(originalCleanup){const debt={async retry(){await originalCleanup.retry();witness.unsubscribe();selectedCleanupDebt.delete(debt)}};selectedCleanupDebt.add(debt)}
      else witness.unsubscribe()
      throw failure
    }
  }
  const selectedOperations=new Map<string,string>()
  function makeSelectedSourceOperation(input:unknown,target:object) {
    assertAvailable();assertSelectedResultsNodeAdmission(input);const operation=readSelectedResultsOperation(input),key=operation.invocation.operationId,encoded=JSON.stringify(operation)
    if(selectedOperations.has(key))throw Error('Selected operation already owned');selectedOperations.set(key,encoded)
    let original:Awaited<ReturnType<typeof acquireSelectedSourceObservation>>|undefined,firstStarted=false,retired=false,active:Promise<unknown>|undefined
    let captureSlot:{source:NonNullable<typeof original>;assertCurrent():void}|undefined
    const capture=async()=>{const slot=captureSlot;if(!slot)throw Error('Selected source handoff unavailable');slot.assertCurrent();const context=createCompletedPassiveContext({kind:'held-public-fork',sourceSessionId:operation.prepared.core.sourceSessionId,view:slot.source.view,factOwner:slot.source.document,assertCurrent:slot.assertCurrent},operation.prepared.core.selection);if(context.kind!=='ready')throw Error('Selected source unavailable');const exported=await exportSelectedResultsConversationSeed(context.context,slot.source.inherited);slot.assertCurrent();if(exported.kind!=='seed')throw Error('Selected source export refused');return {invocation:operation.invocation,target:{kind:'new'},metadata:operation.prepared.core.metadata,lineage:{origin:'fork',parentSession:operation.prepared.core.sourceSessionId},seed:compileSelectedResultsSemanticSeed(exported)}}
    const handoffs=new AsyncLocalStorage<{active:boolean}>()
    const available=()=>{assertAvailable();if(retired)throw Error('Selected operation retired')}
    const sourceHandoff=async<T>(source:NonNullable<typeof original>,work:(handoff:{source:{sourceSessionId:string;document:typeof source.document;view:typeof source.view;events:typeof source.view.events;eventCount:number;inherited:typeof source.inherited};assertCurrent():void})=>Promise<T>,signal?:AbortSignal)=>{
      available();if(selectedAborted(signal))throw Error('Selected handoff cancelled');source.assertCurrent();const expected=operation.prepared.requestIntent.project;if(expected.kind==='project'&&source.projectId!==expected.projectId||expected.kind!=='project'&&source.projectId!==undefined)throw Error('Selected project mismatch')
      const entry={active:true},guard=()=>{available();if(!entry.active||selectedAborted(signal))throw Error('Selected handoff expired');source.assertCurrent()}
      const held=Object.freeze({sourceSessionId:operation.prepared.core.sourceSessionId,document:source.document,view:source.view,events:source.view.events,eventCount:source.view.events.length,inherited:source.inherited})
      // One immutable handle is retained across all handoffs.
      const stable=holderSource??(holderSource=held)
      return source.use(()=>handoffs.run(entry,async()=>{try{guard();captureSlot={source,assertCurrent:guard};const value=await work({source:stable,assertCurrent:guard});guard();return value}finally{captureSlot=undefined;entry.active=false}}))
    }
    let projectPreparation:ReturnType<NonNullable<NativeContextOptions['prepareSelectedInheritance']>>|undefined,managedScope:SeedDependencyTransferScope|undefined,legacyTransfer:ReturnType<typeof bridge.acquireSelectedLegacyTransfer>|undefined
    let holderSource:Parameters<Parameters<typeof sourceHandoff>[1]>[0]['source']|undefined
    const single=<T>(run:()=>Promise<T>):Promise<T>=>{available();if(active)throw Error('Selected handoff already active');const flight=Promise.resolve().then(run);active=flight;void flight.finally(()=>{if(active===flight)active=undefined}).catch(()=>{});return flight}
    const holder=Object.freeze({
      first<T>(work:Parameters<typeof sourceHandoff<T>>[1],signal?:AbortSignal){return single(async()=>{if(firstStarted)throw Error('Selected first handoff already entered');if(selectedAborted(signal))throw Error('Selected handoff cancelled');const source=await acquireSelectedSourceObservation(operation.prepared.core.sourceSessionId);original=source;firstStarted=true;if(retired||closed){await source.close();throw Error('Selected operation retired')}return sourceHandoff(source,work,signal)})},
      warm<T>(work:Parameters<typeof sourceHandoff<T>>[1],signal?:AbortSignal){return single(async()=>{if(!original)throw Error('Original selected source unavailable');return sourceHandoff(original,work,signal)})},
      passive<T>(work:(handoff:{assertCurrent():never})=>Promise<T>){return single(()=>{const entry={active:true};return handoffs.run(entry,async()=>{try{return await work({assertCurrent():never{throw Error('Passive selected handoff cannot issue')}})}finally{entry.active=false}})})},
      exportOnceInCurrentUse:capture,
      async confirmTarget(){
        if(!options.prepareSelectedInheritance)throw Error('Selected project preparation unavailable')
        const slot=captureSlot;if(!slot)throw Error('Selected source handoff unavailable');slot.assertCurrent()
        const inspection=inspectSelectedTarget(options.coordinator as SessionCoordinator,target)
        projectPreparation??=options.prepareSelectedInheritance({operation,target,sourceAvailable:()=>{try{if(!captureSlot)return false;captureSlot.assertCurrent();return true}catch{return false}},assertNewWorkCurrent:()=>{if(!captureSlot)throw Error('Selected source handoff unavailable');captureSlot.assertCurrent()},targetAvailable:()=>{try{available();inspectSelectedTarget(options.coordinator as SessionCoordinator,target);return true}catch{return false}}})
        const result=await projectPreparation.confirm(inspection.facts,()=>{try{slot.assertCurrent();return true}catch{return false}})
        slot.assertCurrent();inspectSelectedTarget(options.coordinator as SessionCoordinator,target);return result
      },
      async confirmManagedDependencies(){
        const slot=captureSlot;if(!slot||!projectPreparation)throw Error('Selected target preparation unavailable');slot.assertCurrent()
        const inspection=inspectSelectedTarget(options.coordinator as SessionCoordinator,target),manifest=inspection.seed.records[0]
        if(!manifest||manifest.type!=='conversation/seed-manifest')throw Error('Selected seed unavailable')
        projectPreparation.assertTargetCurrent()
        if(!manifest.artifacts.length)return {kind:'confirmed' as const,closureDigest:EMPTY_SEMANTIC_DEPENDENCY_DIGEST}
        const request={operationId:operation.invocation.operationId,targetSessionId:operation.invocation.targetSessionId,manifestDigest:inspection.manifestDigest,sourceSessionId:operation.prepared.core.sourceSessionId,artifacts:manifest.artifacts}
        const assertSourceCurrent=()=>{if(!captureSlot)throw Error('Selected source handoff unavailable');captureSlot.assertCurrent()}
        const assertTargetCurrent=()=>{available();inspectSelectedTarget(options.coordinator as SessionCoordinator,target);projectPreparation!.assertTargetCurrent()}
        managedScope??=contextOutput.registerSeedDependencyTransfer({binding:{operationId:request.operationId,manifestDigest:request.manifestDigest,sourceSessionId:request.sourceSessionId,targetSessionId:request.targetSessionId,targetDocumentId:request.targetSessionId},sourceAccess:{sessionId:request.sourceSessionId},sourceAvailable:()=>{try{assertSourceCurrent();return true}catch{return false}},assertSourceCurrent,targetAvailable:()=>{try{assertTargetCurrent();return true}catch{return false}},assertTargetCurrent,targetScope(){assertTargetCurrent();const selected=projectPreparation!.targetScope();return{source:{sourceId:contextSourceIdentity(workspaceKey,canonical,selected.scope),readonly:true},revision:selected.revision}}},'original-publication')
        const result=await contextOutput.confirmSeedDependencies(managedScope,request,()=>{try{assertSourceCurrent();return true}catch{return false}})
        slot.assertCurrent();assertTargetCurrent();return result
      },
      async confirmLegacyDependencies(){
        const slot=captureSlot;if(!slot||!projectPreparation)throw Error('Selected target preparation unavailable');slot.assertCurrent()
        const inspection=inspectSelectedTarget(options.coordinator as SessionCoordinator,target)
        projectPreparation.assertTargetCurrent()
        const assertSourceCurrent=()=>{if(!captureSlot||captureSlot.source!==slot.source)throw Error('Original selected source unavailable');captureSlot.assertCurrent()}
        const assertTargetCurrent=()=>{available();inspectSelectedTarget(options.coordinator as SessionCoordinator,target);projectPreparation!.assertTargetCurrent()}
        if(!legacyTransfer){
          const targetView=freezeJsonData({formatVersion:inspection.stage.headerBase.formatVersion,header:JSON.parse(inspection.stage.headerBytes),events:inspection.seed.records}) as import('@i-harness/core-session').SessionView
          legacyTransfer=bridge.acquireSelectedLegacyTransfer(options.coordinator as SessionCoordinator,target,{invocation:operation.invocation,sourceSessionId:operation.prepared.core.sourceSessionId,facts:inspection.facts,targetView,
            target:{available:()=>{try{assertTargetCurrent();return true}catch{return false}},assertCurrent:assertTargetCurrent,sourceId:()=>{assertTargetCurrent();return contextSourceIdentity(workspaceKey,canonical,projectPreparation!.targetScope().scope)}},
            source:{view:slot.source.view,assertCurrent:assertSourceCurrent,read(){assertSourceCurrent();const observation=observations.current(operation.prepared.core.sourceSessionId);if(!observation||observation.kind!=='public'||observation.view!==slot.source.view)throw Error('Original result observation unavailable');return legacyObservationFor(observation)}}})
        }
        const result=await legacyTransfer.confirm();slot.assertCurrent();assertTargetCurrent();return result
      },
      async reconcileLegacyDependencies(){if(!legacyTransfer)return undefined;if(!projectPreparation)throw Error('Selected target preparation unavailable');available();inspectSelectedTarget(options.coordinator as SessionCoordinator,target);projectPreparation.assertTargetCurrent();return legacyTransfer.reconcile()},
      assertTargetCurrent(){if(!projectPreparation||!legacyTransfer)throw Error('Selected target preparation unavailable');available();inspectSelectedTarget(options.coordinator as SessionCoordinator,target);projectPreparation.assertTargetCurrent();legacyTransfer.assertCurrent()},
      assertOutsideUse(){if(handoffs.getStore()?.active)throw Error('Selected handoff self-close')},
      async drain(){if(handoffs.getStore()?.active)throw Error('Selected handoff self-close');if(active)await active.catch(()=>{})},
      revoke(){retired=true;original?.revoke()},
      async close(){if(handoffs.getStore()?.active)throw Error('Selected handoff self-close');retired=true;original?.revoke();if(active)await active.catch(()=>{});if(legacyTransfer)await legacyTransfer.close();projectPreparation?.close();if(original)await original.close()},
    })
    return holder
  }
  let selectedComposer:ReturnType<typeof createSelectedRuntimeCapture>|undefined
  try{selectedSourceFor(options.coordinator as SessionCoordinator);selectedComposer=createSelectedRuntimeCapture(options.coordinator as SessionCoordinator,makeSelectedSourceOperation)}catch{}
  const createSelectedSourceHolder=(input:unknown)=>{assertSelectedResultsNodeAdmission(input);if(!selectedComposer)throw Error('Selected source unavailable');return selectedComposer.create(input)}
  // The supplied service is Gateway's fast path. Capture broker currentness
  // around its real readers as source identity alone cannot detect ABA.
  async function guardedRead<T>(sessionId:string, operation:()=>Promise<T>):Promise<T>{
    const process=lookupProcessReadContext(options.coordinator as SessionCoordinator,sessionId)
    process?.assertCurrent()
    if(closed)throw new Error('Native context is closed')
    const observed=observations.current(sessionId)
    if(observed){observed.assertCurrent();const page=await operation();assertAvailable();process?.assertCurrent();observed.assertCurrent();return page}
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
  function prepareBootstrapTransfer(input:BootstrapProjectCapture,sourceAccess:ContextAccess|undefined):{targetPreparation:BootstrapTargetPreparationPort;dependencies:BootstrapDependencyPort;targetScope:BootstrapProjectPreparation['targetScope'];close():void}{
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
    return{targetPreparation,dependencies:{confirm:(request,current)=>typeof current==='function'?invoke(request,current):Promise.resolve({kind:'blocked',reason:'conflict'}),reconcile:request=>invoke(request)},
      targetScope(){assertTargetCurrent();return preparation.targetScope()},close(){active=false;preparation.close()}}
  }
  function captureCoherentProject(preparation:BootstrapProjectPreparation):((mode:'active'|'passive')=>import('./bootstrap-project.ts').BootstrapTargetScope)|undefined {
    if(!preparation||typeof preparation!=='object'||types.isProxy(preparation)||![Object.prototype,null].includes(Object.getPrototypeOf(preparation)))throw Error('Invalid task project preparation')
    const descriptors=Object.getOwnPropertyDescriptors(preparation),kind=descriptors.kind
    if(!kind)return
    const keys=['kind','targetPreparation','targetScope','assertSourceCurrent','close','observeCurrent']
    if(Reflect.ownKeys(preparation).length!==keys.length||keys.some(key=>!descriptors[key]?.enumerable||!('value'in descriptors[key]!))||kind.value!=='coherent-project-observation-v1'||typeof descriptors.observeCurrent!.value!=='function'||types.isProxy(descriptors.observeCurrent!.value))throw Error('Invalid coherent task project preparation')
    const observer=descriptors.observeCurrent!.value as (mode:'active'|'passive')=>import('./bootstrap-project.ts').BootstrapTargetScope
    const check=()=>{if(Reflect.ownKeys(preparation).length!==keys.length)throw Error('Coherent project preparation changed');for(const key of keys){const before=descriptors[key]!,after=Object.getOwnPropertyDescriptor(preparation,key);if(!after||!('value'in after)||after.value!==before.value||after.enumerable!==before.enumerable||after.configurable!==before.configurable||after.writable!==before.writable)throw Error('Coherent project preparation changed')}}
    return mode=>{check();const value=Reflect.apply(observer,preparation,[mode]);check();return value}
  }
  const originalTaskSources=new WeakSet<object>()
  function prepareTaskChildTransfer(input:TaskChildProjectCapture,source?:{artifacts:ReturnType<typeof inspectTaskChildSource>['artifacts'];assertCurrent():void;access():ContextAccess;release():Promise<void>;use<T>(work:()=>Promise<T>):Promise<T>}){
    if(closed||!options.prepareTaskChildInheritance||source&&!originalTaskSources.has(source))throw Error('Original task project preparation unavailable')
    const captured=captureTaskChildProject(input),preparation=options.prepareTaskChildInheritance(input),observeProject=captureCoherentProject(preparation)
    let active=true,manifestDigest:string|undefined,scope:SeedDependencyTransferScope|undefined,closureDigest:string|undefined
    const available=()=>active&&!closed&&captured.targetAvailable()
    const assertTargetCurrent=()=>{if(!available())throw Error('Original task target retired');preparation.targetPreparation.assertTargetCurrent()}
    const assertCurrent=()=>{if(!available()||!captured.sourceAvailable())throw Error('Original task project retired');captured.assertNewWorkCurrent();source?.assertCurrent()}
    const targetPreparation:BootstrapTargetPreparationPort={
      async confirm(request,current,facts){const result=await preparation.targetPreparation.confirm(request,current,facts);if(result.kind==='confirmed'){assertTargetCurrent();manifestDigest=request.manifestDigest}return result},
      async reconcile(request,facts){const result=await preparation.targetPreparation.reconcile(request,facts);if(result.kind==='confirmed'){assertTargetCurrent();manifestDigest=request.manifestDigest}return result},assertTargetCurrent,
    }
    const invoke=(request:BootstrapDependencyRequest,current?:()=>boolean):Promise<BootstrapDependencyOutcome>=>{
      try{
        if(!source||!available()||!isStrictFactData(request)||request.operationId!==captured.invocation.operationId||request.targetSessionId!==captured.invocation.targetSessionId||request.sourceSessionId!==captured.sourceSessionId||request.manifestDigest!==manifestDigest||canonicalJsonData(request.artifacts)!==canonicalJsonData(source.artifacts))return Promise.resolve({kind:'blocked',reason:'conflict'})
        assertTargetCurrent()
        if(!scope){
          const binding={operationId:request.operationId,manifestDigest:request.manifestDigest,sourceSessionId:request.sourceSessionId,targetSessionId:request.targetSessionId,targetDocumentId:request.targetSessionId},sourceAccess=source.access()
          const host:SeedDependencyHostAccess=observeProject?{kind:'coherent-observation-v1',binding,sourceAccess,observeCurrent(mode){
            if(!available())throw Error('Original task transfer unavailable')
            if(mode==='active')source.assertCurrent()
            const target=observeProject(mode)
            if(!available())throw Error('Original task transfer unavailable')
            return {source:{sourceId:contextSourceIdentity(workspaceKey,canonical,target.scope),readonly:true},revision:target.revision}
          }}:{binding,sourceAccess,sourceAvailable:()=>available()&&captured.sourceAvailable(),assertSourceCurrent(){assertCurrent();preparation.assertSourceCurrent()},targetAvailable:available,assertTargetCurrent,
            targetScope(){assertTargetCurrent();const target=preparation.targetScope();return{source:{sourceId:contextSourceIdentity(workspaceKey,canonical,target.scope),readonly:true},revision:target.revision}}}
          scope=contextOutput.registerSeedDependencyTransfer(host,'original-publication')
        }
        const result=current===undefined?contextOutput.reconcileSeedDependencies(scope,request):contextOutput.confirmSeedDependencies(scope,request,current)
        return result.then(outcome=>{if(outcome.kind==='confirmed'){if(closureDigest!==undefined&&closureDigest!==outcome.closureDigest)throw Error('Original dependency closure changed');closureDigest=outcome.closureDigest}return outcome})
      }catch{return Promise.resolve({kind:'blocked',reason:'policy'})}
    }
    return {async run<T>(work:(guards:import('@i-harness/session-persistence').BootstrapGuards)=>Promise<T>):Promise<T>{const run=()=>{assertCurrent();return work({assertCurrent,targetPreparation,dependencies:{confirm:(request,current)=>invoke(request,current),reconcile:request=>invoke(request)}})}
      return source?source.use(run):run()
    },releaseSource(){return source?source.release():Promise.resolve()},assertDependencyReceipt(receipt:import('@i-harness/session-persistence').BootstrapReceipt,seed:import('@i-harness/session-persistence').CompiledSemanticSeed){if(source?.artifacts.length){if(!closureDigest||receipt.dependencyClosureDigest!==closureDigest||receipt.manifestDigest!==manifestDigest||receipt.invocation.operationId!==captured.invocation.operationId||receipt.invocation.targetSessionId!==captured.invocation.targetSessionId||receipt.invocation.requestDigest!==captured.invocation.requestDigest)throw Error('Original managed dependency receipt mismatch')}else if(receipt.dependencyClosureDigest!==seed.dependencyDigest)throw Error('Original empty dependency receipt mismatch')},targetScope:preparation.targetScope,close(){active=false;preparation.close()}}
  }
  const prepareTaskChild:import('@i-harness/subagent').PrepareTaskChild=async input=>{
    if(input.coordinator!==options.coordinator||closed||!options.resultReadScopeFor||!options.prepareTaskChildInheritance)throw Error('Original Gateway task host unavailable')
    input.assertCurrent()
    const association=input.history?(isManagedTaskChildHistory(input.history)?inspectManagedTaskChildSource(input.history,input.parentSessionId):inspectTaskChildSource(input.history,input.parentSessionId)):undefined
    let source:{artifacts:ReturnType<typeof inspectTaskChildSource>['artifacts'];assertCurrent():void;access():ContextAccess;release():Promise<void>;use<T>(work:()=>Promise<T>):Promise<T>}|undefined
    if(association?.hasLegacy || association?.kind==='managed' && association.legacy==='unavailable')throw Error('Unsupported task legacy result membership')

    if(association&&(association.hasDependencies||association.inheritedLegacyUnknown)){
      if(!options.retainSelectedProjectRead)throw Error('Original task result source unavailable')
      if(!hasSelectedSource(options.coordinator as SessionCoordinator))throw Object.assign(new Error('Selected results are unavailable on this session store'),{code:'SELECTED_RESULTS_UNSUPPORTED'})
      const original=selectedSourceFor(options.coordinator as SessionCoordinator)
      let binding:Awaited<ReturnType<typeof original.acquire>>|undefined,project:Awaited<ReturnType<NonNullable<typeof options.retainSelectedProjectRead>>>|undefined
      let retired=false,flight:Promise<void>|undefined,cleanup:ReturnType<typeof original.cleanupForError>
      let witness:ReturnType<typeof original.retainTask>|ReturnType<typeof original.retainManagedTask>|undefined
      const current=()=>{if(retired||closed)throw Error('Original task source retired');input.assertCurrent();association.assertCurrent();if(witness){input.assertSourceCut();witness.assertCurrent()}binding?.assertCurrent();project?.assertCurrent()}
      let sourceClosed=false,closeFlight:Promise<void>|undefined
      const closeSource=()=>{
        if(sourceClosed)return Promise.resolve()
        if(closeFlight)return closeFlight
        const pending=(async()=>{retired=true;binding?.revoke();await flight?.catch(()=>{});if(cleanup){await cleanup.retry();cleanup=undefined}if(project){await project.close();project=undefined}else if(binding){await binding.release();binding=undefined}witness?.unsubscribe();sourceClosed=true})()
        closeFlight=pending;void pending.finally(()=>{if(closeFlight===pending)closeFlight=undefined}).catch(()=>{});return pending
      }
      input.retain({close:closeSource})
      const acquire=()=>flight??=(async()=>{
        input.assertSourceCut();witness=association.kind==='managed'?original.retainManagedTask(association.domain,association.reservation,()=>binding?.revoke()):original.retainTask(association.owner,association.view,()=>binding?.revoke());if('kind' in witness&&witness.kind==='managed-task-source'&&canonicalJsonData(witness.artifacts)!==canonicalJsonData(association.artifacts))throw Error('Original Task seed artifacts changed');current();
        const ids=await discoverResultLineage(options.coordinator,input.parentSessionId,current);current();
        binding=await original.acquire({sessionIds:ids});current();assertResultLineage(binding.observation,ids,input.parentSessionId);
        project=await options.retainSelectedProjectRead!(ids,binding,input.parentSessionId);current();
        const heldProject=project, capture={sessionId:input.parentSessionId,sessionIds:ids,observation:binding.observation,currentSource(){return canonicalSource(heldProject.sourceGetter)},assertHostCurrent:current};const result='kind' in witness! && witness.kind==='managed-task-source'?observations.retainManagedTask({...capture,witness}):observations.retainSelected({...capture,document:witness!.document})
        let metadata:Awaited<ReturnType<typeof bridge.acquireSelectedMetadata>>|undefined,metadataCleanup:ReturnType<typeof bridge.selectedMetadataCleanupFor>
        heldProject.attachResult({revoke(){result.revoke();metadata?.revoke()},async close(){if(metadataCleanup){await metadataCleanup.retry();metadataCleanup=undefined}if(metadata)await metadata.close();await result.close()}})
        if(association.inheritedLegacyUnknown){
          await heldProject.use(()=>result.use(async()=>{
            const observation=result.observation,originalRead=legacyObservationFor(observation);if(observation.kind==='public')originalLegacyReads.set(originalRead,{document:witness!.document,view:observation.view})
            try{metadata=await bridge.acquireSelectedMetadata(originalRead)}catch(error){metadataCleanup=bridge.selectedMetadataCleanupFor(error);throw Object.assign(Error('Original inherited legacy membership unavailable',{cause:error}),{code:'TASK_LEGACY_MEMBERSHIP_UNAVAILABLE'})}
            const iterator=metadata.reader.legacy()[Symbol.asyncIterator](),row=await iterator.next()
            if(!row.done){await iterator.return?.();throw Error('Unsupported task inherited legacy result membership')}
            metadata.assertCurrent();current();
          }))
        }
        const assertSource=()=>{if(metadata)metadata.assertCurrent();else result.assertCurrent()}
        source={artifacts:association.artifacts,release:closeSource,assertCurrent:assertSource,access(){assertSource();return Object.freeze({sessionId:result.observation.sessionId})},use<T>(work:()=>Promise<T>){return heldProject.use(()=>result.use(work))}}
      })().catch(error=>{cleanup=original.cleanupForError(error);throw error})
      const deferred={artifacts:association.artifacts,release:closeSource,assertCurrent(){if(source&&source!==deferred)source.assertCurrent();else current()},access(){if(!source||source===deferred)throw Error('Original source observation not entered');return source.access()},async use<T>(work:()=>Promise<T>){await acquire();current();return source!.use(work)}};source=deferred;originalTaskSources.add(deferred)
    }
    const observed=await options.resultReadScopeFor(input.parentSessionId)
    if(!observed)throw Error('Original task project scope unavailable')
    const scope=observed();input.assertCurrent()
    const project=scope.projectId?{kind:'project' as const,projectId:scope.projectId}:{kind:'unassigned' as const}
    return {project,metadata:{workspaceId:workspaceKey},prepare(request){
      input.assertCurrent()
      if(request.core.caller.kind==='team')(isOriginalColdTeamChildHostInput(input)?assertOriginalColdTeamChildHostRequest:assertOriginalTeamChildHostRequest)(input,request)
      const transfer=prepareTaskChildTransfer({request,sourceSessionId:input.parentSessionId,...request.core.caller.kind==='team'?{teamHost:input}:{},...input.history?{history:input.history}:{},sourceAvailable:input.sourceAvailable,assertNewWorkCurrent(){input.assertCurrent();if(observed().revision!==scope.revision)throw Error('Original task project scope changed')},targetAvailable:()=>true},source)
      input.retain({async close(){transfer.close()}})
      return transfer
    }}
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
  return{workspaceId:workspaceKey,workspaceKey,humanSessionId,contextOutput,codeRetrieval,sourceFor,prepareBootstrapTransfer,prepareTaskChildTransfer,prepareTaskChild,observations,withResultObservation,withLegacyReadObservation,acquireSelectedSourceObservation,createSelectedSourceHolder,
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
    close(){
      if(selectedContext.getStore()?.some(entry=>entry.active))return Promise.reject(Error('Native selected source self-close'))
      if(disposed)return Promise.resolve()
      if(closeFlight)return closeFlight
      closed=true;bridge.retireBridge();if(timer)clearInterval(timer)
      const task=(async()=>{
      await selectedComposer?.close()
      for(const source of selectedSources)source.revoke()
      await Promise.allSettled([...selectedAcquisitions])
      const cleanup=await Promise.allSettled([...selectedCleanupDebt].map(debt=>debt.retry())),cleanupErrors=cleanup.flatMap(value=>value.status==='rejected'?[value.reason]:[])
      if(cleanupErrors.length)throw new AggregateError(cleanupErrors,'Selected source acquisition cleanup unresolved')
      for(const source of selectedSources)source.revoke()
      const settled=await Promise.allSettled([...selectedSources].map(source=>source.close())),errors=settled.flatMap(value=>value.status==='rejected'?[value.reason]:[])
      if(errors.length)throw new AggregateError(errors,'Selected source cleanup unresolved')
      if(!cancelled){await codeRetrieval.cancel();await refreshing;cancelled=true}
      if(!coreClosed){await contextOutput.close();coreClosed=true}
      if(!codeClosed){await codeRetrieval.close();codeClosed=true}
      disposed=true
      })()
      closeFlight=task;void task.finally(()=>{if(closeFlight===task)closeFlight=undefined}).catch(()=>{});return task
    },
  }
}
