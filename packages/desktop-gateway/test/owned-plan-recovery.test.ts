import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({hold:undefined as undefined|{entered:()=>void;wait:Promise<void>},unknown:false,reconciles:0,appends:0}))
vi.mock('../../session-persistence/src/coordinator/action-captures.ts',async original=>{const m=await original<typeof import('../../session-persistence/src/coordinator/action-captures.ts')>();return {...m,createActionCaptures(...args:Parameters<typeof m.createActionCaptures>){const c=m.createActionCaptures(...args);return {...c,captureMetadata(event:Parameters<NonNullable<typeof c.captureMetadata>>[0],check?:()=>boolean){const f=c.captureMetadata!(event,check);if(event.type!=='plan/mode'||!probe.hold)return f;const gate=probe.hold;probe.hold=undefined;return {...f,async admit(){gate.entered();await gate.wait;return f.admit()}}}}}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async original=>{const m=await original<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...m,createFactJournalBackend(...args:Parameters<typeof m.createFactJournalBackend>){const b=m.createFactJournalBackend(...args);return {...b,async appendOwnedBatch(...values:Parameters<typeof b.appendOwnedBatch>){const out=await b.appendOwnedBatch(...values);if(probe.unknown&&out.kind==='committed'){probe.unknown=false;probe.appends++;return {kind:'unknown' as const,key:values[3].key}}return out},async reconcileOwnedBatch(...values:Parameters<typeof b.reconcileOwnedBatch>){probe.reconciles++;return b.reconcileOwnedBatch(...values)}}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {committedFactSeqs,type SessionEventView} from '@i-harness/core-session'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createExecutorExecutionCache} from '../../session-executor/src/durable-session.ts'
import {createManagedExecutionRuntimeWithRegistry,type ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'
import {actionMetadataFacts} from '../../session-executor/src/lifecycle/action-facts.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {mountOwnedPlan} from '../src/owned-plan.ts'

type PlanFixture={
 entry:Awaited<ReturnType<ReturnType<typeof createExecutorExecutionCache>['get']>>
 start:()=>ReturnType<typeof createManagedExecutionRuntimeWithRegistry>
 construction():ManagedRegistryConstruction
 retireConstruction():Promise<void>
 events():Promise<readonly SessionEventView[]>
}
async function fixture(run:(x:PlanFixture)=>Promise<void>){
 probe.hold=undefined;probe.unknown=false;probe.appends=0;probe.reconciles=0
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'plan-repair-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>void|Promise<void>>=[]
 const model=controlledModel(async function*(){yield {type:'end'}})
 let construction:ManagedRegistryConstruction|undefined
 const start=()=>createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:c=>cleanups.push(c),async configureRegistry(original){construction=original;await mountOwnedPlan(original,true)},resolveModel(){return {model}}})
 let failed=false,primary:unknown
 try{await run({entry,start,construction(){if(!construction)throw Error('Original construction not entered');return construction},async retireConstruction(){const retire=cleanups[0];if(!retire)throw Error('Original construction retirement not retained');await retire()},async events(){return (await coordinator.snapshot!('main')).session.events}})}catch(error){failed=true;primary=error}
 const errors:unknown[]=[]
 for(const cleanup of cleanups.reverse())try{await cleanup()}catch(error){errors.push(error)}
 try{await cache.closeAll()}catch(error){errors.push(error)}
 try{await coordinator.close()}catch(error){errors.push(error)}
 if(errors.length)throw new AggregateError([...(failed?[primary]:[]),...errors],'Original Plan fixture cleanup failed',{cause:primary})
 if(failed)throw primary
}
it('does not overwrite an explicit off while initial on is held',async()=>{await fixture(async({entry,start})=>{const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();probe.hold={entered:entered.resolve,wait:release.promise};const pending=start();await entered.promise;committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'plan/mode',mode:'off'}));release.resolve();await expect(pending).rejects.toMatchObject({code:'FACT_PRECONDITION_STALE'});expect(entry.execution.observe().plan().active).toBe(false)})},30000)
it('reconciles the same uncertain original plan capture',async()=>{await fixture(async({entry,start})=>{probe.unknown=true;probe.appends=0;probe.reconciles=0;const runtime=await start() as {close():Promise<void>};expect(entry.execution.observe().plan().active).toBe(true);expect(probe.appends).toBe(1);expect(probe.reconciles).toBe(1);await runtime.close()})},30000)

it.each(['retired','method-substituted'] as const)('refuses a held original Plan capture after construction is %s',async cut=>{
 await fixture(async f=>{
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  probe.hold={entered:entered.resolve,wait:release.promise}
  const pending=f.start(),observed=pending.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}))
  let original:ManagedRegistryConstruction|undefined,field:PropertyDescriptor|undefined
  try{
   await Promise.race([entered.promise,observed.then(outcome=>{if(!outcome.ok)throw outcome.error;throw Error('Plan construction completed before its capture cut')})])
   original=f.construction()
   if(cut==='retired'){
    await f.retireConstruction()
    expect(()=>original!.assertLifetimeCurrent()).toThrow('Original construction retired')
   }else{
    field=Object.getOwnPropertyDescriptor(original,'assertLifetimeCurrent')!
    Object.defineProperty(original,'assertLifetimeCurrent',{...field,value:()=>{}})
   }
   release.resolve()
   await expect(pending).rejects.toMatchObject({code:'FACT_PRECONDITION_STALE'})
   expect(await f.events()).toEqual([])
   expect(f.entry.execution.observe().plan().active).toBe(false)
  }finally{
   release.resolve();await observed
   if(original&&field)Object.defineProperty(original,'assertLifetimeCurrent',field)
  }
 })
},30000)

it('cancels the held original exit capture without changing the committed Plan',async()=>{
 await fixture(async f=>{
  committedFactSeqs(await actionMetadataFacts(f.entry.execution.owner).admit({type:'plan/mode',mode:'on'}))
  const runtime=await f.start(),before=await f.events(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController()
  probe.hold={entered:entered.resolve,wait:release.promise}
  const pending=runtime.tools.get('exit_plan_mode')!.execute({}, {abortSignal:abort.signal}),observed=pending.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}))
  try{
   await Promise.race([entered.promise,observed.then(outcome=>{if(!outcome.ok)throw outcome.error;throw Error('Plan exit completed before its capture cut')})])
   abort.abort();release.resolve()
   await expect(pending).rejects.toMatchObject({code:'FACT_CANCELLED'})
   expect(await f.events()).toEqual(before)
   expect(f.entry.execution.observe().plan().active).toBe(true)
  }finally{release.resolve();await observed;await runtime.close()}
 })
},30000)
