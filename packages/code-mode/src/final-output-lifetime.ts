import type { FactOwner } from '@i-harness/core-session'
import { isOriginalCellFinalization, type OriginalCellFinalization } from './finalization.ts'
import { AsyncLocalStorage } from 'node:async_hooks'

type Lifetime = { waits: Map<Lifetime,number> }
type DrainFrame = { lifetime:Lifetime;parent?:DrainFrame;active:boolean }
const drains=new AsyncLocalStorage<DrainFrame>()
function currentDrain(){for(let frame=drains.getStore();frame;frame=frame.parent)if(frame.active)return frame.lifetime}
function reaches(start:Lifetime,target:Lifetime){
  const pending=[start],seen=new Set<Lifetime>()
  while(pending.length){const item=pending.pop()!;if(item===target)return true;if(seen.has(item))continue;seen.add(item);pending.push(...item.waits.keys())}
  return false
}
function joinOriginal<T>(caller:Lifetime|undefined,target:Lifetime,flight:Promise<T>):Promise<T>{
  if(!caller)return flight
  caller.waits.set(target,(caller.waits.get(target)??0)+1)
  const retired=()=>{const count=caller.waits.get(target);if(count===undefined)return;if(count===1)caller.waits.delete(target);else caller.waits.set(target,count-1)}
  return flight.then(value=>{retired();return value},cause=>{retired();throw cause})
}

/** Independent original source, enrolled at admission. Its lifecycle may await
 * cell finalization; the cell/queue must never await this source's close. */
export function createFinalOutputLifetime<T, Operation extends { finish(): Promise<T> } = { finish(): Promise<T> }>(owner: FactOwner, finalization: OriginalCellFinalization,
  construct: (assertHeld: () => void) => Operation, expectedSessionId?:string, afterFinish?: (operation:Operation,result:T)=>void) {
  if (!isOriginalCellFinalization(finalization,owner) || finalization.scope !== 'cell-finalization') throw new Error('Original matching mount cell finalization required')
  const action = owner.beginAction()
  if(expectedSessionId!==undefined&&action.owner?.sessionId!==expectedSessionId){action.finish();throw new Error('Original retention action/session mismatch')}
  let operation: ReturnType<typeof construct> | undefined, failed = false, failure: unknown
  let finishOriginal:(()=>Promise<T>)|undefined
  let result: T, finished = false, acknowledged = false, closeFlight:Promise<T>|undefined
  const lifetime:Lifetime={waits:new Map()}
  const source = (() => { try { return action.registerSettlementSource(() => {
    const frame:DrainFrame={lifetime,parent:drains.getStore(),active:true}
    return drains.run(frame,async()=>{try{
    await finalization.settle()
    if (failed) throw failure
    if (!finished) { result = await finishOriginal!(); afterFinish?.(operation!,result); finished = true }
    }finally{frame.active=false}})
  }) } finally { action.finish() } })()
  const held=source.assertHeld.bind(source),close=source.close.bind(source)
  const assertHeld = () => held()
  try { operation = construct(assertHeld);finishOriginal=operation.finish.bind(operation) } catch (cause) { failed = true; failure = cause }
  return Object.freeze({
    assertHeld,
    get operation() { if (failed) throw failure; return operation! },
    settle(): Promise<T> {
      if (acknowledged) return Promise.resolve(result!)
      const caller=currentDrain()
      if(caller&&reaches(lifetime,caller))return Promise.reject(Object.assign(new Error('Original Code completion cyclic close wait refused'),{code:'FACT_RECOVERY_REQUIRED'}))
      if (closeFlight) return joinOriginal(caller,lifetime,closeFlight)
      const frame:DrainFrame={lifetime,parent:drains.getStore(),active:true}
      const flight=Promise.resolve().then(()=>drains.run(frame,async()=>{try{await close()}finally{frame.active=false}})).then(()=>{acknowledged=true;lifetime.waits.clear();return result!})
      closeFlight=flight
      void flight.catch(()=>{if(closeFlight===flight)closeFlight=undefined})
      return joinOriginal(caller,lifetime,flight)
    },
  })
}
