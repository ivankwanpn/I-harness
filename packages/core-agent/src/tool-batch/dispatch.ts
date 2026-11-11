import { getManagedExecutionAdmissionWait } from '@i-harness/core-session/internal/execution'
import { attachModelMember, type LiveBatchToken } from './live-continuation.ts'
import { isPolicyRefusal, isInstructionReplan, instructionReplanDisposition, retainedToolOutcome, resultExecution, TOOL_FAILED, TOOL_ABORTED_BEFORE_DISPATCH, type ToolRegistry, type PreparedCall, type CapturedToolCall, type AcceptedInstructionCall, type InstructionReplanData } from "@i-harness/core-tools"
import type { BatchCall, ExecuteToolCallsOptions } from "./types.ts"
import type { BatchRecords } from "./record.ts"
import type { BatchCancellation } from "./cancel.ts"
import { prepareCall, recordPreparationFailure, markDispatch, recordCheckpointFailure } from "./prepare.ts"
import {isManagedBatchSource,type BatchSource} from './managed-source.ts'

export function createStartCall(session: BatchSource, tools: ToolRegistry, batch: BatchCall[], opts: ExecuteToolCallsOptions, records: BatchRecords, cancellation: BatchCancellation, dispatched: (index: number, promise: Promise<number>) => void, captured?: (index: number) => { capture: CapturedToolCall; origin?: AcceptedInstructionCall } | undefined, replan?: { value?: InstructionReplanData }, liveToken?: LiveBatchToken) {
  return async function startCall(index: number): Promise<void> {
    const call = batch[index]!
    const parkReplan = () => { if (!replan?.value) return false; records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true, execution: { outcome: 'failed', dispatch: 'not-dispatched' }, output: replan.value }); return true }
    if (parkReplan()) return
    if(isManagedBatchSource(session))for(;;){const wait=getManagedExecutionAdmissionWait(session.domain,session.action,cancellation.batchSignal);if(!wait)break;await wait}
    let prepared: PreparedCall
    try {
      const selected = captured?.(index)
      prepared = selected ? await tools.prepareCaptured(selected.capture, cancellation.batchSignal, selected.origin) : await prepareCall(tools, call, cancellation.batchSignal, opts, session)
    }
    catch (error) {
      if (isInstructionReplan(error) && !isPolicyRefusal(error)) {
        if (replan && !replan.value) replan.value = error.data
        records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true, execution: { outcome: 'failed', dispatch: 'not-dispatched' }, output: error.data })
        return
      }
      recordPreparationFailure(index, call, error, records, cancellation); return
    }
    // Approval may await. A cancelled prepared call has no dispatch marker.
    records.prepared(index,prepared)
    if (cancellation.batchSignal.aborted) return
    if (parkReplan()) return
    if(isManagedBatchSource(session))for(;;){const wait=getManagedExecutionAdmissionWait(session.domain,session.action,cancellation.batchSignal);if(!wait)break;await wait}
    try { await markDispatch(session, index, call, records, opts) }
    catch (error) { cancellation.recordCheckpoint({ site: 'raw-checkpoint', index, error }); recordCheckpointFailure(index, call, error, records, cancellation); return }
    if (parkReplan()) return
    // The marker and checkpoint precede the actual body. Keep this direct
    // await and method receiver so a live host seam is read at dispatch time.
    if (opts.flush !== undefined) {
      try { await opts.flush() }
      catch (error) { cancellation.recordCheckpoint({ site: 'raw-checkpoint', index, error }); recordCheckpointFailure(index, call, error, records, cancellation); return }
    }
    if (cancellation.batchSignal.aborted) {
      records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true,
        execution: { outcome: 'canceled', dispatch: 'not-dispatched' },
        output: { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH } })
      return
    }
    if (parkReplan()) return
    if(isManagedBatchSource(session))for(;;){const wait=getManagedExecutionAdmissionWait(session.domain,session.action,cancellation.batchSignal);if(!wait)break;await wait}
    opts.assertFactOpen?.()
    opts.telemetry?.emit({ type: "tool/start", ts: Date.now(), data: { tool: call.name, callId: call.callId } })
    if(isManagedBatchSource(session))session.attach(index,prepared,opts.settlementSource! as import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').FactOutcome>)
    else attachModelMember(liveToken, index, prepared, tools)
    const promise = tools
      .dispatch(prepared)
      .then((output) => {
        const disposition = instructionReplanDisposition(prepared)
        if (disposition && replan && !replan.value) replan.value = disposition
        records.setSlot(index, { name: call.name, callId: call.callId, prepared, output })
      })
      .catch((err: unknown) => {
        if (isInstructionReplan(err) && resultExecution(prepared).dispatch === 'not-dispatched') {
          if (replan && !replan.value) replan.value = err.data
          records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true, execution: { outcome: 'failed', dispatch: 'not-dispatched' }, output: err.data })
          return
        }
        if(isManagedBatchSource(session)&&resultExecution(prepared).dispatch==='not-dispatched'){
          cancellation.recordFailure(index,err);cancellation.stopForRefusal(err);return
        }
        // A canceled real dispatch may subsequently receive an ordinary
        // synthetic failure fill. The fill cannot prove its effects known.
        try { const execution = resultExecution(prepared); if (execution.outcome === 'unknown' || execution.dispatch === 'unknown') cancellation.disqualify() }
        catch { cancellation.disqualify() }
        const retained = retainedToolOutcome(err, prepared)
        if (retained) {
          cancellation.recordCheckpoint({ site: 'retained-dispatch', index, error: err, prepared, retained })
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
            execution: { outcome: resultExecution(prepared).outcome === 'unknown' ? 'unknown' : 'failed', dispatch: 'dispatched' },
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

