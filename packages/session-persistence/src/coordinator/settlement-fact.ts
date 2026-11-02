import { captureFactGroup, type BatchKey, type CapturedFactGroup, type CapturedSettlementFact, type FactGroupDraft, type FactOutcome } from '@i-harness/core-session'
import type { CapturedActionFact } from '@i-harness/core-session'
import type { OriginalExecutionCaptureHooks } from '@i-harness/core-session/internal/execution'

const memberFactories=new WeakMap<object,OriginalExecutionCaptureHooks>()
const retiredCodeHandoffs=new WeakMap<object,()=>FactOutcome|undefined>()
/** Only the original retained Code handoff can prove a known never-issued retirement. */
export function isRetiredCodeHandoff(capture:object,outcome:import('@i-harness/core-session').ProducerFactOutcome):boolean{return !!outcome&&retiredCodeHandoffs.get(capture)?.()===outcome&&outcome.kind==='not-issued'&&outcome.code==='FACT_PRECONDITION_STALE'}
/** Actual factories construct their own wrapper. The incoming commands object
 * is never registered; ordinary captures without this private hook stay ordinary. */
export function forwardSettlementCapture<T extends CapturedActionFact<FactOutcome>>(original:CapturedActionFact<FactOutcome>,commands:T):T{
  const factory=memberFactories.get(original),retirement=retiredCodeHandoffs.get(original)
  if(!factory)return commands
  const forwarded=factory.forward(original,commands)
  memberFactories.set(forwarded,factory)
  if(retirement)retiredCodeHandoffs.set(forwarded,retirement)
  return forwarded
}

export type InvalidNotIssued = Extract<FactOutcome, { kind: 'not-issued' }> & { code: 'FACT_INVALID_GROUP' }
interface CaptureRetirement { accepts(outcome: InvalidNotIssued): boolean; retired(): void }

/** Source retains this once-lowered capture with its real outcome slot. The
 * serialized handle consumes success and never treats uncertainty as absence. */
export function captureSettlementFact(draft: FactGroupDraft, operations: {
  assertHeld(): void
  admit(group: CapturedFactGroup): Promise<FactOutcome>
  reconcile(key: BatchKey): Promise<FactOutcome>
  status(group: CapturedFactGroup): FactOutcome | undefined
  quarantineCapture(): void
  captureMembers?:OriginalExecutionCaptureHooks
}, synchronousAdmission = false, retirement?: CaptureRetirement, neverIssuedStale?:()=>void): CapturedSettlementFact {
  return retainSettlementCapture(captureFactGroup(draft), operations, synchronousAdmission, retirement, neverIssuedStale)
}
export function retainSettlementCapture(capture: ReturnType<typeof captureFactGroup>, operations: Parameters<typeof captureSettlementFact>[1], synchronousAdmission = false, retirement?: CaptureRetirement, neverIssuedStale?:()=>void): CapturedSettlementFact {
  if (capture.kind !== 'captured') operations.quarantineCapture()
  let latest: FactOutcome | undefined, serial: Promise<void> | undefined = synchronousAdmission ? undefined : Promise.resolve()
  let retired: FactOutcome | undefined, everIssued=false
  const observeIssued=(outcome:FactOutcome)=>{if(outcome.kind!=="not-issued")everIssued=true}
  const track = (work: () => Promise<FactOutcome>): Promise<FactOutcome> => {
    if (!retirement && !neverIssuedStale) {
      const result = serial ? serial.then(work) : work()
      serial = result.then(() => {}, () => {})
      return result
    }
    const run = async () => {
      operations.assertHeld()
      if (retired) return retired
      const outcome = await work()
      // latest is populated only by native status/admit/reconcile. A fresh
      // retryAbsent fallback is not an observed disposition to retire.
      observeIssued(outcome)
      if (neverIssuedStale && !everIssued && outcome === latest && outcome.kind === 'not-issued' && outcome.code === 'FACT_PRECONDITION_STALE' && capture.kind === 'captured' && (capture.group.kind === 'delivery-admission' || capture.group.kind === 'delivery-generation' && capture.group.event.op === 'open' || capture.group.kind === 'delivery' && capture.group.event.type === 'agent/delivery-handoff' && capture.group.event.kind === 'code')) {
        retired=Object.freeze(outcome);neverIssuedStale()
      }
      if (retirement && outcome === latest && capture.kind === 'captured' && capture.group.kind === 'input-cancellation' && outcome.kind === 'not-issued' && outcome.code === 'FACT_INVALID_GROUP' && retirement.accepts(outcome as InvalidNotIssued)) {
        retired = Object.freeze(outcome as InvalidNotIssued)
        retirement.retired()
      }
      return outcome
    }
    const result = serial ? serial.then(run) : run()
    serial = result.then(() => {}, () => {})
    return result
  }
  const admit = async () => {
    operations.assertHeld()
    if (capture.kind !== 'captured') return capture
    latest = operations.status(capture.group) ?? latest; if(latest)observeIssued(latest)
    if (latest && (latest.kind !== 'not-issued' || latest.code === 'FACT_PRECONDITION_STALE')) return latest
    latest = await operations.admit(capture.group); observeIssued(latest)
    return latest
  }
  const commands:CapturedSettlementFact={
    observe: () => track(async () => {
      operations.assertHeld()
      if (capture.kind !== 'captured') return capture
      latest = operations.status(capture.group) ?? latest; if(latest)observeIssued(latest)
      return latest ?? { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' }
    }),
    admit: () => track(admit),
    reconcile: () => track(async () => {
      operations.assertHeld()
      if (capture.kind === 'captured') latest = operations.status(capture.group) ?? latest; if(latest)observeIssued(latest)
      if (!latest || latest.kind === 'not-issued') return admit()
      if (latest.kind === 'committed' || latest.kind === 'absent') return latest
      const key = latest.kind === 'recovery-required' ? latest.receipt.key : latest.key
      const disposition = await operations.reconcile(key)
      // Reconciliation installs the whole shared physical frame. This source
      // owns only its captured group's slice, even when another group was first.
      latest = capture.kind === 'captured' ? operations.status(capture.group) ?? disposition : disposition; observeIssued(latest)
      return latest
    }),
    retryAbsent: () => track(async () => {
      operations.assertHeld()
      if (capture.kind !== 'captured') return capture
      if (latest?.kind !== 'absent') return latest ?? { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
      latest = await operations.admit(capture.group); observeIssued(latest)
      return latest
    }),
  }
  const codeHandoff=capture.kind==='captured'&&capture.group.kind==='delivery'&&capture.group.event.type==='agent/delivery-handoff'&&capture.group.event.kind==='code'
  if(codeHandoff)retiredCodeHandoffs.set(commands,()=>retired)
  if(capture.kind==='captured'&&operations.captureMembers){
    const factory=operations.captureMembers,owned=factory.capture(capture.group,commands)
    memberFactories.set(owned,factory);if(codeHandoff)retiredCodeHandoffs.set(owned,()=>retired)
    return owned
  }
  return commands
}





