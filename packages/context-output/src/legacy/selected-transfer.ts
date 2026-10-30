import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { captureSelectedResultsBootstrapPreparationFacts, canonicalJsonData } from '@i-harness/core-session'
import { semanticSeedFromRecords } from '@i-harness/core-session/internal/bootstrap'
import type { IndexedLegacyContext } from './index-lifecycle.ts'
import type { WorkspaceMutationTurn } from '../workspace-mutation.ts'
import { failuresTogether } from '../workspace-mutation.ts'
import { continueAtomicJson, confirmAtomicJson, ownedMkdir } from '../artifact/io.ts'
import { requireSpace } from '../artifact/quota.ts'
import { appliedFor, canonicalRecord, checkBinding, checkRoot, commitment, recordHash, same, sourceHash, streamHash } from './fork-codec.ts'
import { buildPages, walkPages } from './fork-pages.ts'
import { expiryBase, expiredTuple, readSlots, revokedTuple } from './fork-disposition.ts'
import { captureObservation, loadPlan, observedAllowed, prepareObservedIndex, rowCommitment, transferDirectory, verifiedRows } from './observed-read.ts'
import { captureSelectedPlanView } from './selected-plan-view.ts'
import type { SelectedLegacyCapture, LegacyForkTransferScope, LegacyRow, LegacyTransferOutcome } from './fork-types.ts'
import type { ContextStore } from '../store.ts'

type Ports={strict:boolean;workspaceId:string;quota():number;runPassive<T>(store:ContextStore,work:(signal:AbortSignal,store:ContextStore)=>Promise<T>):Promise<T>;mutate<T>(context:IndexedLegacyContext,work:(turn:WorkspaceMutationTurn)=>Promise<T>):Promise<T>;run<T>(signal:AbortSignal|undefined,work:(signal:AbortSignal,context:IndexedLegacyContext)=>Promise<T>):Promise<T>}
type Scope={capture:SelectedLegacyCapture;invalid:boolean;sourceRevoked:boolean;complete:boolean;fundingConfirmed:boolean;owners:Map<string,ReturnType<ContextStore['createLegacyOwnerTransfer']>>;records:Map<string,unknown>;minimumExpiry?:number;issuedNames:Set<string>;issuedFiles:Map<string,{dev:string;ino:string}>;attempts:Set<Promise<LegacyTransferOutcome>>;store?:ContextStore}
const blocked=(reason:'unknown'|'unavailable'|'conflict'|'policy'):LegacyTransferOutcome=>({kind:'blocked',reason})
/** The original legacy owner owns this V2 branch and its existing store/ledger. */
export function createSelectedLegacyTransfer(ports:Ports) {
 const scopes=new Map<LegacyForkTransferScope,Scope>(),retired=new WeakSet<LegacyForkTransferScope>();let closed=false
 function register(capture:SelectedLegacyCapture):LegacyForkTransferScope {
  if(closed||!ports.strict)throw Error('Selected legacy transfer unavailable')
  const facts=captureSelectedResultsBootstrapPreparationFacts(capture.facts),header=capture.targetView.header?.semanticSeed
  if(!header||header.version!==3||!same(facts.invocation,capture.invocation)||header.seedDigest!==facts.seedDigest||header.manifestDigest!==facts.manifestDigest||!same(header.results,facts.semantic.results))throw Error('Selected legacy capture conflict')
  const seed=semanticSeedFromRecords(header,capture.targetView.events);if(seed.version!==3)throw Error('Selected seed unavailable')
  let minimumExpiry:number|undefined;for(const page of seed.results.pages)for(const row of page.rows)if(row.protocol==='legacy')minimumExpiry=Math.min(minimumExpiry??Infinity,row.ref.expiresAt)
  const token=Object.freeze({}) as LegacyForkTransferScope;scopes.set(token,{capture,invalid:false,sourceRevoked:false,complete:false,fundingConfirmed:false,owners:new Map(),records:new Map(),minimumExpiry,issuedNames:new Set(),issuedFiles:new Map(),attempts:new Set()});return token
 }
 function invoke(token:LegacyForkTransferScope,passive:boolean):Promise<LegacyTransferOutcome> {
  const candidate=scopes.get(token);if(!candidate||candidate.invalid||closed)return Promise.resolve(blocked('unavailable'))
  const scope:Scope=candidate,c=scope.capture,facts=captureSelectedResultsBootstrapPreparationFacts(c.facts)
  if(facts.semantic.profile!=='public-completed')return Promise.resolve(blocked('conflict'))
  const semantic=facts.semantic
  if(!passive&&scope.complete){try{if(scope.sourceRevoked)throw Error('Selected source revoked');c.source.assertCurrent()}catch{return Promise.resolve(blocked('policy'))}return invoke(token,true).then(result=>{try{c.source.assertCurrent();return result}catch{return blocked('policy')}})}
  const sameOriginal=async(name:string,path:string)=>{const original=scope.issuedFiles.get(name);if(!original)return false;try{const info=await stat(path,{bigint:true});return info.isFile()&&String(info.dev)===original.dev&&String(info.ino)===original.ino}catch{return false}}
  if(passive){
   if(!scope.store)return Promise.resolve(blocked('unknown'))
   const original=scope.store
   const task=ports.runPassive<LegacyTransferOutcome>(original,async(signal,store)=>{
    const check=()=>{if(closed||scope.invalid||signal.aborted||store!==original||c.target.available()!==true)throw Error('Selected target unavailable');c.target.assertCurrent()}
    const directory=transferDirectory(store,c.invocation)
    const resume=async(name:string)=>{
     const value=scope.records.get(name),expected=scope.issuedFiles.get(name);if(!value||!expected)return false
     const path=resolve(directory,name),prior=await confirmAtomicJson(store.directory,path,value,store.retireLegacyFile);check()
     if(prior.kind==='confirmed')return sameOriginal(name,path)
     if(prior.kind==='conflict')return false
     const result=await continueAtomicJson(store.directory,path,value,()=>{check();return true},store.retireLegacyFile,{resumeOnly:true,async onCreated(){throw Error('Passive creation forbidden')},async allowExisting(handle){const info=await handle.stat({bigint:true});return info.isFile()&&String(info.dev)===expected.dev&&String(info.ino)===expected.ino}});check()
     return result.kind==='confirmed'&&await sameOriginal(name,path)
    }
    try{
     check();if(!await resume('binding.json'))return blocked('unknown')
     for(const name of [...scope.records.keys()].filter(name=>name.startsWith('pages/')).sort())if(!await resume(name))return blocked('unknown')
     if(!await resume('plan.json')||!scope.fundingConfirmed)return blocked('unknown')
     const root=checkRoot(await import('../artifact/io.ts').then(m=>m.boundedJson(resolve(directory,'plan.json'),65536,store.retireLegacyFile)));check()
     if(root.version!==2||root.binding.targetSourceDigest!==sourceHash(c.target.sourceId()))return blocked('conflict')
     const plan=captureSelectedPlanView(c.targetView,root,{sessionId:c.invocation.targetSessionId,createdAt:c.invocation.createdAt})
     if(await readSlots(store.directory,resolve(directory,'revoke'),revokedTuple(root),store.retireLegacyFile)!=='live')return blocked('unknown')
     for await(const row of walkPages(directory,root,check,undefined,store.retireLegacyFile,async(ref)=>{const name='pages/'+ref.level+'-'+ref.firstRow+'.json';if(!await sameOriginal(name,resolve(directory,name)))throw Error('Foreign selected page')})){
      plan.row(row);check();const tuple=rowCommitment(row)
      const owner=scope.owners.get(row.refId);if(!owner)throw Error('Original selected owner unavailable');await owner.settle();check()
      if(await readSlots(store.directory,expiryBase(store.directory,tuple),expiredTuple(store.workspaceId,tuple),store.retireLegacyFile)!=='live')throw Error('Selected legacy grant unavailable')
      await store.canonicalRef(tuple,root.binding.targetSessionId);check()
     }
     if(!await resume('applied.json'))return blocked('unknown')
     const loaded=await loadPlan(store,{bootstrap:{invocation:c.invocation,manifestDigest:facts.manifestDigest,seedDigest:facts.seedDigest},selectedView:c.targetView},check);check()
     if(!same(root,loaded.root))return blocked('conflict')
     return {kind:'confirmed'}
    }catch{return blocked('unknown')}
   }).catch(()=>blocked('unavailable'))
   scope.attempts.add(task);void task.finally(()=>scope.attempts.delete(task));return task
  }
  const task=ports.run<LegacyTransferOutcome>(undefined,async(signal,context)=>{
   const {store,lease,index}=context;let issued=false,read:ReturnType<typeof captureObservation>|undefined
   const check=()=>{index.assertCurrent();if(closed||scope.invalid||signal.aborted||c.target.available()!==true)throw Error('Selected legacy unavailable');c.target.assertCurrent();if(!passive){if(scope.sourceRevoked)throw Error('Selected source revoked');c.source.assertCurrent();read!.assertCurrent()}}
   try {
    if(!passive){c.source.assertCurrent();read=captureObservation(c.source.read());if(read.sessionId!==c.sourceSessionId)throw Error('Selected source identity conflict')}
    check();scope.store=store;const directory=transferDirectory(store,c.invocation),targetSourceDigest=sourceHash(c.target.sourceId());check()
    const binding=checkBinding({workspaceId:ports.workspaceId,invocation:c.invocation,manifestDigest:facts.manifestDigest,sourceSessionId:c.sourceSessionId,targetSessionId:c.invocation.targetSessionId,targetDocumentId:c.invocation.targetSessionId,semanticSeedDigest:facts.seedDigest,sourceObservationDigest:facts.sourceObservation.digest,selection:semantic.selection,targetSourceDigest,turnDomainDigest:streamHash('ih.legacy-fork.turn-domain.v1',facts.semantic.turns).digest,totalTurns:facts.semantic.turns.total,unframedPrefix:facts.semantic.turns.unframedPrefix,selectedResults:facts.semantic.results},2)
    const bindingDigest=recordHash('binding',binding,2),seedHeader=c.targetView.header!.semanticSeed!,seed=semanticSeedFromRecords(seedHeader,c.targetView.events)
    if(seed.version!==3)throw Error('Selected seed unavailable');const selectedSeed=seed
    await prepareObservedIndex(context,read!,check,ports.mutate,ports.quota());check()
    async function publish(name:string,value:unknown) {
     value=canonicalRecord(value);check();await ports.mutate(context,async turn=>{
      turn.assertCurrent();check();await ownedMkdir(store.directory,resolve(directory,'pages'),check)
      if(name.startsWith('pages/')){await store.stageLegacyPage(turn,lease,index,bindingDigest,name.slice(6),value as import('./fork-types.ts').LegacyPage,ports.quota(),2);check()}
      const path=resolve(directory,name),confirmed=await confirmAtomicJson(store.directory,path,value,store.retireLegacyFile);check()
      if(confirmed.kind==='confirmed'){if(!await sameOriginal(name,path))throw Error('Foreign equal selected publication');return}if(confirmed.kind==='conflict')throw Error('Selected legacy publication conflict')
      const bytes=Buffer.from(JSON.stringify(value)),pending=path+'.'+createHash('sha256').update(bytes).digest('hex')+'.pending';let retained=0
      try{retained=(await stat(pending)).size}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      check();await requireSpace(store.directory,ports.quota(),Math.max(0,bytes.length-retained));check()
      const result=await continueAtomicJson(store.directory,path,value,()=>{check();return true},store.retireLegacyFile,{async onCreated(handle){const info=await handle.stat({bigint:true});if(!info.isFile()||info.ino===0n)throw Error('Selected original file identity unavailable');issued=true;scope.issuedNames.add(name);scope.issuedFiles.set(name,{dev:String(info.dev),ino:String(info.ino)});scope.records.set(name,canonicalRecord(value))},async allowExisting(handle){const info=await handle.stat({bigint:true}),original=scope.issuedFiles.get(name);return !!original&&info.isFile()&&String(info.dev)===original.dev&&String(info.ino)===original.ino}});check();if(result.kind==='confirmed'&&!await sameOriginal(name,path))throw Error('Foreign equal selected publication');if(result.kind!=='confirmed')throw Error('Selected legacy publication '+name+' '+result.kind)
     });check()
    }
    await publish('binding.json',{version:2,kind:'legacy-fork-binding',binding})
    async function qualify(row:LegacyRow){check();const actual=await store.canonicalRef(rowCommitment(row),c.sourceSessionId);check();if(!await observedAllowed(context,actual,read!,check))throw Error('Selected legacy source unavailable');check()}
    type ParentProof={row:LegacyRow;ordinal:number;root:import('./fork-types.ts').LegacyRoot}
    let parentProofs:Map<string,ParentProof[]>|undefined
    async function parentProof(row:LegacyRow,selected:import('@i-harness/core-session').SelectedResultRow):Promise<ParentProof>{
     if(!read!.bootstrap)throw Error('Original inherited plan unavailable')
     if(!parentProofs){
      const loaded=await loadPlan(store,read!,check),parent=loaded.root,map=new Map<string,ParentProof[]>();let ordinal=0
      if(parent.binding.targetSessionId!==c.sourceSessionId||parent.binding.targetSourceDigest!==sourceHash(read!.sourceId))throw Error('Inherited parent binding conflict')
      for await(const prior of walkPages(loaded.directory,parent,check,undefined,store.retireLegacyFile)){
       loaded.selected?.row(prior);const tuple=rowCommitment(prior),visible=loaded.selected?loaded.selected.visible(prior):read!.anchorVisible(prior.anchor,prior.extent,tuple,prior.original);check()
       if(visible){
        const key=parent.version===2&&prior.anchor.kind==='seed-result'?'v2:'+prior.anchor.rowOrdinal:'v1:'+canonicalJsonData([tuple,prior.original])
        const values=map.get(key)??[];values.push({row:prior,ordinal,root:parent});map.set(key,values)
       }
       ordinal++
      }
      parentProofs=map
     }
     const key=selected.basis.kind==='inherited'?'v2:'+selected.basis.row:'v1:'+canonicalJsonData([rowCommitment(row),row.original]),matches=parentProofs.get(key)??[]
     if(matches.length!==1)throw Error('Original inherited row unavailable')
     const proof=matches[0]!
     if(!same(rowCommitment(row),rowCommitment(proof.row))||!same(row.original,proof.row.original))throw Error('Inherited original declaration conflict')
     if(proof.root.version===2&&(selected.basis.kind!=='inherited'||selected.basis.parentSeedDigest!==proof.root.binding.semanticSeedDigest||selected.basis.parentResultsDigest!==proof.root.binding.selectedResults?.digest))throw Error('Inherited seed identity conflict')
     return proof
    }
    async function* rows():AsyncGenerator<LegacyRow>{
     for(const page of selectedSeed.results.pages)for(const selected of page.rows){
      if(selected.protocol!=='legacy')continue
      if(selected.original.kind!=='local'||selected.original.event!=='context/result-ref'||selected.original.slot!=='ref')throw Error('Selected declaration unavailable')
      const row:LegacyRow={...commitment(selected.ref),extent:selected.extent,original:{sessionId:selected.original.sessionId,seq:selected.original.seq,part:'context/result-ref.ref'},anchor:{kind:'seed-result',manifestSeq:0,pageOrdinal:page.ordinal,rowOrdinal:selected.ordinal}}
      if(selected.original.sessionId!==c.sourceSessionId){const parent=await parentProof(row,selected);row.via={sessionId:c.sourceSessionId,operationId:parent.root.binding.invocation.operationId,manifestDigest:parent.root.binding.manifestDigest,planDigest:recordHash('plan',parent.root,parent.root.version),rowOrdinal:parent.ordinal}}
      await qualify(row);yield row
     }
    }
    const graph=await buildPages(binding,rows(),(name,page)=>publish('pages/'+name,page),2),counts=store.legacyCounts(index,bindingDigest),root=checkRoot({version:2,kind:'legacy-fork-plan',binding,...graph,distinctRefCount:counts.refs})
    if(counts.observations!==graph.observationCount)throw Error('Selected legacy derived EOF mismatch')
    await publish('plan.json',root);check();const plan=captureSelectedPlanView(c.targetView,root,{sessionId:c.invocation.targetSessionId,createdAt:c.invocation.createdAt})
    await ports.mutate(context,async turn=>{check();await store.confirmLegacyIndex(turn,lease,index,root,ports.quota());check();if(!scope.fundingConfirmed)await store.fundLegacyBatch(turn,lease,index,ports.quota(),root,{kind:'selected-v2',owners:scope.owners,plan,application:{onCreated(file){if(file.kind!=='file'||file.ino==='0')throw Error('Original application identity unavailable');issued=true;scope.issuedNames.add('applied.json');scope.issuedFiles.set('applied.json',{dev:file.dev,ino:file.ino});scope.records.set('applied.json',canonicalRecord(appliedFor(root)))},allowExisting(file){const original=scope.issuedFiles.get('applied.json');return file.kind==='file'&&!!original&&file.dev===original.dev&&file.ino===original.ino}}},check,qualify);scope.fundingConfirmed=true;check()});check()
    let ordinal=0;for await(const row of walkPages(directory,root,check,undefined,store.retireLegacyFile)){
     const position=ordinal++;plan.row(row);if(store.legacyFirst(index,bindingDigest,row.refId)!==position)continue
     await qualify(row);await ports.mutate(context,async turn=>{turn.assertCurrent();check();await qualify(row);const tuple=rowCommitment(row);if(await readSlots(store.directory,resolve(directory,'revoke'),revokedTuple(root),store.retireLegacyFile)!=='live'||await readSlots(store.directory,expiryBase(store.directory,tuple),expiredTuple(store.workspaceId,tuple),store.retireLegacyFile)!=='live')throw Error('Selected legacy disposition unavailable');issued=true;const owner=scope.owners.get(row.refId);if(!owner)throw Error('Original selected owner unavailable');await owner.issue(check);check()});check()
    }
    await publish('applied.json',appliedFor(root));check()
    const confirmed=await loadPlan(store,{bootstrap:{invocation:c.invocation,manifestDigest:facts.manifestDigest,seedDigest:facts.seedDigest},selectedView:c.targetView},check);check()
    for await(const row of verifiedRows(context,confirmed.directory,confirmed.root,check)){plan.row(row);const tuple=rowCommitment(row);if(await readSlots(store.directory,expiryBase(store.directory,tuple),expiredTuple(store.workspaceId,tuple),store.retireLegacyFile)!=='live')throw Error('Selected legacy expiry unavailable');await store.canonicalRef(tuple,binding.targetSessionId);check()}
    scope.complete=true;return {kind:'confirmed'}
   }catch(cause){const message=cause instanceof Error?cause.message:String(cause);return blocked(scope.invalid||signal.aborted?(issued?'unknown':'policy'):/conflict|Invalid/.test(message)?'conflict':issued?'unknown':'unavailable')}
  }).catch(()=>blocked('unavailable'))
  scope.attempts.add(task);void task.finally(()=>scope.attempts.delete(task));return task
 }
 async function closeScope(token:LegacyForkTransferScope){const scope=scopes.get(token);if(!scope){if(retired.has(token))return;throw Error('Foreign selected legacy scope')}scope.invalid=true;const results=await Promise.allSettled([...scope.attempts]),errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);try{await scope.store?.joinLegacyFiles()}catch(error){errors.push(error)}failuresTogether(errors,'Selected legacy cleanup unresolved');scopes.delete(token);retired.add(token)}
 function assertCurrent(token:LegacyForkTransferScope){const scope=scopes.get(token);if(!scope||closed||scope.invalid||scope.sourceRevoked||!scope.complete||scope.minimumExpiry!==undefined&&scope.minimumExpiry<=Date.now())throw Error('Selected legacy authority expired or revoked');scope.capture.target.assertCurrent();scope.capture.source.assertCurrent()}
 return {register,assertCurrent,confirm:(scope:LegacyForkTransferScope)=>invoke(scope,false),reconcile:(scope:LegacyForkTransferScope)=>invoke(scope,true),closeScope,retire(sessionId?:string){for(const state of scopes.values()){if(sessionId===undefined||state.capture.invocation.targetSessionId===sessionId)state.invalid=true;else if(state.capture.sourceSessionId===sessionId)state.sourceRevoked=true}} ,async close(){closed=true;const results=await Promise.allSettled([...scopes.keys()].map(closeScope));failuresTogether(results.flatMap(result=>result.status==='rejected'?[result.reason]:[]),'Selected legacy scopes failed to close')}}
}
