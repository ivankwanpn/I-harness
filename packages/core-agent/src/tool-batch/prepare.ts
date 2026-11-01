import { committedFactSeqs } from "@i-harness/core-session"
import { isPolicyRefusal, isNativePlanValidationError, ToolArgsError, ToolNotFoundError, TOOL_FAILED, TOOL_ABORTED_BEFORE_DISPATCH, type ToolRegistry } from "@i-harness/core-tools"
import type { BatchCall, ExecuteToolCallsOptions } from "./types.ts"
import type { BatchRecords } from "./record.ts"
import type { BatchCancellation } from "./cancel.ts"
import {isManagedBatchSource,type BatchSource} from './managed-source.ts'

// Return the registry promise directly; dispatch owns the original await site.
export function prepareCall(tools: ToolRegistry, call: BatchCall, signal: AbortSignal, opts: ExecuteToolCallsOptions, session: BatchSource) {
  return tools.prepare({ name: call.name, args: call.args }, signal,
    { sessionId: opts.sessionId, ...isManagedBatchSource(session)?{}:{session}, callId: call.callId, callEventSeq: call.eventSeq, settlementSource: opts.settlementSource, modelGeneration: opts.modelGeneration?.(call, signal) })
}

export function recordPreparationFailure(index: number, call: BatchCall, error: unknown, records: BatchRecords, cancellation: BatchCancellation): void {
  // Only typed, unmarked name/argument failures are model-repairable.
  if (isPolicyRefusal(error) || !(error instanceof ToolArgsError || error instanceof ToolNotFoundError || isNativePlanValidationError(error))) throw error
  cancellation.recordFailure(index, error)
  records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true,
    execution: { outcome: 'failed', dispatch: 'not-dispatched' },
    output: isNativePlanValidationError(error) ? error.output : { error: error.message, code: TOOL_FAILED } })
}

export async function markDispatch(session: BatchSource, index: number, call: BatchCall, records: BatchRecords, opts: ExecuteToolCallsOptions): Promise<void> {
  if(isManagedBatchSource(session))session.assertCall(index,call)
  const eventSeq = call.eventSeq ?? (!isManagedBatchSource(session)?session.events.findLast(event => event.type === 'tool/call' && event.callId === call.callId)?.seq:undefined)
  committedFactSeqs(await (isManagedBatchSource(session)?session.markDispatch(index,call):opts.facts!.dispatch(call.callId, eventSeq === undefined ? undefined : { kind: 'prior', seq: eventSeq, expectedType: 'tool/call' })))
  records.markStarted(index)
}

export function recordCheckpointFailure(index: number, call: BatchCall, error: unknown, records: BatchRecords, cancellation: BatchCancellation): void {
  cancellation.recordFailure(index, error)
  records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true,
    execution: { outcome: 'canceled', dispatch: 'not-dispatched' },
    output: { error: `tool call aborted before dispatch: ${error instanceof Error ? error.message : String(error)}`, code: TOOL_ABORTED_BEFORE_DISPATCH } })
  cancellation.stopForCheckpoint(error)
}
