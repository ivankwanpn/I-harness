import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { TaskProtocolDocument } from './types.ts'
import { captureTaskSnapshot, taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'
import type { TaskWriteOutcome } from '@i-harness/session-persistence'
import { taskDocumentStorageContract } from './storage-contract.ts'
import { isOwnedTaskContext, type captureOwnedTaskContext } from './owned-context.ts'

type Operations = NonNullable<ReturnType<typeof taskDocumentOperationsFor>>
export type OwnedTaskContext = NonNullable<ReturnType<typeof captureOwnedTaskContext>>
export interface OwnedTaskSave { readonly done: Promise<void>; assertHandoff(): void; release(): void; retireConsumer(): Promise<void>; retry(): Promise<void>; outcome(): TaskWriteOutcome | undefined }
const dependencyFailures=new WeakMap<object,Readonly<{cause:unknown;occurrence:object}>>()
const saveOccurrences=new WeakMap<OwnedTaskSave,object>()
function earlierSaveFailure(save:OwnedTaskSave,cause:unknown):Error {
  let occurrence=saveOccurrences.get(save);if(!occurrence){occurrence=Object.freeze({});saveOccurrences.set(save,occurrence)}
  const error=new Error('Earlier owned task save requires resolution',{cause})
  dependencyFailures.set(error,Object.freeze({cause,occurrence}));return error
}
export function originalTaskSaveDependency(error:unknown):Readonly<{cause:unknown;occurrence:object}>|undefined {
  return typeof error==='object'&&error!==null?dependencyFailures.get(error):undefined
}
const capturedAckCandidates=new WeakMap<OwnedTaskSave,()=>Extract<TaskWriteOutcome,{kind:'unknown'}>|undefined>()
const capturedAckFailures=new WeakMap<object,Readonly<{outcome:Extract<TaskWriteOutcome,{kind:'unknown'}>}>>()
export function originalCapturedTaskAcknowledgment(save:OwnedTaskSave):Extract<TaskWriteOutcome,{kind:'unknown'}>|undefined {
  try{return capturedAckCandidates.get(save)?.()}catch{return undefined}
}
export function capturedTaskAcknowledgmentFailure(save:OwnedTaskSave,cause:unknown):Error|undefined {
  const outcome=originalCapturedTaskAcknowledgment(save);if(!outcome)return undefined
  const error=new Error('Original Task acknowledgment requires reconciliation',{cause});capturedAckFailures.set(error,Object.freeze({outcome}));return error
}
export function originalTaskAcknowledgmentRecovery(error:unknown):Readonly<{outcome:Extract<TaskWriteOutcome,{kind:'unknown'}>}>|undefined {
  return typeof error==='object'&&error!==null?capturedAckFailures.get(error):undefined
}

export function taskDocKey(stateId: string): string {
  // A colon creates an NTFS alternate data stream in the JSONL backend.
  return `task-${stateId}`
}

/** Sole ordered writer for this registry's existing auxiliary document. */
type RequiredSaveCapture={parent:object;capture:()=>TaskProtocolDocument;beforeIssue:()=>Promise<void>}
type OrdinaryCapture={owned:OwnedTaskContext;snapshot:TaskProtocolDocument;bytes:string}
export class TaskPersistence {
  #ordinaryFlight:{save:OwnedTaskSave;owned:OwnedTaskContext;bytes:string;active():boolean}|undefined
  #requiredOwned=new WeakSet<OwnedTaskSave>()
  #requiredCapture:((authority:object)=>RequiredSaveCapture)|undefined
  #chain: Promise<void> = Promise.resolve()
  #debt: OwnedTaskSave | undefined
  #debtCause: unknown
  #last: OwnedTaskSave | undefined
  // Captures remain ordered even when an earlier write prevents entry.
  #pending: OwnedTaskSave[] = []
  #bindingAdmitted = false
  #flushing: Promise<void> | undefined
  // D-01 write-behind: the legacy/non-owned document is a projection, so bursts
  // of saves coalesce into one write of the latest snapshot. Strict/owned paths
  // keep their ordered, capturable writes.
  #coalesceWaiters: Array<{ resolve: () => void; reject: (cause: unknown) => void }> = []
  #coalesceScheduled = false
  #coalesceRunning = false
  #coalesceFlight: Promise<void> | undefined
  constructor(readonly coordinator: SessionCoordinator | undefined, readonly stateId: string | undefined, readonly strict: boolean, readonly snapshot: () => TaskProtocolDocument, readonly owned?: OwnedTaskContext, requiredCapture?:(authority:object)=>RequiredSaveCapture) {this.#requiredCapture=requiredCapture}
  save(): Promise<void> {
    if (!this.coordinator || !this.stateId) return Promise.resolve()
    const captured = this.#bindingAdmitted || this.strict&&this.owned ? this.captureOwned(false,undefined,true) : this.captureSave()
    if (captured) return captured.done
    if (this.owned) {
      try { if (this.snapshot().formatVersion === 3) return this.captureOwned(false).done } catch (cause) { return Promise.reject(cause) }
    }
    if (!this.strict && !this.owned) return this.#enqueueCoalesced()
    const document = this.strict ? this.snapshot() : undefined
    const next = this.#chain.then(() => {
      const payload = this.strict ? document! : this.snapshot()
      if (payload.formatVersion === 3) throw new Error('Task v3 persistence requires original eligible parent')
      if (this.strict) {
        if (!this.coordinator!.putDocumentStrict) throw new Error('Strict result retention is unavailable')
        return this.coordinator!.putDocumentStrict(taskDocKey(this.stateId!), payload)
      }
      return this.coordinator!.putDocument(taskDocKey(this.stateId!), payload)
    })
    this.#chain = next.catch(() => {})
    return next
  }
  /** Internal consumer keeps this exact save across its own await boundary. */
  captureSave(hold = false, beforeIssue?:()=>Promise<void>): OwnedTaskSave | undefined {
    if (!this.coordinator || !this.stateId || !this.strict || !this.owned) return undefined
    return this.captureOwned(hold,beforeIssue)
  }
  captureRequiredSave(authority:object):OwnedTaskSave {
    if(!this.#requiredCapture)throw Error('Original required capture owner unavailable')
    const{parent,capture,beforeIssue}=this.#requiredCapture(authority)
    const original=this.captureOwnedSave(true,beforeIssue,{parent,capture});this.#requiredOwned.add(original);return original
  }
  captureBindingSave(): OwnedTaskSave {
    if (!this.coordinator || !this.stateId || !this.owned || !isOwnedTaskContext(this.owned)) throw new Error('Original task owner unavailable')
    this.owned.operations.assertTaskV3Parent(this.owned.parent, this.stateId)
    this.#bindingAdmitted = true
    return this.captureOwned(true)
  }
  private captureOwned(hold: boolean,beforeIssue?:()=>Promise<void>,joinOrdinary=false): OwnedTaskSave {
    try {
      const original=this.#ordinaryFlight
      if(joinOrdinary&&!hold&&!beforeIssue&&original&&original.save===this.#last&&original.active()){
        const prepared=this.prepareOrdinaryCapture()
        if(original.owned===prepared.owned&&original.bytes===prepared.bytes&&original.active())return original.save
        return this.captureOwnedSave(hold,beforeIssue,undefined,prepared)
      }
      return this.captureOwnedSave(hold,beforeIssue)
    } catch (error) {
      const done = this.#chain.then(() => { if (!this.#debt) { this.#debt = handle; this.#debtCause = error }; throw error })
      let retired=false,retirement:Promise<void>|undefined;const owner=this
      const handle: OwnedTaskSave = Object.freeze({ done, assertHandoff() { if (this !== handle) throw new TypeError('Invalid task save receiver'); throw error }, release() { if (this !== handle) throw new TypeError('Invalid task save receiver'); throw error }, retireConsumer() {
        if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver'))
        if(retirement)return retirement;const pending=(async()=>{await done.catch(()=>{});if(retired)return;if(owner.#pending[0]!==handle||owner.#debt&&owner.#debt!==handle)throw new Error('Earlier owned task save requires resolution');if(owner.#debt===handle){owner.#debt=undefined;owner.#debtCause=undefined};owner.#pending.shift();retired=true})();retirement=pending;void pending.catch(()=>{if(retirement===pending)retirement=undefined});return pending
      }, retry() { if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver')); return Promise.reject(error) }, outcome() { if (this !== handle) throw new TypeError('Invalid task save receiver'); return undefined } })
      this.#pending.push(handle); this.#last = handle; this.#chain = done.catch(() => {}); return handle
    }
  }
  #enqueueCoalesced(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => { this.#coalesceWaiters.push({ resolve, reject }) })
    this.#scheduleCoalesced()
    return done
  }
  #scheduleCoalesced(): void {
    if (this.#coalesceScheduled || this.#coalesceRunning || this.#coalesceWaiters.length === 0) return
    this.#coalesceScheduled = true
    const flight = new Promise<void>(resolve => { queueMicrotask(() => { void this.#drainCoalesced().finally(resolve) }) })
    this.#coalesceFlight = flight
    void flight.finally(() => { if (this.#coalesceFlight === flight) this.#coalesceFlight = undefined })
  }
  async #drainCoalesced(): Promise<void> {
    this.#coalesceScheduled = false
    if (this.#coalesceRunning || this.#coalesceWaiters.length === 0) return
    this.#coalesceRunning = true
    const waiters = this.#coalesceWaiters
    this.#coalesceWaiters = []
    try {
      const payload = this.snapshot()
      if (payload.formatVersion === 3) throw new Error('Task v3 persistence requires original eligible parent')
      await this.coordinator!.putDocument(taskDocKey(this.stateId!), payload)
      for (const waiter of waiters) waiter.resolve()
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error)
    } finally {
      this.#coalesceRunning = false
      this.#scheduleCoalesced()
    }
  }
  async #coalesceIdle(): Promise<void> {
    for (;;) {
      const flight = this.#coalesceFlight
      if (flight) await flight.catch(() => {})
      if (this.#coalesceFlight === undefined && this.#coalesceWaiters.length === 0 && !this.#coalesceScheduled) return
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing
    const flight = this.flushOwned()
    this.#flushing = flight
    void flight.finally(() => { if (this.#flushing === flight) this.#flushing = undefined }).catch(() => {})
    return flight
  }
  private async flushOwned(): Promise<void> {
    for (;;) {
      const pending = this.#chain
      await pending
      await this.#coalesceIdle()
      if (pending === this.#chain) {
        if (this.#debt) throw new Error('Owned task save requires resolution', { cause: this.#debtCause })
        if (this.#pending.length) throw new Error('Owned task save requires resolution')
        return
      }
    }
  }
  async retireConsumers(): Promise<void> {
    const failures: unknown[] = []
    for (const save of [...this.#pending]) try { if(!this.#requiredOwned.has(save))await save.retireConsumer() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Original task consumer cleanup failed')
  }
  lastOwnedSave() { return this.#debt ?? this.#last }
  private prepareOrdinaryCapture():OrdinaryCapture {
    const owned=this.owned!
    if(!isOwnedTaskContext(owned)||owned.coordinator!==this.coordinator||owned.stateId!==this.stateId)throw new Error('Original task owner unavailable')
    const snapshot=captureTaskSnapshot(this.snapshot()) as TaskProtocolDocument
    taskDocumentStorageContract.validate(snapshot)
    if(snapshot.formatVersion===3)owned.operations.assertTaskV3Parent(owned.parent,this.stateId!)
    owned.operations.assertParentSession(owned.parent,this.stateId!)
    return {owned,snapshot,bytes:JSON.stringify(snapshot)+'\n'}
  }
  private captureOwnedSave(hold: boolean,beforeIssue?:()=>Promise<void>,required?:{parent:object;capture:()=>TaskProtocolDocument},prepared?:OrdinaryCapture): OwnedTaskSave {
    const owned = this.owned!
    if (!isOwnedTaskContext(owned) || owned.coordinator !== this.coordinator || owned.stateId !== this.stateId) throw new Error('Original task owner unavailable')
    let parent:object|undefined=required?undefined:owned.parent
    const ordinary=required?undefined:prepared??this.prepareOrdinaryCapture()
    if(ordinary&&ordinary.owned!==owned)throw new Error('Original task owner changed')
    let snapshot=ordinary?.snapshot
    let operation: Awaited<ReturnType<Operations['begin']>> | undefined, write: ReturnType<Awaited<ReturnType<Operations['begin']>>['stageWrite']> | undefined
    let entered = false, failed = false, settled=false, abandoned = false, consumed = false, consumerRetired = false, retireFlight: Promise<void> | undefined
    let result: TaskWriteOutcome | undefined, closed = false, closeAttempted = false, retryFlight: Promise<void> | undefined, primaryFailure: unknown, beginCleanup: ReturnType<Operations['cleanupFor']>
    let handoffFailure: { cause: unknown } | undefined
    const assertHandoff = () => {
      if (!closed || !operation || result?.kind !== 'committed' || result.cleanupPending) throw new Error('Original task save handoff unavailable')
      operation.assertHandoff()
      if (handoffFailure) throw handoffFailure.cause
    }
    const finish = async (retry: boolean) => {
      if (!operation || !write) throw new Error('Original task save cannot be retried')
      if (result?.kind !== 'committed') {
        try { result = retry ? await write.retry() : await write.issue() }
        catch (error) { try { result = write.outcome() ?? result } catch {}; if (result?.kind === 'committed') handoffFailure ??= { cause: error }; throw error }
      }
      if (result.kind !== 'committed') {
        const failure = new Error('Owned task save was not acknowledged', { cause: result })
        if (result.kind === 'conflict' || result.kind === 'not-issued') {
          closeAttempted = true
          try { await operation.close(); closed = true } catch (cleanup) { throw new AggregateError([failure, cleanup], 'Original task save and cleanup failed') }
        }
        throw failure
      }
      if (!closed) { if (closeAttempted) await operation.retryClose(); else { closeAttempted = true; await operation.close() }; closed = true; result = write.outcome() ?? result }
      if(required)await owned.operations.joinRequiredWriter(parent!)
      if (!abandoned) assertHandoff()
      else if (handoffFailure) throw handoffFailure.cause
    }
    const run = async () => {
      if (this.#pending[0] !== handle || this.#debt && this.#debt !== handle) throw this.#debt&&this.#debt!==handle?earlierSaveFailure(this.#debt,this.#debtCause):new Error('Earlier owned task save requires resolution')
      try {
        if(required&&beginCleanup){await beginCleanup.retry();beginCleanup=undefined}
        if(required)parent=await required.parent
        if(beforeIssue)await beforeIssue()
        if(this.#pending[0]!==handle||this.#debt&&this.#debt!==handle)throw this.#debt&&this.#debt!==handle?earlierSaveFailure(this.#debt,this.#debtCause):new Error('Earlier owned task save requires resolution')
        if(!required)entered = true
        operation = await owned.operations.begin(parent!)
        entered = true
        if(!snapshot){snapshot=captureTaskSnapshot(required!.capture()) as TaskProtocolDocument;taskDocumentStorageContract.validate(snapshot);owned.operations.assertTaskV3Parent(parent!,this.stateId!)}
        if(required)await owned.operations.joinRequiredWriter(parent!)
        const observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('Task document is absent')
        if(required)await owned.operations.joinRequiredWriter(parent!)
        write = operation.stageWrite(observed.witness, snapshot)
        await finish(false)
        if(required)await owned.operations.joinRequiredWriter(parent!)
        assertHandoff()
        if (!hold) { this.#pending.shift(); consumerRetired = true }
      } catch (error) {
        failed = true; primaryFailure = error; let failure: unknown = error
        if (!operation) beginCleanup = owned.operations.cleanupFor(error)
        if (operation && !write) { closeAttempted = true; try { await operation.close(); closed = true } catch (cleanup) { failure = new AggregateError([error, cleanup], 'Original task save and cleanup failed') } }
        this.#debt = handle; this.#debtCause = failure; throw failure
      }
    }
    const gate = Promise.withResolvers<void>()
    if (!hold) gate.resolve()
    const done = this.#chain.then(run); this.#chain = done.then(() => gate.promise, () => {})
    void done.then(()=>{settled=true},()=>{settled=true})
    const owner = this
    // Retry and retirement share the exact head/gate transition. A waiter
    // recognizes a completed retirement instead of removing the head twice.
    const retireHead = () => {
      if (consumerRetired) return
      if (owner.#pending[0] !== handle || owner.#debt && owner.#debt !== handle) throw new Error('Earlier owned task save requires resolution')
      if (owner.#debt === handle) { owner.#debt = undefined; owner.#debtCause = undefined }
      owner.#pending.shift(); consumerRetired = true; gate.resolve()
    }
    const handle: OwnedTaskSave = Object.freeze({ done,
      assertHandoff() { if (this !== handle) throw new TypeError('Invalid task save receiver'); if(handoffFailure)throw handoffFailure.cause;if (abandoned) throw new Error('Task save consumer abandoned'); assertHandoff() },
      // Consumption is explicit. Assertions and flush never advance a held
      // consumer or let a queued snapshot replace its still-live authority.
      release() { if (this !== handle) throw new TypeError('Invalid task save receiver'); if (abandoned || consumed || owner.#pending[0] !== handle) throw new Error('Task save consumer unavailable'); assertHandoff(); consumed = true; owner.#pending.shift(); gate.resolve() },
      retireConsumer() {
        if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver'))
        if (retireFlight) return retireFlight
        if (consumed) return Promise.reject(new Error('Task save consumer already consumed'))
        const priorRetry = retryFlight
        abandoned = true
        retireFlight = (async () => {
          await done.catch(() => {})
          if (priorRetry) await priorRetry.catch(() => {})
          try {
            if (consumerRetired) return
            if (!closed && operation && (closeAttempted || !required)) { if(closeAttempted)await operation.retryClose();else{closeAttempted=true;await operation.close()}; closed = true; if (write) result = write.outcome() ?? result }
            if (!operation && beginCleanup) await beginCleanup.retry()
            if (!required && (!operation || closed && operation.retirementDisposition() === 'unissued') && (!owner.#debt || owner.#debt === handle) && owner.#pending[0] === handle) { retireHead(); return }
            if (closed && result?.kind === 'committed' && !result.cleanupPending && (!handoffFailure||!required&&operation?.retirementAcknowledged(result.ack)===true) && (!owner.#debt || owner.#debt === handle) && owner.#pending[0] === handle) { retireHead(); return }
            if (!owner.#debt) { owner.#debt = handle; owner.#debtCause = failed ? primaryFailure : new Error('Task save consumer unresolved') }
            gate.resolve(); throw new Error('Owned task save requires resolution', { cause: owner.#debtCause })
          } catch (error) { if (!owner.#debt) { owner.#debt = handle; owner.#debtCause = error }; gate.resolve(); throw error }
        })()
        return retireFlight
      },
      retry() {
        if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver'))
        if (!retryFlight) { const retirement = abandoned ? retireFlight : undefined; retryFlight = Promise.resolve().then(async () => { await done.catch(() => {}); if (retirement) await retirement.catch(() => {}); if (!entered) { await run(); if(owner.#debt===handle){owner.#debt=undefined;owner.#debtCause=undefined};if(abandoned)retireHead();return }; if (!write) { if (beginCleanup) await beginCleanup.retry(); else if (operation && !closed) { await operation.retryClose(); closed = true }; throw primaryFailure }; if (result?.kind === 'conflict' || result?.kind === 'not-issued') { if (operation && !closed) { await operation.retryClose(); closed = true }; throw primaryFailure }; await finish(true); if (!abandoned) assertHandoff(); if (owner.#debt === handle) { owner.#debt = undefined; owner.#debtCause = undefined }; if (abandoned) retireHead(); else if (!hold && owner.#pending[0] === handle) { owner.#pending.shift(); consumerRetired = true } }); void retryFlight.then(() => { retryFlight = undefined }, () => { retryFlight = undefined }) }
        return retryFlight
      }, outcome() { if (this !== handle) throw new TypeError('Invalid task save receiver'); return result },
    })
    this.#pending.push(handle); this.#last = handle
    if(required)capturedAckCandidates.set(handle,()=>{if(!entered||!snapshot||!write||!operation||closed||handoffFailure||result?.kind!=='unknown'||result.cleanupPending)return undefined;operation.assertCapturedWriteRecovery();return result})
    if(ordinary&&!hold)this.#ordinaryFlight={save:handle,owned,bytes:ordinary.bytes,active:()=>!settled&&!failed&&!abandoned&&!closed&&(!operation||operation.ordinarySaveOpen())}
    return handle
  }
}
