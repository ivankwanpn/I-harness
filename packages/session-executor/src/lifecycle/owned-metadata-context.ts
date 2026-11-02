import {isOriginalExecutionObservation} from '@i-harness/core-session/internal/execution'
import {createTodoTool,isTodoSnapshot,renderTodoSnapshot,type TodoSnapshot} from '@i-harness/todo'
import {applyGoalMutation,isGoalSnapshot,renderGoalContext,type GoalProjectionSnapshot} from '../../../goal/src/index.ts'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../../session-persistence/src/execution-internal.ts'
import {actionMetadataFacts} from './action-facts.ts'
import {committedFactSeqs,type CapturedActionFact,type ProducerFactOutcome} from '@i-harness/core-session'

/** Read-only snapshots and original fact admission, bound to one execution. */
export function createOwnedMetadataContext(execution:ManagedExecutionAttachment) {
 if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
 const capture=()=>{
  const observation=execution.observe()
  if(!isOriginalExecutionObservation(observation)||observation.identity!==execution.identity)throw TypeError('Original execution observation required')
  observation.assertCurrent()
  const metadata=observation.metadata
  if(!metadata||metadata.todo.kind!=='available'||metadata.goal.kind!=='available')throw TypeError('Original metadata fold unavailable')
  if(!isTodoSnapshot(metadata.todo.snapshot)||!isGoalSnapshot(metadata.goal.snapshot))throw TypeError('Invalid original metadata fold')
  observation.assertCurrent()
  return {observation,todo:metadata.todo.snapshot as TodoSnapshot,goal:metadata.goal.snapshot as GoalProjectionSnapshot}
 }
 const read=()=>{const {todo,goal}=capture();return {todo,goal}}
 const pending=new Set<()=>Promise<void>>()
 let closing=false
 return Object.freeze({
  read,
  todoTool:createTodoTool({metadata:signal=>actionMetadataFacts(execution.owner,signal)}),
  goalPort:Object.freeze({
   read(){const {goal}=read();return goal.kind==='absent'?null:goal.value},
   async complete(ref:{id:string;revision:number},signal?:AbortSignal){
    if(closing||pending.size)throw Error('Goal metadata recovery required')
    const selected=capture(),current=selected.goal.kind==='absent'?null:selected.goal.value
    if(current?.phase!=='active')throw Error('Goal is not active')
    const event=applyGoalMutation(current,'complete',{ref},Date.now()).event,action=execution.owner.beginAction(signal)
    const guarded=action.captureMetadata
    if(!guarded){action.finish();throw TypeError('Guarded original metadata capture required')}
    let fact:CapturedActionFact<ProducerFactOutcome>
    try{fact=guarded.call(action,event,()=>{try{action.assertOpen();selected.observation.assertCurrent();return true}catch{return false}})}catch(error){action.finish();throw error}
    let invoked=false,terminal=false,source:ReturnType<typeof action.registerSettlementSource>
    const settle=async()=>{let outcome=invoked?await fact.observe():await fact.admit();invoked=true;if(outcome.kind==='unknown'||outcome.kind==='recovery-required'||outcome.kind==='not-issued'&&outcome.code==='FACT_RECOVERY_REQUIRED')outcome=await fact.reconcile();if(outcome.kind==='committed'||outcome.kind==='memory-committed'||outcome.kind==='not-issued'&&outcome.code!=='FACT_RECOVERY_REQUIRED')terminal=true;return outcome}
    try{source=action.registerSettlementSource(async()=>{if(!terminal){const outcome=await settle();if(!terminal)committedFactSeqs(outcome)}})}catch(error){action.finish();throw error}
    const close=async()=>{await source.close();action.finish();pending.delete(close)}
    pending.add(close)
    let failed=false,failure:unknown
    try{committedFactSeqs(await settle())}catch(error){failed=true;failure=error}
    if(terminal)try{await close()}catch(cleanup){if(failed)throw new AggregateError([failure,cleanup],'Goal metadata settlement requires recovery',{cause:failure});throw cleanup}
    if(failed)throw failure
    const {goal}=read();return goal.kind==='present'?goal.value:null
   },
  }),
  prompt(base:string){const {todo,goal}=read();const text=renderTodoSnapshot(todo.kind==='absent'?null:todo.items);const goalText=renderGoalContext(goal.kind==='absent'?null:goal.value);return `${text?`${base}\n\n${text}`:base}\n\n${goalText}`},
  async close(){closing=true;for(const close of [...pending])await close()},
 })
}
