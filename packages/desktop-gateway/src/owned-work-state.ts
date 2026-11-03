import {committedFactSeqs,type CapturedActionFact,type ProducerFactOutcome} from '@i-harness/core-session'
import {isOriginalExecutionObservation} from '@i-harness/core-session/internal/execution'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import {createOwnedMetadataContext} from '../../session-executor/src/lifecycle/owned-metadata-context.ts'
import {validateTodoItems} from '@i-harness/todo'
import type {DesktopTodoWriteInput,DesktopWorkStateView} from './work-state.ts'

export class TodoRevisionConflictError extends Error {
 readonly code='TODO_REVISION_CONFLICT'
 constructor(readonly expectedRevision:number,readonly actualRevision:number){
  super(`Todo list changed (revision ${actualRevision}). Reload it before saving your edit.`)
  this.name='TodoRevisionConflictError'
 }
}
const recovery=()=>Object.assign(new Error('Work-state metadata settlement requires recovery'),{code:'FACT_RECOVERY_REQUIRED'})

/** Same original folds and guarded metadata writer; owns no execution/runtime. */
export function createOwnedWorkState(execution:ManagedExecutionAttachment,isCurrent:()=>boolean){
 if(!isManagedExecutionAttachment(execution))throw TypeError('Original managed work-state execution required')
 const metadata=createOwnedMetadataContext(execution),pending=new Set<()=>Promise<void>>()
 let closing=false
 const assertOwner=()=>{if(!isCurrent())throw TypeError('Original work-state execution retired')}
 const capture=()=>{
  assertOwner()
  const observation=execution.observe()
  if(!isOriginalExecutionObservation(observation)||observation.identity!==execution.identity)throw TypeError('Original work-state observation required')
  observation.assertCurrent()
  const todo=observation.metadata.todo,goal=observation.metadata.goal
  if(todo.kind!=='available'||goal.kind!=='available'||todo.revision!==goal.revision)throw TypeError('Original work-state folds unavailable')
  const revision=observation.todosRevision
  if(!Number.isSafeInteger(revision)||revision<0)throw TypeError('Original Todo revision unavailable')
  const snapshots=metadata.read()
  observation.assertCurrent();assertOwner()
  const value:DesktopWorkStateView={todos:snapshots.todo.kind==='absent'?null:snapshots.todo.items.map(item=>({...item})),todosRevision:revision,goal:snapshots.goal.kind==='absent'?null:structuredClone(snapshots.goal.value)}
  return {observation,rootRevision:todo.revision,revision,value}
 }
 const read=()=>{if(closing)throw TypeError('Work-state is closing');if(pending.size)throw recovery();return capture().value}
 return Object.freeze({
  read,
  async writeTodos(input:DesktopTodoWriteInput):Promise<DesktopWorkStateView>{
   if(closing||pending.size)throw recovery()
   if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw Error('todo: expectedRevision must be a non-negative integer')
   const items=input.items.map(item=>({...item}));validateTodoItems(items,false)
   const selected=capture()
   if(selected.revision!==input.expectedRevision)throw new TodoRevisionConflictError(input.expectedRevision,selected.revision)
   const action=execution.owner.beginAction(),finish=action.finish.bind(action),guarded=action.captureMetadata
   if(!guarded){finish();throw TypeError('Guarded original Todo capture required')}
   let fact:CapturedActionFact<ProducerFactOutcome>
   try{fact=guarded.call(action,{type:'todo/write',version:1,items},()=>{
    try{if(closing)return false;assertOwner();action.assertOpen();selected.observation.assertCurrent();return selected.observation.metadata.todo.revision===selected.rootRevision}catch{return false}
   })}catch(error){finish();throw error}
   const admit=fact.admit.bind(fact),observe=fact.observe.bind(fact),reconcile=fact.reconcile.bind(fact)
   let invoked=false,terminal=false
   const settle=async()=>{
    const first=!invoked;invoked=true
    let outcome=first?await admit():await observe()
    if(outcome.kind==='unknown'||outcome.kind==='recovery-required'||outcome.kind==='not-issued'&&outcome.code==='FACT_RECOVERY_REQUIRED')outcome=await reconcile()
    if(outcome.kind==='committed'||outcome.kind==='memory-committed'||outcome.kind==='not-issued'&&outcome.code!=='FACT_RECOVERY_REQUIRED')terminal=true
    return outcome
   }
   let source:ReturnType<typeof action.registerSettlementSource>
   try{source=action.registerSettlementSource(async()=>{if(!terminal)committedFactSeqs(await settle())})}catch(error){finish();throw error}
   const closeSource=source.close.bind(source)
   let work:Promise<unknown>|undefined
   const close=async()=>{await work?.catch(()=>{});await closeSource();finish();pending.delete(close)}
   pending.add(close)
   work=(async()=>{committedFactSeqs(await settle())})()
   let failed=false,failure:unknown
   try{await work}catch(error){failed=true;failure=error}
   if(terminal)try{await close()}catch(cleanup){if(failed)throw new AggregateError([failure,cleanup],'Todo metadata settlement requires recovery',{cause:failure});throw cleanup}
   if(failed){
    if(terminal&&!closing)try{const actual=capture().revision;if(actual!==input.expectedRevision)throw new TodoRevisionConflictError(input.expectedRevision,actual)}catch(error){if(error instanceof TodoRevisionConflictError)throw error}
    throw failure
   }
   return read()
  },
  async close(){closing=true;for(const close of [...pending])await close();await metadata.close()},
 })
}
