import { onExecutionEvent } from '@i-harness/core-plugin'
import { assertManagedActionLifetimeCurrent } from '@i-harness/core-session/internal/execution'
import { committedFactSeqs, type CapturedActionFact, type ProducerFactOutcome } from '@i-harness/core-session'
import { PLAN_MODE_SYSTEM_PROMPT } from '../../plan-mode/src/index.ts'
import type { ManagedRegistryConstruction } from '../../session-executor/src/managed-assembly.ts'

/** Plan state and mutation receipts belong to the original execution. */
export async function mountOwnedPlan(original: ManagedRegistryConstruction, initiallyEnabled = false) {
 const pending = new Set<() => Promise<void>>()
 const lifetime = Object.getOwnPropertyDescriptor(original,'assertLifetimeCurrent')?.value
 if (typeof lifetime !== 'function') throw TypeError('Original construction lifetime required')
 let closing = false
 const projection = () => {
  original.assertLifetimeCurrent()
  const observation = original.execution.observe()
  const plan = observation.plan()
  observation.assertCurrent()
  original.assertLifetimeCurrent()
  return {observation,plan}
 }
 const capture = () => { original.assertCurrent(); const selected=projection(); original.assertCurrent(); return selected }
 const read = () => capture().plan
 const close = async () => { closing = true; for (const finish of [...pending]) await finish() }
 original.retain(close)
 const change = async (selected: ReturnType<typeof capture>, mode:'on'|'off', signal?:AbortSignal) => {
  if (closing || pending.size) throw Error('Plan metadata recovery required')
  original.assertCurrent()
  selected.observation.assertCurrent()
  const action = original.execution.owner.beginAction(signal), guarded = action.captureMetadata
  if (!guarded) { action.finish(); throw TypeError('Guarded original metadata capture required') }
  let fact:CapturedActionFact<ProducerFactOutcome>
  try { fact = guarded.call(action,{type:'plan/mode',mode},()=>{try {
    if (closing) return false
    const field=Object.getOwnPropertyDescriptor(original,'assertLifetimeCurrent')
    if(!field||!('value' in field)||field.value!==lifetime)return false
    Reflect.apply(lifetime,original,[])
    assertManagedActionLifetimeCurrent(original.domain,action)
    action.assertOpen()
    selected.observation.assertCurrent()
    return true
  } catch { return false }}) }
  catch (error) { action.finish(); throw error }
  let invoked=false, terminal=false, source:ReturnType<typeof action.registerSettlementSource>
  const settle = async () => { let outcome=invoked?await fact.observe():await fact.admit(); invoked=true; if(outcome.kind==='unknown'||outcome.kind==='recovery-required'||outcome.kind==='not-issued'&&outcome.code==='FACT_RECOVERY_REQUIRED') outcome=await fact.reconcile(); if(outcome.kind==='committed'||outcome.kind==='memory-committed'||outcome.kind==='not-issued'&&outcome.code!=='FACT_RECOVERY_REQUIRED')terminal=true; return outcome }
  try { source=action.registerSettlementSource(async()=>{if(!terminal){const outcome=await settle();if(!terminal)committedFactSeqs(outcome)}}) } catch(error) { action.finish(); throw error }
  const finish=async()=>{await source.close();action.finish();pending.delete(finish)}
  pending.add(finish)
  let failed=false,failure:unknown
  try { committedFactSeqs(await settle()) } catch(error) {failed=true;failure=error}
  if(terminal)try {await finish()} catch(cleanup) {if(failed)throw new AggregateError([failure,cleanup],'Plan metadata settlement requires recovery',{cause:failure});throw cleanup}
  if(failed)throw failure
 }
 const initial = capture()
 if (initiallyEnabled && initial.plan.eventSeq === undefined) { await change(initial,'on'); original.assertCurrent() }
 if (original.tools.get('exit_plan_mode')) throw Error('duplicate tool registration: exit_plan_mode')
 original.tools.register({name:'exit_plan_mode', description:'Signal that the plan is complete and plan mode should end. No arguments.', inputSchema:{type:'object',properties:undefined,required:undefined},isReadOnly:true,
  async execute(_args, exec) { const selected=capture(); if (!selected.plan.active) return {active:false}; await change(selected,'off',exec.abortSignal); return {active:true} }})
 onExecutionEvent(original.ctx,'tools/pre-execute',call => {const name=(call as {name?:string})?.name; if(read().active && (!name || original.tools.get(name)?.isReadOnly!==true)) throw Object.assign(new Error('Plan Mode permits only read-only tools'),{policyRefusal:true}); return call})
 return Object.freeze({read, prompt:()=>projection().plan.active ? PLAN_MODE_SYSTEM_PROMPT : ''})
}
