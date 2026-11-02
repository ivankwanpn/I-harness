import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({hold:undefined as undefined|{entered:()=>void;wait:Promise<void>},unknown:false,reconciles:0,appends:0}))
vi.mock('../../session-persistence/src/coordinator/action-captures.ts',async original=>{const m=await original<typeof import('../../session-persistence/src/coordinator/action-captures.ts')>();return {...m,createActionCaptures(...args:Parameters<typeof m.createActionCaptures>){const c=m.createActionCaptures(...args);return {...c,captureMetadata(event:Parameters<NonNullable<typeof c.captureMetadata>>[0],check?:()=>boolean){const f=c.captureMetadata!(event,check);if(event.type!=='plan/mode'||!probe.hold)return f;const gate=probe.hold;probe.hold=undefined;return {...f,async admit(){gate.entered();await gate.wait;return f.admit()}}}}}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async original=>{const m=await original<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...m,createFactJournalBackend(...args:Parameters<typeof m.createFactJournalBackend>){const b=m.createFactJournalBackend(...args);return {...b,async appendOwnedBatch(...values:Parameters<typeof b.appendOwnedBatch>){const out=await b.appendOwnedBatch(...values);if(probe.unknown&&out.kind==='committed'){probe.unknown=false;probe.appends++;return {kind:'unknown' as const,key:values[3].key}}return out},async reconcileOwnedBatch(...values:Parameters<typeof b.reconcileOwnedBatch>){probe.reconciles++;return b.reconcileOwnedBatch(...values)}}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {committedFactSeqs} from '@i-harness/core-session'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createExecutorExecutionCache} from '../../session-executor/src/durable-session.ts'
import {createManagedExecutionRuntimeWithRegistry} from '../../session-executor/src/managed-assembly.ts'
import {actionMetadataFacts} from '../../session-executor/src/lifecycle/action-facts.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {mountOwnedPlan} from '../src/owned-plan.ts'

async function fixture(run:(x:{entry:Awaited<ReturnType<ReturnType<typeof createExecutorExecutionCache>['get']>>;start:()=>Promise<unknown>})=>Promise<void>){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'plan-repair-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>void|Promise<void>>=[]
 const model=controlledModel(async function*(){yield {type:'end'}})
 const start=()=>createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:c=>cleanups.push(c),async configureRegistry(original){await mountOwnedPlan(original,true)},resolveModel(){return {model}}})
 try{await run({entry,start})}finally{for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close()}
}
it('does not overwrite an explicit off while initial on is held',async()=>{await fixture(async({entry,start})=>{const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();probe.hold={entered:entered.resolve,wait:release.promise};const pending=start();await entered.promise;committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'plan/mode',mode:'off'}));release.resolve();await expect(pending).rejects.toMatchObject({code:'FACT_PRECONDITION_STALE'});expect(entry.execution.observe().plan().active).toBe(false)})},30000)
it('reconciles the same uncertain original plan capture',async()=>{await fixture(async({entry,start})=>{probe.unknown=true;probe.appends=0;probe.reconciles=0;const runtime=await start() as {close():Promise<void>};expect(entry.execution.observe().plan().active).toBe(true);expect(probe.appends).toBe(1);expect(probe.reconciles).toBe(1);await runtime.close()})},30000)
