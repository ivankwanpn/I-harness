import { resolveBatchFacts } from "./facts.ts"
import type { PluginContext } from "@i-harness/core-plugin"
import { isInstructionReplan, isPolicyRefusal, instructionReplan, registryRequiresInstructionOrigin, type ToolRegistry, type CapturedToolCall, type AcceptedInstructionCall } from "@i-harness/core-tools"
import type { BatchCall, ExecuteToolCallsOptions } from "./types.ts"
import { createBatchCancellation, finishCancelledBatch, finishCheckpointFailure } from "./cancel.ts"
import { createBatchRecords } from "./record.ts"
import { createStartCall } from "./dispatch.ts"
import { prepareLiveBatch, bindLiveBatchSource, markLiveBatchClosed } from './live-continuation.ts'
import { recordPreparationFailure } from './prepare.ts'
import {isManagedBatchSource,type BatchSource} from './managed-source.ts'
import {savingFailure} from '../agent/saving-failure.ts'

// M13 bounded rolling-pool scheduler. Model-order guarantees:
//   - start order = model order (groups walk the batch left-to-right);
//   - commit order = model order via a head-of-line cursor over `slots` — a
//     fast later result parks until the slow earlier sibling settles, so
//     tool/result append + agent/post-tool always happen in model order.
// Only `dispatch` (the tool body) overlaps; `prepare` and `finalize` run in
// the ordered lane, keeping the policy layer (approval, pre/post-execute)
// deterministic.
//
// Classification partitions the batch into groups: a group is a maximal run
// of isConcurrencySafe calls; an exclusive call is a singleton group. Groups
// run sequentially (full drain between), so an exclusive call never overlaps
// anything.
//
// Ordinary body failures fill only their own slots. Independent calls in the
// pool and in later exclusive groups continue. A policy refusal (a policy
// `prepare` throw, or a marked dispatch refusal) stops/drains and rethrows.
//
// Missing tool names and malformed arguments are typed dispositions the model
// can repair, so they land in the same soft path
// as a body failure (only that call's slot is filled, `synthetic: true`) while
// it still never reaches the tool body. It is converted in `startCall`, by TYPE —
// every other `prepare` refusal is untouched and loud.
//
// Abort: stop starting, drain started (commit what settled in model order),
// synthesize TOOL_ABORTED_BEFORE_DISPATCH results for never-started calls,
// then throw "agent aborted". Abort dominates a coincident failure. M51 B3:
// a STARTED slot whose dispatch failed also gets a synthetic failure fill
// (no finalize / no agent/post-tool) so an already-settled sibling commits
// its REAL result instead of being orphaned behind the failed slot.

export async function executeToolCalls(ctx: PluginContext, session: BatchSource, tools: ToolRegistry, batch: BatchCall[], opts: ExecuteToolCallsOptions): Promise<void> {
  if(isManagedBatchSource(session))batch=session.captureBatch(batch)
  const liveToken = isManagedBatchSource(session)?undefined:prepareLiveBatch(opts, session, batch)
  opts = resolveBatchFacts(session, opts)
  // Allocate model-order slots before reading the owner's signal, matching the
  // original initialization. The commit capability is resolved only on use.
  const records = createBatchRecords(ctx, session, tools, batch, opts, () => cancellation)
  const cancellation = createBatchCancellation(opts)
  const inFlight = new Map<number, Promise<number>>()
  const captured = new Map<number, { capture: CapturedToolCall; origin?: AcceptedInstructionCall; concurrencySafe: boolean }>()
  const replan: { value?: import('@i-harness/core-tools').InstructionReplanData } = {}
  const startCall = createStartCall(session, tools, batch, opts, records, cancellation, (index, promise) => { inFlight.set(index, promise) }, index => captured.get(index), replan, liveToken)
  const finished = Promise.withResolvers<void>()
  const source = opts.registerFactSource!(async () => { await finished.promise; await records.drainSettled() })
  const closeSource = source.close.bind(source)
  bindLiveBatchSource(liveToken, source)
  opts.sourceFacts = source.tools
  opts.settlementSource = source
  opts.requireFactRecovery = () => source.requireRecovery()
  opts.holdFactRecovery = () => source.holdRecovery()
  let executionFailure: unknown
  let executionFailed = false
  try {
  const captureWholeBatch = !!opts.instructionBatch || registryRequiresInstructionOrigin(tools)
  if (captureWholeBatch) {
    const entries: import('@i-harness/core-tools').InstructionBatchEntry[] = []
    let missingOriginMutation = false
    for (let index = 0; index < batch.length; index++) {
      const call = batch[index]!
      try {
        if(isManagedBatchSource(session))session.assertCall(index,call)
        const capture = tools.capture({ name: call.name, args: call.args }, { sessionId: opts.sessionId, ...isManagedBatchSource(session)?{}:{session}, callId: call.callId, callEventSeq: call.eventSeq, settlementSource: opts.settlementSource, modelGeneration: opts.modelGeneration?.(call, cancellation.batchSignal) })
        const origin = opts.instructionBatch?.bind(index, capture), inspected = tools.inspectCapture(capture)
        captured.set(index, { capture, origin, concurrencySafe: inspected.concurrencySafe })
        if (origin) entries.push({ registry: tools, capture, origin })
        else if (inspected.native?.targets.some(target => target.mode === 'mutate')) missingOriginMutation = true
      } catch (error) { recordPreparationFailure(index, call, error, records, cancellation) }
    }
    try {
      if (missingOriginMutation) throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'missing-origin', currentFingerprint: '' })
      await opts.instructionBatch?.preflight(entries, cancellation.batchSignal)
    }
    catch (error) {
      cancellation.observeAbort()
      if (!cancellation.aborted && (!isInstructionReplan(error) || isPolicyRefusal(error))) throw error
      // Initial refusal closes admission, but still passes through the original
      // drain/Stop arbitration before choosing any never-dispatched results.
      if (!cancellation.aborted && isInstructionReplan(error)) replan.value = error.data
    }
  }
  const isExclusive = (index: number): boolean => captureWholeBatch ? captured.get(index)?.concurrencySafe !== true : tools.get(batch[index]!.name)?.isConcurrencySafe !== true
  // Partition into groups (batch-index runs): maximal runs of parallel-safe
  // calls; each exclusive call is a singleton group.
  const groups: number[][] = []
  let current: number[] = []
  for (let i = 0; i < batch.length; i += 1) {
    if (isExclusive(i)) {
      if (current.length > 0) {
        groups.push(current)
        current = []
      }
      groups.push([i])
    } else {
      current.push(i)
    }
  }
  if (current.length > 0) groups.push(current)

  async function runGroup(indices: number[]): Promise<void> {
    let gi = 0
    while (gi < indices.length || inFlight.size > 0) {
      cancellation.observeAbort()
      if (cancellation.aborted || cancellation.stopped || replan.value) break
      while (gi < indices.length && inFlight.size < opts.maxParallel && !cancellation.aborted && !cancellation.stopped && !replan.value) {
        if (!records.getSlot(indices[gi]!)) await startCall(indices[gi]!)
        gi += 1
        await records.commitReady()
        cancellation.observeAbort()
      }
      if (inFlight.size === 0) continue
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      await records.commitReady()
      cancellation.observeAbort()
    }
  }

  try {
    for (const group of groups) {
      await runGroup(group)
      if (cancellation.stopped || cancellation.aborted || replan.value) break
    }
  } catch (err) {
    cancellation.recordOuterFailure(err)
  }

  // Drain before deciding disposition: a late marked policy refusal must
  // dominate an ordinary body failure, and no dispatch may outlive this call.
  await Promise.allSettled([...inFlight.values()])
  inFlight.clear()
  // Cancellation can arrive while draining after any stopping condition.
  cancellation.observeAbort()
  if (cancellation.aborted) return await finishCancelledBatch(session, batch, records, cancellation)
  if (cancellation.hasRefusal) {
    if(isManagedBatchSource(session))records.cancelNeverDispatched(cancellation.firstRefusal)
    try { await records.drainSettled() }
    catch (cause) { throw Object.assign(new AggregateError([cancellation.firstRefusal, cause], `${cancellation.firstRefusal instanceof Error ? cancellation.firstRefusal.message : 'Tool execution failed'}; real tool settlement requires recovery`), { code: 'FACT_RECOVERY_REQUIRED' }) }
    throw cancellation.firstRefusal
  }
  if (cancellation.hasFlushError) return await finishCheckpointFailure(session, batch, records, cancellation)
  if (replan.value) {
    for (let index = 0; index < batch.length; index++) if (!records.getSlot(index)) {
      const call = batch[index]!
      records.setSlot(index, { name: call.name, callId: call.callId, synthetic: true, execution: { outcome: 'failed', dispatch: 'not-dispatched' }, output: replan.value })
    }
    await records.commitReady()
  }
  } catch (error) { executionFailed = true; executionFailure = error;try{if(isManagedBatchSource(session))records.cancelNeverDispatched(error)}catch(cleanup){executionFailure=savingFailure(error,[cleanup],'Original never-dispatched cancellation failed')}throw executionFailure }
  finally {
    finished.resolve()
    try { await closeSource() }
    catch (cause) { throw Object.assign(new AggregateError([...(executionFailed ? [executionFailure] : []), cause], `${executionFailure instanceof Error ? executionFailure.message : 'Tool execution failed'}; real tool settlement requires recovery`), { code: 'FACT_RECOVERY_REQUIRED' }) }
    if(isManagedBatchSource(session))session.release()
    if (executionFailed && cancellation.hasFlushError && executionFailure === cancellation.firstFlushError && cancellation.liveEligible && records.liveComplete) markLiveBatchClosed(liveToken, source, executionFailure)
  }
}
