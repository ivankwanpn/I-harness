import {canonicalJsonData,exportConversationSeed,freezeJsonData,type SessionView} from '@i-harness/core-session'
import {compileSemanticSeed,type ChildHistory} from '@i-harness/session-persistence'
import {assertOriginalTaskCaller,type OriginalTaskCaller} from '@i-harness/core-tools/internal/task-caller'

export interface OriginalTaskChildHistory {readonly kind:'original-task-child-history'}
type History={view:SessionView;parentSessionId:string;history:ChildHistory;seed:ReturnType<typeof compileSemanticSeed>;assertCurrent():void}
const histories=new WeakMap<OriginalTaskChildHistory,History>()
/** The original prepared caller captures exactly one cut before setup awaits. */
export function captureTaskChildHistory(caller:OriginalTaskCaller):OriginalTaskChildHistory|undefined {
  assertOriginalTaskCaller(caller)
  const turns=(caller.call.args as {fork_turns?:unknown}).fork_turns
  if(turns===undefined||turns==='none')return
  if(turns!=='all')throw Error('Unsupported task semantic history selection')
  const view=caller.context.view,parentSessionId=caller.identity.parentSessionId
  const count=view.events.length,prefix=canonicalJsonData(view.events)
  const assertCurrent=()=>{
    assertOriginalTaskCaller(caller)
    if(caller.context.view!==view||view.events.length<count||canonicalJsonData(view.events.slice(0,count))!==prefix)throw Error('Original task history changed')
  }
  assertCurrent()
  const exported=exportConversationSeed(view,{kind:'session',sessionId:parentSessionId},{kind:'all'})
  if(exported.kind!=='seed'||exported.seed.version!==1||exported.seed.artifacts.length)throw Error('Unsupported task semantic history dependencies')
  const seed=compileSemanticSeed(exported);freezeJsonData(seed)
  const history=freezeJsonData({selection:{kind:'all' as const},source:{kind:'session' as const,sessionId:parentSessionId}})
  assertCurrent()
  const capability=Object.freeze({kind:'original-task-child-history' as const})
  histories.set(capability,{view,parentSessionId,history,seed,assertCurrent})
  return capability
}
export function inspectTaskChildHistory(capability:OriginalTaskChildHistory,parentSessionId:string) {
  const original=histories.get(capability)
  if(!original||original.parentSessionId!==parentSessionId)throw Error('Original task child history required')
  original.assertCurrent()
  return {history:original.history,seed:original.seed}
}
