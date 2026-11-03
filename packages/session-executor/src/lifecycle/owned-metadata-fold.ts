import {createOwnedTitleProjection,isOwnedTitleSnapshot} from '../../../session-title/src/owned-projection.ts'
import type {SessionEventView, TodoItem} from '@i-harness/core-session'
import {createScheduleFoldSink} from '@i-harness/schedule'
import {applyTodoProjection,isTodoSnapshot,type TodoSnapshot} from '@i-harness/todo'
import {applyGoalProjection,isGoalSnapshot,type GoalView,type GoalProjectionSnapshot} from '../../../goal/src/index.ts'
import {associateArtifactCurrentnessReader,associateArtifactCurrentnessFactory} from '../../../session-persistence/src/coordinator/artifact-path-association.ts'

type Prefix = Readonly<{eventCount:number;bodyBytes:number;prefixDigest:string}>

/** One original stream; Schedule remains the unchanged root snapshot. */
export function createOwnedMetadataFold(source:{sessionId:string;seedLength:number;formatVersion:number}) {
 const schedule=createScheduleFoldSink(source)
 const title=createOwnedTitleProjection()
 let todo:readonly TodoItem[]|null=null,goal:GoalView|null=null,ordinal=0,installed:Prefix|undefined,poisoned=false
 const check=()=>{if(poisoned)throw Error('owned metadata fold poisoned')}
 const run=<T>(fn:()=>T):T=>{check();try{return fn()}catch(error){poisoned=true;throw error}}
 const current=(prefix:Prefix)=>{check();if(!installed||prefix.eventCount!==installed.eventCount||prefix.bodyBytes!==installed.bodyBytes||prefix.prefixDigest!==installed.prefixDigest)throw Error('owned metadata fold prefix mismatch')}
 const fold={
  appendValidated(unit:readonly SessionEventView[],firstOrdinal:number){run(()=>{if(firstOrdinal!==ordinal)throw Error('owned metadata fold ordinal mismatch');installed=undefined;schedule.appendValidated(unit,firstOrdinal);for(const event of unit){const nextTodo=applyTodoProjection(todo,event);if(nextTodo!==todo)todo=structuredClone(nextTodo);goal=applyGoalProjection(goal,event);title.append(event,ordinal);ordinal++}})},
  finishRestore(prefix:Prefix){run(()=>{if(prefix.eventCount!==ordinal)throw Error('owned metadata fold prefix mismatch');schedule.finishRestore(prefix);installed={...prefix}})},
  snapshot(prefix:Prefix){return run(()=>{current(prefix);return schedule.snapshot(prefix)})},
  validateSnapshot(value:unknown){return schedule.validateSnapshot(value)},
  views:{
   title:{snapshot(prefix:Prefix){current(prefix);return title.snapshot()},validateSnapshot:isOwnedTitleSnapshot},
   todo:{snapshot(prefix:Prefix):TodoSnapshot{current(prefix);return todo===null?{kind:'absent'}:{kind:'present',items:structuredClone(todo)}},validateSnapshot:isTodoSnapshot},
   goal:{snapshot(prefix:Prefix):GoalProjectionSnapshot{current(prefix);return goal===null?{kind:'absent'}:{kind:'present',value:structuredClone(goal)}},validateSnapshot:isGoalSnapshot},
  },
 }
 for(const key of ['snapshot','validateSnapshot'] as const){associateArtifactCurrentnessReader(fold,key);for(const view of Object.values(fold.views))associateArtifactCurrentnessReader(view,key)}
 return fold
}
associateArtifactCurrentnessFactory(createOwnedMetadataFold)
