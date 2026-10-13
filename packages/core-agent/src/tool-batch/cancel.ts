import { append, type Session } from "@i-harness/core-session"
import { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_ABORTED_MID_FLIGHT, TOOL_CANCELLED_BY_SIBLING, TOOL_FAILED } from "@i-harness/core-tools"
import type { BatchCall, ExecuteToolCallsOptions } from "./types.ts"
import type { BatchRecords } from "./record.ts"

export function createBatchCancellation(opts: ExecuteToolCallsOptions) {
  const failures = new Map<number, unknown>()
  let aborted = opts.signal?.aborted ?? false
  let firstError: unknown
  // A rejection can legally carry undefined. Keep occurrence separate from
  // its value; this flag records the fallback reason, not whether to stop.
  let hasFailed = false
  // Ordinary failures belong to a call. Only execution/policy failures stop
  // the pool; sharing this flag with hasFailed cancelled unrelated writes.
  let stopped = false
  // Prepare/ordered-lane errors and marked dispatch refusals remain loud.
  // The site/type supplies the boundary; error message wording does not.
  let firstRefusal: unknown
  let hasRefusal = false
  // M70: the checkpoint's own failure, carried to the END of the function.
  // It cannot be thrown from `startCall`: the fills and the commit lane still
  // have to run (a throw from there leaves the log half-committed — the M5 T4
  // R5 defect the commit-lane error below is also built around). It is NOT a
  // refusal either, for the same reason, plus a second one: a refusal discards
  // the batch, and a store failure must not discard the record of what DID
  // happen before the store broke.
  //
  // THE FLAG IS SEPARATE FROM THE VALUE, for the same reason `hasFailed` /
  // `firstError` and `hasCommitError` / `commitError` are split (see their own
  // notes): a host whose `flush` rejects with NO reason — `Promise.reject()` /
  // `throw undefined` are legal, and the seam's whole contract is "reject" —
  // leaves the value `undefined`, so a value test would read a failure that
  // HAPPENED as "no failure", skip the rethrow, and return normally on the
  // soft-failure path: the turn would continue against a store that just proved
  // it cannot persist, which is exactly the lost-durable-write defect M5 T4 R5
  // names. The flag carries "it happened"; the value carries what it was.
  let firstFlushError: unknown
  let hasFlushError = false
  // Policy/infrastructure stops cancel dispatched work. Ordinary failures do
  // not touch this channel; the owner's signal remains composed into it.
  const batchAbort = new AbortController()
  const batchSignal = opts.signal !== undefined
    ? AbortSignal.any([opts.signal, batchAbort.signal])
    : batchAbort.signal

  const stopForRefusal = (error: unknown): void => {
    if (!hasRefusal) firstRefusal = error
    hasRefusal = true
    stopped = true
    batchAbort.abort()
  }


  return {
    batchSignal,
    get aborted() { return aborted },
    get stopped() { return stopped },
    get firstError() { return firstError },
    get firstRefusal() { return firstRefusal },
    get hasRefusal() { return hasRefusal },
    get firstFlushError() { return firstFlushError },
    get hasFlushError() { return hasFlushError },
    stopForRefusal,
    observeAbort() { if (opts.signal?.aborted) aborted = true },
    recordFailure(index: number, error: unknown) {
      failures.set(index, error)
      if (!hasFailed) { firstError = error; hasFailed = true }
    },
    recordOuterFailure(error: unknown) { if (!hasFailed) firstError = error; hasFailed = true; stopForRefusal(error) },
    stopForCheckpoint(error: unknown) {
      if (!hasFlushError) { firstFlushError = error; hasFlushError = true }
      stopped = true
      batchAbort.abort()
    },
    failureMessage(index: number, fallback: string): string {
      const own = failures.get(index)
      return failures.has(index) ? (own instanceof Error ? own.message : String(own)) : fallback
    },
  }
}
export type BatchCancellation = ReturnType<typeof createBatchCancellation>

export async function finishCancelledBatch(session: Session, batch: BatchCall[], records: BatchRecords, cancellation: BatchCancellation): Promise<never> {
  // Abort dominates coincident failures. Own rejection identity wins over the
  // defensive fallback, including a recorded rejection with undefined.
  const fallbackMessage = cancellation.firstError instanceof Error
    ? cancellation.firstError.message
    : cancellation.firstError === undefined ? "tool call aborted before dispatch" : String(cancellation.firstError)
  for (let i = records.committed; i < records.startedUpTo; i += 1) {
    if (records.getSlot(i) !== undefined) continue
    const call = batch[i]!
    const message = cancellation.failureMessage(i, fallbackMessage)
    records.setSlot(i, { name: call.name, callId: call.callId, synthetic: true, output: { error: message, code: TOOL_ABORTED_MID_FLIGHT } })
  }
  try { await records.commitReady() } catch { /* abort dominates */ }
  for (let i = records.startedUpTo; i < batch.length; i += 1) {
    // A typed preparation failure may already fill a never-started slot.
    if (records.getSlot(i) !== undefined) continue
    const call = batch[i]!
    append(session, { type: "tool/result", callId: call.callId, name: call.name, isError: true,
      output: { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH } })
  }
  throw new Error("agent aborted")
}

export async function finishCheckpointFailure(session: Session, batch: BatchCall[], records: BatchRecords, cancellation: BatchCancellation): Promise<void> {
  const fallback = cancellation.firstError instanceof Error ? cancellation.firstError.message : String(cancellation.firstError)
  for (let i = records.committed; i < records.startedUpTo; i += 1) {
    if (records.getSlot(i) !== undefined) continue
    const call = batch[i]!
    const message = cancellation.failureMessage(i, fallback)
    records.setSlot(i, { name: call.name, callId: call.callId, synthetic: true, output: { error: message, code: TOOL_FAILED } })
  }
  // Record a commit failure without suppressing never-started fills. The
  // checkpoint failure keeps its original precedence, even when undefined.
  let commitError: unknown
  let hasCommitError = false
  try { await records.commitReady() } catch (error) { hasCommitError = true; commitError = error }
  for (let i = records.startedUpTo; i < batch.length; i += 1) {
    if (records.getSlot(i) !== undefined) continue
    const call = batch[i]!
    append(session, { type: "tool/result", callId: call.callId, name: call.name, isError: true,
      output: { error: "tool call cancelled: the batch checkpoint failed", code: TOOL_CANCELLED_BY_SIBLING } })
  }
  // Inherited cursor limitation: an ordered-lane throw can leave settled slots
  // beyond the cursor unrecorded. S17 preserves it for later completion work.
  if (cancellation.hasFlushError) throw cancellation.firstFlushError
  if (hasCommitError) throw commitError
}
