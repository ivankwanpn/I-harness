import {createLegacyReadVisibility,exportConversationSeed,freezeJsonData,type SessionView} from '@i-harness/core-session'
import {captureManagedHistoryCut,assertManagedHistoryCut} from '@i-harness/core-session/internal/bootstrap'
import {compileSemanticSeed,type ChildHistory} from '@i-harness/session-persistence'
import {assertOriginalTaskCaller,type OriginalTaskCaller} from '@i-harness/core-tools/internal/task-caller'
import {reserveManagedTaskHistory} from '@i-harness/core-session/internal/execution'

export interface OriginalTaskChildHistory {readonly kind:'original-task-child-history'}
type History={view:SessionView;parentSessionId:string;owner:object;count:number;hasDependencies:boolean;hasLegacy:boolean;inheritedLegacyUnknown:boolean;history:ChildHistory;seed:ReturnType<typeof compileSemanticSeed>;assertCurrent():void}
const histories=new WeakMap<OriginalTaskChildHistory,History>()
type ManagedHistory={parentSessionId:string;domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain;reservation:ReturnType<typeof reserveManagedTaskHistory>;selection:{kind:'all'}|{kind:'last-turns';count:number};history:ChildHistory;seed?:ReturnType<typeof compileSemanticSeed>;preparing?:Promise<void>}
const managedHistories=new WeakMap<OriginalTaskChildHistory,ManagedHistory>()
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
  if('kind' in caller.context){
    const selection=turns==='all'?{kind:'all' as const}:{kind:'last-turns' as const,count:turns},parentSessionId=caller.identity.parentSessionId
    const reservation=reserveManagedTaskHistory(caller.context.domain,caller.source),capability=Object.freeze({kind:'original-task-child-history' as const})
    managedHistories.set(capability,{parentSessionId,domain:caller.context.domain,reservation,selection,history:freezeJsonData({selection,source:{kind:'session' as const,sessionId:parentSessionId}})})
    return capability
  }
  const selection=turns==='all'?{kind:'all' as const}:{kind:'last-turns' as const,count:turns}
  const context=caller.context,view=context.view,parentSessionId=caller.identity.parentSessionId
  const owner=context.factOwner,cut=captureManagedHistoryCut(view,owner,parentSessionId)
  const assertCurrent=()=>{
    assertOriginalTaskCaller(caller)
    if(caller.context!==context)throw Error('Original task caller context changed')
    assertManagedHistoryCut(cut,context.view,context.factOwner,parentSessionId)
  }
  assertCurrent()
  const exported=exportConversationSeed(view,{kind:'session',sessionId:parentSessionId},selection)
  if(exported.kind!=='seed'||exported.seed.version!==1)throw Error('Unsupported task semantic history dependencies')
  const legacy=createLegacyReadVisibility(view)
  if(legacy.kind!=='visible')throw Error('Unsupported task legacy result membership')
  const hasLegacy=!legacy.local()[Symbol.iterator]().next().done
  const seed=compileSemanticSeed(exported);freezeJsonData(seed)
  const history=freezeJsonData({selection,source:{kind:'session' as const,sessionId:parentSessionId}})
  assertCurrent()
  const capability=Object.freeze({kind:'original-task-child-history' as const})
  histories.set(capability,{view,owner,parentSessionId,count:view.events.length,hasDependencies:exported.seed.artifacts.length>0,hasLegacy,inheritedLegacyUnknown:view.header?.semanticSeed!==undefined,history,seed,assertCurrent})
  return capability
}
export function inspectTaskChildHistory(capability:OriginalTaskChildHistory,parentSessionId:string) {
  const managed=managedHistories.get(capability)
  if(managed){if(managed.parentSessionId!==parentSessionId||!managed.seed)throw Error('Original managed task history unavailable');managed.reservation.assertCurrent();return {history:managed.history,seed:managed.seed}}
  const original=histories.get(capability)
  if(!original||original.parentSessionId!==parentSessionId)throw Error('Original task child history required')
  original.assertCurrent()
  return {history:original.history,seed:original.seed}
}

export function managedTaskHistoryFor(capability:OriginalTaskChildHistory){return managedHistories.get(capability)}
export function isManagedTaskChildHistory(capability:OriginalTaskChildHistory){return managedHistories.has(capability)}
export function inspectManagedTaskChildHistory(capability:OriginalTaskChildHistory,parentSessionId:string){
 const original=managedHistories.get(capability);if(!original||original.parentSessionId!==parentSessionId||!original.seed)throw Error('Original managed task history required')
 original.reservation.assertCurrent();const manifest=original.seed.records[0];if(!manifest||manifest.type!=='conversation/seed-manifest')throw Error('Original task seed manifest unavailable')
 return Object.freeze({kind:'managed' as const,domain:original.domain,reservation:original.reservation,artifacts:manifest.artifacts,hasDependencies:manifest.artifacts.length>0,legacy:original.reservation.legacy,hasLegacy:original.reservation.legacy==='visible',inheritedLegacyUnknown:original.reservation.inheritedLegacyUnknown,assertCurrent:original.reservation.assertCurrent.bind(original.reservation)})
}
export const inspectManagedTaskChildSource=inspectManagedTaskChildHistory
export async function prepareTaskChildHistory(capability:OriginalTaskChildHistory){
 const managed=managedHistories.get(capability);if(!managed||managed.seed)return
 const pending=managed.preparing??=(async()=>{const exported=await managed.reservation.export(managed.selection);managed.reservation.assertCurrent();if(exported.kind!=='seed'||exported.seed.version!==1||managed.reservation.legacy!=='absent')throw Error('Unsupported managed task semantic history dependencies');const seed=compileSemanticSeed(exported);freezeJsonData(seed);managed.seed=seed})()
 await pending
}

/** Private host association. The caller cut, view and owner remain nominal. */
export function inspectTaskChildSource(capability:OriginalTaskChildHistory,parentSessionId:string) {
 const original=histories.get(capability)
 if(!original||original.parentSessionId!==parentSessionId)throw Error('Original task child history required')
 original.assertCurrent()
 const manifest=original.seed.records[0]
 if(!manifest||manifest.type!=='conversation/seed-manifest')throw Error('Original task seed manifest unavailable')
 return Object.freeze({kind:'public' as const,view:original.view,owner:original.owner,count:original.count,artifacts:manifest.artifacts,hasDependencies:original.hasDependencies,hasLegacy:original.hasLegacy,inheritedLegacyUnknown:original.inheritedLegacyUnknown,assertCurrent:original.assertCurrent})
}
