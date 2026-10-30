import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { TaskProtocolDocument } from './types.ts'
import { captureTaskSnapshot, taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'
import type { TaskWriteOutcome } from '@i-harness/session-persistence'
import { taskDocumentStorageContract } from './storage-contract.ts'
import { isOwnedTaskContext, type captureOwnedTaskContext } from './owned-context.ts'

type Operations = NonNullable<ReturnType<typeof taskDocumentOperationsFor>>
export type OwnedTaskContext = NonNullable<ReturnType<typeof captureOwnedTaskContext>>
export interface OwnedTaskSave { readonly done: Promise<void>; assertHandoff(): void; release(): void; retireConsumer(): Promise<void>; retry(): Promise<void>; outcome(): TaskWriteOutcome | undefined }

export function taskDocKey(stateId: string): string {
  // A colon creates an NTFS alternate data stream in the JSONL backend.
  return `task-${stateId}`
}

/** Sole ordered writer for this registry's existing auxiliary document. */
export class TaskPersistence {
  #chain: Promise<void> = Promise.resolve()
  #debt: OwnedTaskSave | undefined
  #debtCause: unknown
  #last: OwnedTaskSave | undefined
  // Captures remain ordered even when an earlier write prevents entry.
  #pending: OwnedTaskSave[] = []
  #flushing: Promise<void> | undefined
  constructor(readonly coordinator: SessionCoordinator | undefined, readonly stateId: string | undefined, readonly strict: boolean, readonly snapshot: () => TaskProtocolDocument, readonly owned?: OwnedTaskContext) {}
  save(): Promise<void> {
    if (!this.coordinator || !this.stateId) return Promise.resolve()
    const captured = this.captureSave()
    if (captured) return captured.done
    const document = this.strict ? this.snapshot() : undefined
    const next = this.#chain.then(() => {
      if (this.strict) {
        if (!this.coordinator!.putDocumentStrict) throw new Error('Strict result retention is unavailable')
        return this.coordinator!.putDocumentStrict(taskDocKey(this.stateId!), document)
      }
      return this.coordinator!.putDocument(taskDocKey(this.stateId!), this.snapshot())
    })
    this.#chain = next.catch(() => {})
    return next
  }
  /** Internal consumer keeps this exact save across its own await boundary. */
  captureSave(hold = false): OwnedTaskSave | undefined {
    if (!this.coordinator || !this.stateId || !this.strict || !this.owned) return undefined
    return this.captureOwned(hold)
  }
  captureBindingSave(): OwnedTaskSave {
    if (!this.coordinator || !this.stateId || !this.owned || !isOwnedTaskContext(this.owned)) throw new Error('Original task owner unavailable')
    return this.captureOwned(true)
  }
  private captureOwned(hold: boolean): OwnedTaskSave {
    try { return this.captureOwnedSave(hold) } catch (error) {
      const done = this.#chain.then(() => { if (!this.#debt) { this.#debt = handle; this.#debtCause = error }; throw error })
      const handle: OwnedTaskSave = Object.freeze({ done, assertHandoff() { if (this !== handle) throw new TypeError('Invalid task save receiver'); throw error }, release() { if (this !== handle) throw new TypeError('Invalid task save receiver'); throw error }, retireConsumer() { if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver')); return done }, retry() { if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver')); return Promise.reject(error) }, outcome() { if (this !== handle) throw new TypeError('Invalid task save receiver'); return undefined } })
      this.#pending.push(handle); this.#last = handle; this.#chain = done.catch(() => {}); return handle
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
      if (pending === this.#chain) {
        if (this.#debt) throw new Error('Owned task save requires resolution', { cause: this.#debtCause })
        if (this.#pending.length) throw new Error('Owned task save requires resolution')
        return
      }
    }
  }
  lastOwnedSave() { return this.#debt ?? this.#last }
  private captureOwnedSave(hold: boolean): OwnedTaskSave {
    const owned = this.owned!
    if (!isOwnedTaskContext(owned) || owned.coordinator !== this.coordinator || owned.stateId !== this.stateId) throw new Error('Original task owner unavailable')
    const snapshot = captureTaskSnapshot(this.snapshot())
    taskDocumentStorageContract.validate(snapshot)
    owned.operations.assertParentSession(owned.parent, this.stateId!)
    let operation: Awaited<ReturnType<Operations['begin']>> | undefined, write: ReturnType<Awaited<ReturnType<Operations['begin']>>['stageWrite']> | undefined
    let entered = false, failed = false, abandoned = false, consumed = false, retireFlight: Promise<void> | undefined
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
      assertHandoff()
    }
    const run = async () => {
      if (this.#pending[0] !== handle || this.#debt && this.#debt !== handle) throw new Error('Earlier owned task save requires resolution')
      entered = true
      try {
        operation = await owned.operations.begin(owned.parent)
        const observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('Task document is absent')
        write = operation.stageWrite(observed.witness, snapshot)
        await finish(false)
        assertHandoff()
        if (!hold) this.#pending.shift()
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
    const owner = this
    const handle: OwnedTaskSave = Object.freeze({ done,
      assertHandoff() { if (this !== handle) throw new TypeError('Invalid task save receiver'); if (abandoned) throw new Error('Task save consumer abandoned'); assertHandoff() },
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
            if (!closed && operation && closeAttempted) { await operation.retryClose(); closed = true; if (write) result = write.outcome() ?? result }
            if (!operation && beginCleanup) await beginCleanup.retry()
            if (closed && result?.kind === 'committed' && !result.cleanupPending && !handoffFailure && (!owner.#debt || owner.#debt === handle) && owner.#pending[0] === handle) { if (owner.#debt === handle) { owner.#debt = undefined; owner.#debtCause = undefined }; owner.#pending.shift(); gate.resolve(); return }
            if (!owner.#debt) { owner.#debt = handle; owner.#debtCause = failed ? primaryFailure : new Error('Task save consumer unresolved') }
            gate.resolve(); throw new Error('Owned task save requires resolution', { cause: owner.#debtCause })
          } catch (error) { if (!owner.#debt) { owner.#debt = handle; owner.#debtCause = error }; gate.resolve(); throw error }
        })()
        return retireFlight
      },
      retry() {
        if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver'))
        if (!retryFlight) { const retirement = abandoned ? retireFlight : undefined; retryFlight = Promise.resolve().then(async () => { await done.catch(() => {}); if (retirement) await retirement.catch(() => {}); if (!entered) { await run(); return }; if (!write) { if (beginCleanup) await beginCleanup.retry(); else if (operation && !closed) { await operation.retryClose(); closed = true }; throw primaryFailure }; if (result?.kind === 'conflict' || result?.kind === 'not-issued') { if (operation && !closed) { await operation.retryClose(); closed = true }; throw primaryFailure }; await finish(true); assertHandoff(); if (owner.#debt === handle) { owner.#debt = undefined; owner.#debtCause = undefined }; if ((!hold || abandoned) && owner.#pending[0] === handle) owner.#pending.shift() }); void retryFlight.then(() => { retryFlight = undefined }, () => { retryFlight = undefined }) }
        return retryFlight
      }, outcome() { if (this !== handle) throw new TypeError('Invalid task save receiver'); return result },
    })
    this.#pending.push(handle); this.#last = handle; return handle
  }
}
