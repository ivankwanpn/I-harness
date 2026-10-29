import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { TaskProtocolDocument } from './types.ts'
import { captureTaskSnapshot, taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'
import type { TaskWriteOutcome } from '@i-harness/session-persistence'
import { taskDocumentStorageContract } from './storage-contract.ts'
import { isOwnedTaskContext, type captureOwnedTaskContext } from './owned-context.ts'

type Operations = NonNullable<ReturnType<typeof taskDocumentOperationsFor>>
export type OwnedTaskContext = NonNullable<ReturnType<typeof captureOwnedTaskContext>>
export interface OwnedTaskSave { readonly done: Promise<void>; assertHandoff(): void; retry(): Promise<void>; outcome(): TaskWriteOutcome | undefined }

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
  captureSave(): OwnedTaskSave | undefined {
    if (!this.coordinator || !this.stateId || !this.strict || !this.owned) return undefined
    try { return this.captureOwnedSave() } catch (error) {
      const done = this.#chain.then(() => { if (!this.#debt) { this.#debt = handle; this.#debtCause = error }; throw error })
      const handle: OwnedTaskSave = Object.freeze({ done, assertHandoff() { if (this !== handle) throw new TypeError('Invalid task save receiver'); throw error }, retry() { if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver')); return Promise.reject(error) }, outcome() { if (this !== handle) throw new TypeError('Invalid task save receiver'); return undefined } })
      this.#last = handle; this.#chain = done.catch(() => {}); return handle
    }
  }
  async flush(): Promise<void> {
    for (;;) {
      const pending = this.#chain
      await pending
      if (pending === this.#chain) { if (this.#debt) throw new Error('Owned task save requires resolution', { cause: this.#debtCause }); return }
    }
  }
  lastOwnedSave() { return this.#debt ?? this.#last }
  private captureOwnedSave(): OwnedTaskSave {
    const owned = this.owned!
    if (!isOwnedTaskContext(owned) || owned.coordinator !== this.coordinator || owned.stateId !== this.stateId) throw new Error('Original task owner unavailable')
    const snapshot = captureTaskSnapshot(this.snapshot())
    taskDocumentStorageContract.validate(snapshot)
    owned.operations.assertParentSession(owned.parent, this.stateId!)
    let operation: Awaited<ReturnType<Operations['begin']>> | undefined, write: ReturnType<Awaited<ReturnType<Operations['begin']>>['stageWrite']> | undefined
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
      if (this.#debt) throw new Error('Earlier owned task save requires resolution')
      try {
        operation = await owned.operations.begin(owned.parent)
        const observed = await operation.observe(); if (observed.kind !== 'present') throw new Error('Task document is absent')
        write = operation.stageWrite(observed.witness, snapshot)
        await finish(false)
      } catch (error) {
        primaryFailure = error; let failure: unknown = error
        if (!operation) beginCleanup = owned.operations.cleanupFor(error)
        if (operation && !write) { closeAttempted = true; try { await operation.close(); closed = true } catch (cleanup) { failure = new AggregateError([error, cleanup], 'Original task save and cleanup failed') } }
        this.#debt = handle; this.#debtCause = failure; throw failure
      }
    }
    const done = this.#chain.then(run); this.#chain = done.catch(() => {})
    const owner = this
    const handle: OwnedTaskSave = Object.freeze({ done,
      assertHandoff() { if (this !== handle) throw new TypeError('Invalid task save receiver'); assertHandoff() },
      retry() {
        if (this !== handle) return Promise.reject(new TypeError('Invalid task save receiver'))
        if (!retryFlight) { retryFlight = Promise.resolve().then(async () => { await done.catch(() => {}); if (!write) { if (beginCleanup) await beginCleanup.retry(); else if (operation && !closed) { await operation.retryClose(); closed = true }; throw primaryFailure }; if (result?.kind === 'conflict' || result?.kind === 'not-issued') { if (operation && !closed) { await operation.retryClose(); closed = true }; throw primaryFailure }; await finish(true); if (owner.#debt === handle) { owner.#debt = undefined; owner.#debtCause = undefined } }); void retryFlight.then(() => { retryFlight = undefined }, () => { retryFlight = undefined }) }
        return retryFlight
      }, outcome() { if (this !== handle) throw new TypeError('Invalid task save receiver'); return result },
    })
    this.#last = handle; return handle
  }
}
