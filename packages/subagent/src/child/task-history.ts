import {exportConversationSeed,freezeJsonData,type SessionView} from '@i-harness/core-session'
import {captureManagedHistoryCut,assertManagedHistoryCut} from '@i-harness/core-session/internal/bootstrap'
import {compileSemanticSeed,type ChildHistory} from '@i-harness/session-persistence'
import {assertOriginalTaskCaller,type OriginalTaskCaller} from '@i-harness/core-tools/internal/task-caller'

export interface OriginalTaskChildHistory {readonly kind:'original-task-child-history'}
type History={view:SessionView;parentSessionId:string;history:ChildHistory;seed:ReturnType<typeof compileSemanticSeed>;assertCurrent():void}
const histories=new WeakMap<OriginalTaskChildHistory,History>()
export function parseTaskHistorySelection(value:unknown):'none'|'all'|number {
  if(value===undefined||value==='none')return 'none'
  if(value==='all')return 'all'
  const n=typeof value==='number'?value:typeof value==='string'?Number(value):NaN
  if(Number.isSafeInteger(n)&&n>0)return n
  throw Error('fork_turns must be none, all, or a positive safe integer')
}
/** The original prepared caller captures exactly one cut before setup awaits. */
export function captureTaskChildHistory(caller:OriginalTaskCaller):OriginalTaskChildHistory|undefined {
  assertOriginalTaskCaller(caller)
  const turns=parseTaskHistorySelection((caller.call.args as {fork_turns?:unknown}).fork_turns)
  if(turns==='none')return
  const selection=turns==='all'?{kind:'all' as const}:{kind:'last-turns' as const,count:turns}
  const view=caller.context.view,parentSessionId=caller.identity.parentSessionId
  const owner=caller.context.factOwner,cut=captureManagedHistoryCut(view,owner,parentSessionId)
  const assertCurrent=()=>{
    assertOriginalTaskCaller(caller)
    assertManagedHistoryCut(cut,caller.context.view,caller.context.factOwner,parentSessionId)
  }
  assertCurrent()
  const exported=exportConversationSeed(view,{kind:'session',sessionId:parentSessionId},selection)
  if(exported.kind!=='seed'||exported.seed.version!==1||exported.seed.artifacts.length)throw Error('Unsupported task semantic history dependencies')
  const seed=compileSemanticSeed(exported);freezeJsonData(seed)
  const history=freezeJsonData({selection,source:{kind:'session' as const,sessionId:parentSessionId}})
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
