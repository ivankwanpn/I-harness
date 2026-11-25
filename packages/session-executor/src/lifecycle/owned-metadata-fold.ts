import {createOwnedTitleProjection,isOwnedTitleSnapshot} from '../../../session-title/src/owned-projection.ts'
import type {SessionEventView, TodoItem} from '@i-harness/core-session'
import {captureExecutionFoldSnapshot,isCapturedExecutionFoldSnapshot} from '@i-harness/core-session/internal/execution'
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
 function namedView<Revision, Snapshot>(
  readRevision:()=>Revision,
  readSnapshot:()=>Snapshot,
  validate:(value:unknown)=>boolean,
 ) {
  let memo:{revision:Revision;snapshot:Snapshot}|undefined
  return {
   snapshot(prefix:Prefix):Snapshot {
    current(prefix)
    const revision=readRevision()
    if(memo&&memo.revision===revision&&isCapturedExecutionFoldSnapshot(memo.snapshot))return memo.snapshot
    const snapshot=captureExecutionFoldSnapshot(readSnapshot())
    memo=isCapturedExecutionFoldSnapshot(snapshot)?{revision,snapshot}:undefined
    return snapshot
   },
   validateSnapshot: validate,
  }
 }
 const fold={
  appendValidated(unit:readonly SessionEventView[],firstOrdinal:number){run(()=>{if(firstOrdinal!==ordinal)throw Error('owned metadata fold ordinal mismatch');installed=undefined;schedule.appendValidated(unit,firstOrdinal);for(const event of unit){const nextTodo=applyTodoProjection(todo,event);if(nextTodo!==todo)todo=structuredClone(nextTodo);goal=applyGoalProjection(goal,event);title.append(event,ordinal);ordinal++}})},
  finishRestore(prefix:Prefix){run(()=>{if(prefix.eventCount!==ordinal)throw Error('owned metadata fold prefix mismatch');schedule.finishRestore(prefix);installed={...prefix}})},
  snapshot(prefix:Prefix){return run(()=>{current(prefix);return schedule.snapshot(prefix)})},
  validateSnapshot(value:unknown){return schedule.validateSnapshot(value)},
  views:{
   title:namedView(title.revision,title.snapshot,isOwnedTitleSnapshot),
   todo:namedView(()=>todo,():TodoSnapshot=>todo===null?{kind:'absent'}:{kind:'present',items:structuredClone(todo)},isTodoSnapshot),
   goal:namedView(()=>goal,():GoalProjectionSnapshot=>goal===null?{kind:'absent'}:{kind:'present',value:structuredClone(goal)},isGoalSnapshot),
  },
 }
 for(const key of ['snapshot','validateSnapshot'] as const){associateArtifactCurrentnessReader(fold,key);for(const view of Object.values(fold.views))associateArtifactCurrentnessReader(view,key)}
 return fold
}
associateArtifactCurrentnessFactory(createOwnedMetadataFold)
