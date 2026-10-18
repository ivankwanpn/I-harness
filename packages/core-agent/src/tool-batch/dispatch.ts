import { type SessionView as Session } from "@i-harness/core-session"
import { isPolicyRefusal, retainedToolOutcome, TOOL_FAILED, TOOL_ABORTED_BEFORE_DISPATCH, type ToolRegistry, type PreparedCall } from "@i-harness/core-tools"
import type { BatchCall, ExecuteToolCallsOptions } from "./types.ts"
import type { BatchRecords } from "./record.ts"
import type { BatchCancellation } from "./cancel.ts"
import { prepareCall, recordPreparationFailure, markDispatch, recordCheckpointFailure } from "./prepare.ts"

export function createStartCall(session: Session, tools: ToolRegistry, batch: BatchCall[], opts: ExecuteToolCallsOptions, records: BatchRecords, cancellation: BatchCancellation, dispatched: (index: number, promise: Promise<number>) => void) {
  return async function startCall(index: number): Promise<void> {
    const call = batch[index]!
    let prepared: PreparedCall
    try { prepared = await prepareCall(tools, call, cancellation.batchSignal, opts, session) }
    catch (error) { recordPreparationFailure(index, call, error, records, cancellation); return }
    // Approval may await. A cancelled prepared call has no dispatch marker.
    if (cancellation.batchSignal.aborted) return
    try { await markDispatch(session, index, call, records, opts) }
    catch (error) { recordCheckpointFailure(index, call, error, records, cancellation); return }
    // The marker and checkpoint precede the actual body. Keep this direct
    // await and method receiver so a live host seam is read at dispatch time.
    if (opts.flush !== undefined) {
      try { await opts.flush() }
      catch (error) { recordCheckpointFailure(index, call, error, records, cancellation); return }
    }
    if (cancellation.batchSignal.aborted) {
      records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true,
        output: { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH } })
      return
    }
    opts.assertFactOpen?.()
    opts.telemetry?.emit({ type: "tool/start", ts: Date.now(), data: { tool: call.name, callId: call.callId } })
    const promise = tools
      .dispatch(prepared)
      .then((output) => {
        records.setSlot(index, { name: call.name, callId: call.callId, prepared, output })
      })
      .catch((err: unknown) => {
        const retained = retainedToolOutcome(err, prepared)
        if (retained) {
          records.setSlot(index, { name: call.name, callId: call.callId, prepared, retained, recoveryCause: err })
          cancellation.recordFailure(index, err); cancellation.stopForCheckpoint(err)
          return
        }
        // Record this rejection before classification and observations. The
        // drain needs its own reason even if another error stops the batch.
        cancellation.recordFailure(index, err)
        // Fill the ordinary failure immediately: leaving it empty until a
        // batch-wide drain stalls ordered commits while later calls continue.
        // An owner abort still uses the mid-flight synthesis below.
        if (isPolicyRefusal(err)) cancellation.stopForRefusal(err)
        else if (!opts.signal?.aborted) {
          records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true,
            output: { error: err instanceof Error ? err.message : String(err), code: TOOL_FAILED } })
        }
        try {
          opts.telemetry?.emit({
            type: "tool/error", ts: Date.now(),
            data: { tool: call.name, callId: call.callId, error: err instanceof Error ? err.message : String(err) },
          })
        } catch (error) {
          // An observation failure must not disappear inside allSettled,
          // especially when it arrives after another dispatch failed.
          cancellation.stopForRefusal(error)
        }
      })
      .then(() => index)
    dispatched(index, promise)
  }
}
