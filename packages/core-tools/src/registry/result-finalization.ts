import { FactRecoveryRequiredError,captureLegacyFact, isManagedSettlementSource, isNondurableSession, isOwnedSettlementSource, type ProducerFactOutcome, type ResultEnvelope, type ResultExecution, type SessionView, type SettlementFacts } from '@i-harness/core-session'
import type { PreparedCall, ToolExec,ToolResult } from '../types.ts'
import { registerResultProducer } from './result-dependencies.ts'
import {isManagedExecutionSource,readManagedAcknowledgedMembers,readManagedActionSourceMembers,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'

export interface ResultFinalization {
  settle(): Promise<{ kind: 'ready'; envelope: ResultEnvelope; program: ResultProgram } | { kind: 'recovery-required' }>
}
export type ResultProgram = { kind: 'value'; value: unknown } | { kind: 'unavailable'; reason: 'encoding' }
export interface SyntheticResultContext { view: SessionView; source: SettlementFacts<ProducerFactOutcome>; callId: string; name: string }
export type ManagedSyntheticResultContext = {domain:ManagedExecutionDomain;source:SettlementFacts<ProducerFactOutcome>;callId:string;name:string;capture:object;outcome:Extract<import('@i-harness/core-session').FactOutcome,{kind:'committed'}>} & ({kind?:'tool'}|{kind:'code';cellId:string;action:import('@i-harness/core-session').ManagedAction<ProducerFactOutcome>})
export interface ToolResultRetention {
  prepareManaged?(prepared:PreparedCall,domain:ManagedExecutionDomain):Promise<void>
  prepare?(prepared: PreparedCall, executionOwner?: import('./prepared-body.ts').ToolExecutionOwnerContext): Promise<void>
  capture(prepared: PreparedCall, output: unknown, execution: ResultExecution): ResultFinalization
  captureSynthetic(context: SyntheticResultContext, output: unknown, execution: ResultExecution): ResultFinalization
  captureManagedSynthetic?(context:ManagedSyntheticResultContext,output:unknown,execution:ResultExecution):ResultFinalization
}
const prepared = new WeakMap<PreparedCall, { exec: ToolExec; call: PreparedCall['call']; tool: PreparedCall['tool']; name: string; view?: SessionView;domain?:ManagedExecutionDomain; callId?: string; source?: SettlementFacts<ProducerFactOutcome>;hasDispatch?:true;dispatched?:unknown;finalized?:ToolResult }>()
const execution = new WeakMap<ToolExec, ResultExecution & { declared?: true; presentation?: 'mcp' }>()
const finalizations = new WeakMap<PreparedCall, ResultFinalization>()
const syntheticFinalizations = new WeakMap<ResultFinalization, Readonly<SyntheticResultContext|ManagedSyntheticResultContext>>()
export function bindSyntheticFinalization(context: SyntheticResultContext|ManagedSyntheticResultContext, handle: ResultFinalization): ResultFinalization { syntheticFinalizations.set(handle, Object.freeze({ ...context })); return handle }
export function isOriginalSyntheticResultFinalization(context: SyntheticResultContext|ManagedSyntheticResultContext, handle: ResultFinalization | undefined): handle is ResultFinalization {
  const original = handle && syntheticFinalizations.get(handle)
  return !!original && ('domain'in original?'domain'in context&&original.domain===context.domain&&original.capture===context.capture&&original.outcome===context.outcome&&original.kind===context.kind&&(original.kind!=='code'||context.kind==='code'&&original.action===context.action&&original.cellId===context.cellId):'view'in context&&original.view===context.view) && original.source === context.source && original.callId === context.callId && original.name === context.name
}
export function bindResultFinalization(call: PreparedCall, handle: ResultFinalization): void { assertResultPrepared(call); finalizations.set(call, handle) }
/** A JSON shape or custom registry method cannot impersonate a retained
 * original capture from this genuine prepared-call owner. */
export function isOriginalResultFinalization(call: PreparedCall, handle: ResultFinalization | undefined): handle is ResultFinalization { return handle !== undefined && finalizations.get(call) === handle }

export function registerResultPrepared(call: PreparedCall, source?: SettlementFacts<ProducerFactOutcome>,domain?:ManagedExecutionDomain): void {
  if(domain&&(call.exec.session||!source||!isManagedExecutionSource(domain,source)))throw new FactRecoveryRequiredError()
  prepared.set(call, { exec: call.exec, call: call.call, tool: call.tool, name: call.call.name, view: call.exec.session,domain, callId: call.exec.callId, source })
  execution.set(call.exec, { outcome: 'unknown', dispatch: 'not-dispatched' })
  registerResultProducer(call.exec)
}
export function assertResultPrepared(call: PreparedCall): { view?: SessionView;domain?:ManagedExecutionDomain; source?: SettlementFacts<ProducerFactOutcome> } {
  const owned = prepared.get(call)
  if (!owned || owned.exec !== call.exec || owned.call !== call.call || owned.tool !== call.tool || owned.name !== call.call.name
    || owned.view !== call.exec.session || owned.callId !== call.exec.callId) throw new FactRecoveryRequiredError()
  const view = call.exec.session
  if(owned.domain&&(view||!owned.source||!isManagedExecutionSource(owned.domain,owned.source)))throw new FactRecoveryRequiredError()
  if (view && !isNondurableSession(view) && (!owned.source || !isManagedSettlementSource(view, owned.source))) throw new FactRecoveryRequiredError()
  owned.source?.assertHeld()
  return { view,domain:owned.domain, source: owned.source }
}
export function assertSyntheticResult(context: SyntheticResultContext): void {
  if (!isOwnedSettlementSource(context.view, context.source)) throw new FactRecoveryRequiredError()
  context.source.assertHeld()
  const calls = context.view.events.filter(event => (event.type === 'tool/call' || event.type === 'code/call') && event.callId === context.callId && event.name === context.name)
  if (calls.length !== 1) throw new FactRecoveryRequiredError()
}
export function assertManagedSyntheticResult(context:ManagedSyntheticResultContext){if(!isManagedExecutionSource(context.domain,context.source))throw new FactRecoveryRequiredError();context.source.assertHeld();const members=context.kind==='code'?readManagedActionSourceMembers(context.domain,context.action,context.source,context.capture,context.outcome):readManagedAcknowledgedMembers(context.domain,context.capture,context.outcome);const event=members[0];if(members.length!==1||!event||(event.type!=='tool/call'&&event.type!=='code/call')||event.callId!==context.callId||event.name!==context.name||(context.kind==='code'?event.type!=='code/call'||event.cellId!==context.cellId:event.type!=='tool/call'))throw new FactRecoveryRequiredError()}
/** Only the original dispatcher or its branded retained-body take calls this.
 * Data/seq/ToolExec labels cannot register a completed private result. */
export function recordDispatchedToolResult(call:PreparedCall,output:unknown){const owned=prepared.get(call);if(!owned?.domain)return;assertResultPrepared(call);if(owned.hasDispatch&&!Object.is(owned.dispatched,output))throw new FactRecoveryRequiredError();owned.hasDispatch=true;owned.dispatched=output}
export function capturePrivateFinalizedToolResult(call:PreparedCall,output:unknown):ToolResult|undefined{assertResultPrepared(call);const owned=prepared.get(call)!;if(!owned.domain)return;if(!owned.hasDispatch||!Object.is(owned.dispatched,output))throw new FactRecoveryRequiredError();const actual=execution.get(owned.exec);if(actual?.outcome!=='succeeded'||actual.dispatch!=='dispatched')throw new FactRecoveryRequiredError();if(!owned.finalized){const captured=captureLegacyFact(output);if(captured.kind!=='captured')throw new FactRecoveryRequiredError();owned.finalized=Object.freeze({name:owned.name,output:captured.value})}return owned.finalized}
export function retainedFinalizedToolResult(call:PreparedCall):ToolResult|undefined{const owned=prepared.get(call);if(!owned?.finalized||!owned.domain)return;if(!owned.source||!isManagedExecutionSource(owned.domain,owned.source))throw new FactRecoveryRequiredError();return owned.finalized}
export function releaseFinalizedToolResult(call:PreparedCall):void{const owned=prepared.get(call);if(owned){delete owned.dispatched;delete owned.hasDispatch;delete owned.finalized}}
export function dispatchResultStarted(exec: ToolExec): void {
  if (!execution.has(exec)) throw new FactRecoveryRequiredError()
  execution.set(exec, { outcome: 'unknown', dispatch: 'dispatched' })
}
/** Genuine built-in producers bind outcome to their registered ToolExec. */
export function declareToolResultOutcome(exec: ToolExec, outcome: ResultExecution['outcome']): boolean {
  const current = execution.get(exec)
  if (!current) return false
  if (current.dispatch !== 'dispatched' || !['succeeded', 'failed', 'canceled', 'unknown'].includes(outcome)) throw new FactRecoveryRequiredError()
  execution.set(exec, { ...current, outcome, declared: true })
  return true
}
/** Presentation is runtime metadata of the genuine dispatched producer. */
export function declareToolResultPresentation(exec: ToolExec, presentation: 'mcp'): boolean {
  const current = execution.get(exec)
  if (!current) return false
  if (current.dispatch !== 'dispatched' || presentation !== 'mcp') throw new FactRecoveryRequiredError()
  execution.set(exec, { ...current, presentation })
  return true
}
export function resultPresentation(call: PreparedCall): 'mcp' | undefined {
  assertResultPrepared(call)
  return execution.get(call.exec)?.presentation
}
export function resultExecution(call: PreparedCall): ResultExecution {
  assertResultPrepared(call)
  const { outcome, dispatch } = execution.get(call.exec) ?? { outcome: 'unknown', dispatch: 'unknown' }
  return { outcome, dispatch }
}
export function settleUndeclaredDispatch(exec: ToolExec, outcome: ResultExecution['outcome']): void {
  const value = execution.get(exec)
  if (value && !value.declared) declareToolResultOutcome(exec, outcome)
}
