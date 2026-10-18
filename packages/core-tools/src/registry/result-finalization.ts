import { FactRecoveryRequiredError, isManagedSettlementSource, isNondurableSession, isOwnedSettlementSource, type ProducerFactOutcome, type ResultEnvelope, type ResultExecution, type SessionView, type SettlementFacts } from '@i-harness/core-session'
import type { PreparedCall, ToolExec } from '../types.ts'
import { registerResultProducer } from './result-dependencies.ts'

export interface ResultFinalization {
  settle(): Promise<{ kind: 'ready'; envelope: ResultEnvelope; program: ResultProgram } | { kind: 'recovery-required' }>
}
export type ResultProgram = { kind: 'value'; value: unknown } | { kind: 'unavailable'; reason: 'encoding' }
export interface SyntheticResultContext { view: SessionView; source: SettlementFacts<ProducerFactOutcome>; callId: string; name: string }
export interface ToolResultRetention {
  prepare?(prepared: PreparedCall): Promise<void>
  capture(prepared: PreparedCall, output: unknown, execution: ResultExecution): ResultFinalization
  captureSynthetic(context: SyntheticResultContext, output: unknown, execution: ResultExecution): ResultFinalization
}
const prepared = new WeakMap<PreparedCall, { exec: ToolExec; call: PreparedCall['call']; tool: PreparedCall['tool']; name: string; view?: SessionView; callId?: string; source?: SettlementFacts<ProducerFactOutcome> }>()
const execution = new WeakMap<ToolExec, ResultExecution>()
const finalizations = new WeakMap<PreparedCall, ResultFinalization>()
const syntheticFinalizations = new WeakMap<ResultFinalization, Readonly<SyntheticResultContext>>()
export function bindSyntheticFinalization(context: SyntheticResultContext, handle: ResultFinalization): ResultFinalization { syntheticFinalizations.set(handle, Object.freeze({ ...context })); return handle }
export function isOriginalSyntheticResultFinalization(context: SyntheticResultContext, handle: ResultFinalization | undefined): handle is ResultFinalization {
  const original = handle && syntheticFinalizations.get(handle)
  return !!original && original.view === context.view && original.source === context.source && original.callId === context.callId && original.name === context.name
}
export function bindResultFinalization(call: PreparedCall, handle: ResultFinalization): void { assertResultPrepared(call); finalizations.set(call, handle) }
/** A JSON shape or custom registry method cannot impersonate a retained
 * original capture from this genuine prepared-call owner. */
export function isOriginalResultFinalization(call: PreparedCall, handle: ResultFinalization | undefined): handle is ResultFinalization { return handle !== undefined && finalizations.get(call) === handle }

export function registerResultPrepared(call: PreparedCall, source?: SettlementFacts<ProducerFactOutcome>): void {
  prepared.set(call, { exec: call.exec, call: call.call, tool: call.tool, name: call.call.name, view: call.exec.session, callId: call.exec.callId, source })
  execution.set(call.exec, { outcome: 'unknown', dispatch: 'not-dispatched' })
  registerResultProducer(call.exec)
}
export function assertResultPrepared(call: PreparedCall): { view?: SessionView; source?: SettlementFacts<ProducerFactOutcome> } {
  const owned = prepared.get(call)
  if (!owned || owned.exec !== call.exec || owned.call !== call.call || owned.tool !== call.tool || owned.name !== call.call.name
    || owned.view !== call.exec.session || owned.callId !== call.exec.callId) throw new FactRecoveryRequiredError()
  const view = call.exec.session
  if (view && !isNondurableSession(view) && (!owned.source || !isManagedSettlementSource(view, owned.source))) throw new FactRecoveryRequiredError()
  owned.source?.assertHeld()
  return { view, source: owned.source }
}
export function assertSyntheticResult(context: SyntheticResultContext): void {
  if (!isOwnedSettlementSource(context.view, context.source)) throw new FactRecoveryRequiredError()
  context.source.assertHeld()
  const calls = context.view.events.filter(event => (event.type === 'tool/call' || event.type === 'code/call') && event.callId === context.callId && event.name === context.name)
  if (calls.length !== 1) throw new FactRecoveryRequiredError()
}
export function dispatchResultStarted(exec: ToolExec): void {
  if (!execution.has(exec)) throw new FactRecoveryRequiredError()
  execution.set(exec, { outcome: 'unknown', dispatch: 'dispatched' })
}
/** Genuine built-in producers bind outcome to their registered ToolExec. */
export function declareToolResultOutcome(exec: ToolExec, outcome: ResultExecution['outcome']): boolean {
  const current = execution.get(exec)
  if (!current) return false
  if (current.dispatch !== 'dispatched' || !['succeeded', 'failed', 'canceled', 'unknown'].includes(outcome)) throw new FactRecoveryRequiredError()
  execution.set(exec, { outcome, dispatch: current.dispatch })
  return true
}
export function resultExecution(call: PreparedCall): ResultExecution {
  assertResultPrepared(call)
  return { ...(execution.get(call.exec) ?? { outcome: 'unknown', dispatch: 'unknown' }) }
}
export function dispatchResultReturned(exec: ToolExec): void {
  const value = execution.get(exec)
  if (value?.outcome === 'unknown') declareToolResultOutcome(exec, 'succeeded')
}
