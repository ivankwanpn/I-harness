import { createHash } from 'node:crypto'
import { canonicalJsonData, committedFactSeqs, FactRecoveryRequiredError, isStrictFactData, SYSTEM_INPUT_PLUGIN,
  type AdmittedInput, type PendingInput, type SessionEvent, type InputFacts, type ProducerFactOutcome, type CapturedSettlementFact } from '@i-harness/core-session'
import { isManagedExecutionOwner } from '@i-harness/core-session/internal/execution'
import type { ManagedExecutionAttachment } from '../../../session-persistence/src/execution-internal.ts'
import { copyConversationData } from '../../../core-session/src/conversation/render.ts'
type InputEvent = Extract<SessionEvent, { type: 'agent/input/admitted' | 'agent/input/cancelled' }>
const owners = new WeakMap<object, ReturnType<typeof createExecutionInputs>>()
export function receivedExecutionInputsFor(execution: ManagedExecutionAttachment) {
  if (!isManagedExecutionOwner(execution.identity, execution.owner)) throw new TypeError('Original execution owner required')
  let inputs = owners.get(execution.owner)
  if (!inputs) { inputs = createExecutionInputs(execution); owners.set(execution.owner, inputs) }
  return inputs
}
function createExecutionInputs(execution: ManagedExecutionAttachment) {
  const pending = new Map<string | symbol, { fingerprint?: string; capture: CapturedSettlementFact<ProducerFactOutcome>; invoked: boolean }>()
  const settle = async (key: string | symbol, record: typeof pending extends Map<unknown, infer V> ? V : never) => {
    let outcome = record.invoked ? await record.capture.observe() : await record.capture.admit()
    record.invoked = true
    if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required' || outcome.kind === 'not-issued' && outcome.code === 'FACT_RECOVERY_REQUIRED') outcome = await record.capture.reconcile()
    if (outcome.kind === 'committed' || outcome.kind === 'memory-committed') pending.delete(key)
    return outcome
  }
  const source = execution.owner.registerReceivedInputSource(async () => {
    const failures: unknown[] = []
    for (const [key, record] of pending) try { committedFactSeqs(await settle(key, record)) } catch (cause) { failures.push(cause) }
    if (failures.length) throw Object.assign(new FactRecoveryRequiredError(),{cause:new AggregateError(failures)})
  })
  const receive = async (event: InputEvent, admitted: boolean) => {
    let strict = false
    try { strict = isStrictFactData(event) } catch { /* Original capture owns refusal. */ }
    const key = strict ? `${admitted ? 'admit' : 'cancel'}:${event.inputId}` : Symbol('invalid')
    const fingerprint = strict ? createHash('sha256').update(canonicalJsonData(event)).digest('hex') : undefined
    let record = pending.get(key)
    if (record && record.fingerprint !== fingerprint) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } as const
    if (!record) {
      if (strict && admitted && execution.observe().inbox.everAdmitted(event.inputId)) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } as const
      record = { fingerprint, invoked: false, capture: admitted ? source.captureAdmitted(event as Extract<InputEvent, {type:'agent/input/admitted'}>) : source.captureCancellation(event as Extract<InputEvent,{type:'agent/input/cancelled'}>) }
      pending.set(key, record)
    }
    return settle(key, record)
  }
  const facts = (signal?: AbortSignal): InputFacts<ProducerFactOutcome> => {
    const optional = async (invoke: (input: InputFacts<ProducerFactOutcome>) => Promise<ProducerFactOutcome>) => {
      const action = execution.owner.beginAction(signal)
      try { return await invoke(action.facts.inputs) } finally { action.finish() }
    }
    return { admit: e => receive(e,true), cancel: e => receive(e,false), start: (...args) => optional(f=>f.start(...args)), claim: (...args) => optional(f=>f.claim(...args)), scheduled: (...args) => optional(f=>f.scheduled(...args)) }
  }
  const inbox = {
    everAdmitted(id: string) { return execution.observe().inbox.everAdmitted(id) },
    pending(): PendingInput[] { const observation=execution.observe(); return copyConversationData(observation.inbox.pending().filter(input=>observation.inbox.isExecutable(input.inputId))) },
    isPending(id: string) { const observation=execution.observe(); return observation.inbox.isPending(id) && observation.inbox.isExecutable(id) },
    async admit(input: AdmittedInput, signal?: AbortSignal) { signal?.throwIfAborted(); const [seq]=committedFactSeqs(await facts(signal).admit({type:'agent/input/admitted',version:1,...input})); return seq! },
    async cancel(inputId: string, reason?: string) {
      if (!execution.observe().inbox.isPending(inputId)) return false
      const result=await facts().cancel({type:'agent/input/cancelled',version:1,inputId,...(reason===undefined?{}:{reason})})
      if(result.kind==='not-issued'&&result.code==='FACT_INVALID_GROUP'&&!execution.observe().inbox.isPending(inputId))return false
      committedFactSeqs(result);return true
    },
    async claimAtStepBoundary(inputFacts?: InputFacts<ProducerFactOutcome>, prepare?: (input: PendingInput)=>Promise<import('@i-harness/core-session').PreparedInputResult|undefined>, claim?: InputFacts<ProducerFactOutcome>['claim']) {
      for(const input of inbox.pending().filter(input=>input.delivery==='steer')) {
        const prepared=await prepare?.(input)
        committedFactSeqs(await (claim??(inputFacts??facts()).claim)({type:'agent/input/promoted',version:1,inputId:input.inputId},{type:'user/message',text:input.text,...(input.provenance?{provenance:input.provenance}:{}),input:{inputId:input.inputId,intent:input.intent,...(input.provenance?{provenance:input.provenance}:{}),...(input.synthetic?{synthetic:input.synthetic}:{})},...(input.images?.length?{imageInputId:input.inputId}:{}),...(input.intent==='system'?{source:{kind:'plugin',plugin:SYSTEM_INPUT_PLUGIN} as const}:{})},prepared))
      }
    },
  }
  return Object.freeze({ inbox:Object.freeze(inbox), facts, close: ()=>source.close() })
}
