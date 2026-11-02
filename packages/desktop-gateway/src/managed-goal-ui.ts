import {committedFactSeqs,type CapturedActionFact,type ProducerFactOutcome,type MetadataFact,type GoalOperation} from '@i-harness/core-session'
import {isOriginalExecutionObservation} from '@i-harness/core-session/internal/execution'
import {applyGoalMutation,isGoalSnapshot,type GoalMutationRequest} from '@i-harness/goal'
import type {ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'

/** One retained set of original action captures for the published runtime. */
export function createManagedGoalUi(execution:ManagedExecutionAttachment,assertRuntime:()=>void,retain:(close:()=>Promise<void>)=>void){
 const pending=new Set<()=>Promise<void>>();let closing=false
 const capture=()=>{assertRuntime();const observation=execution.observe();if(!isOriginalExecutionObservation(observation)||observation.identity!==execution.identity)throw TypeError('Original managed Goal observation required');observation.assertCurrent();const goal=observation.metadata.goal;if(goal.kind!=='available'||!isGoalSnapshot(goal.snapshot))throw TypeError('Original Goal fold unavailable');observation.assertCurrent();return {observation,goal:goal.snapshot.kind==='present'?goal.snapshot.value:null,plan:observation.plan()}}
 async function issue(selected:ReturnType<typeof capture>,draft:{event:MetadataFact}|{proposal:string}){
  if(closing||pending.size)throw Error('Goal metadata recovery required')
  const action=execution.owner.beginAction(),guard=()=>{try{action.assertOpen();assertRuntime();selected.observation.assertCurrent();return true}catch{return false}}
  const planCapture=(action as typeof action&{capturePlanProposal?:(proposal:string,check:()=>boolean)=>CapturedActionFact<ProducerFactOutcome>}).capturePlanProposal
  let fact:CapturedActionFact<ProducerFactOutcome>
  try{if('event'in draft){if(!action.captureMetadata)throw TypeError('Original guarded metadata capture required');fact=action.captureMetadata(draft.event,guard)}else{if(!planCapture)throw TypeError('Original guarded Plan proposal capture required');fact=planCapture.call(action,draft.proposal,guard)}}catch(error){action.finish();throw error}
  let invoked=false,terminal=false
  const settle=async()=>{let result=invoked?await fact.observe():await fact.admit();invoked=true;if(result.kind==='unknown'||result.kind==='recovery-required'||result.kind==='not-issued'&&result.code==='FACT_RECOVERY_REQUIRED')result=await fact.reconcile();if(result.kind==='committed'||result.kind==='memory-committed'||result.kind==='not-issued'&&result.code!=='FACT_RECOVERY_REQUIRED')terminal=true;return result}
  let source:ReturnType<typeof action.registerSettlementSource>;try{source=action.registerSettlementSource(async()=>{if(!terminal){const result=await settle();if(!terminal)committedFactSeqs(result)}})}catch(error){action.finish();throw error}
  const close=async()=>{await source.close();action.finish();pending.delete(close)};pending.add(close)
  let failure:unknown,failed=false;try{committedFactSeqs(await settle())}catch(error){failed=true;failure=error}
  if(terminal)try{await close()}catch(cleanup){if(failed)throw new AggregateError([failure,cleanup],'Managed Goal settlement requires recovery',{cause:failure});throw cleanup}
  if(failed)throw failure
 }
 const close=async()=>{closing=true;for(const release of [...pending])await release()};retain(close)
 return Object.freeze({
  read(){const {goal,plan,observation}=capture();return {goal,plan,assertCurrent:()=>observation.assertCurrent()}},
  async mutateGoal(operation:GoalOperation,request:GoalMutationRequest){const selected=capture(),event=applyGoalMutation(selected.goal,operation,request,Date.now()).event;await issue(selected,{event});return capture().goal},
  async setPlan(enabled:boolean,proposal?:string){const selected=capture();await issue(selected,enabled&&proposal?{proposal}:{event:{type:'plan/mode',mode:enabled?'on':'off'}});return capture().plan},
  position(){return capture().observation.eventCount},
  close,
 })
}
