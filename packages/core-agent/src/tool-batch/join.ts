import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { BatchCall, ExecuteToolCallsOptions } from "./types.ts"
import { createBatchCancellation, finishCancelledBatch, finishCheckpointFailure } from "./cancel.ts"
import { createBatchRecords } from "./record.ts"
import { createStartCall } from "./dispatch.ts"

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

export async function executeToolCalls(ctx: PluginContext, session: Session, tools: ToolRegistry, batch: BatchCall[], opts: ExecuteToolCallsOptions): Promise<void> {
  // Allocate model-order slots before reading the owner's signal, matching the
  // original initialization. The commit capability is resolved only on use.
  const records = createBatchRecords(ctx, session, tools, batch, opts, () => cancellation)
  const cancellation = createBatchCancellation(opts)
  const inFlight = new Map<number, Promise<number>>()
  const startCall = createStartCall(session, tools, batch, opts, records, cancellation, (index, promise) => { inFlight.set(index, promise) })
  const isExclusive = (name: string): boolean => tools.get(name)?.isConcurrencySafe !== true
  // Partition into groups (batch-index runs): maximal runs of parallel-safe
  // calls; each exclusive call is a singleton group.
  const groups: number[][] = []
  let current: number[] = []
  for (let i = 0; i < batch.length; i += 1) {
    if (isExclusive(batch[i]!.name)) {
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
      if (cancellation.aborted || cancellation.stopped) break
      while (gi < indices.length && inFlight.size < opts.maxParallel && !cancellation.aborted && !cancellation.stopped) {
        await startCall(indices[gi]!)
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
      if (cancellation.stopped || cancellation.aborted) break
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
  if (cancellation.aborted) return finishCancelledBatch(session, batch, records, cancellation)
  if (cancellation.hasRefusal) throw cancellation.firstRefusal
  if (cancellation.hasFlushError) return finishCheckpointFailure(session, batch, records, cancellation)
}
