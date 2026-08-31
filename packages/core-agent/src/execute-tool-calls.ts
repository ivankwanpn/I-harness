import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"
import type { PreparedCall, ToolRegistry } from "@i-harness/core-tools"
import type { Telemetry } from "@i-harness/telemetry"

export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"

export interface BatchCall {
  callId: string
  name: string
  args: unknown
  // M26 (R-D1): durable seq of the invoking tool/call event (set by runTurn;
  // optional so pre-M26 callers / tests keep compiling).
  eventSeq?: number
}

export interface ExecuteToolCallsOptions {
  maxParallel: number
  signal?: AbortSignal
  // M19 (Ruling 24): the identity of the session whose agent is executing the
  // batch — seeded onto each prepared ToolExec so tool bodies can attribute
  // the caller (the agent-team scheduler resolves team-tool callers from it).
  // Additive: absent → ToolExec.sessionId stays undefined (pre-M19 behavior).
  sessionId?: string
  // M25: optional host telemetry stream (Ruling M25-P3 — independent of the
  // session log, agent-invisible). Absent = no tool events.
  telemetry?: Telemetry
}

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
// Failure (throw-fails-turn, ruling A): stop starting, drain started calls,
// rethrow the first error — NO fabricated results for unstarted calls.
// Abort: stop starting, drain started (commit what settled in model order),
// synthesize TOOL_ABORTED_BEFORE_DISPATCH results for never-started calls,
// then throw "agent aborted". Abort dominates a coincident failure.
export async function executeToolCalls(
  ctx: PluginContext,
  session: Session,
  tools: ToolRegistry,
  batch: BatchCall[],
  opts: ExecuteToolCallsOptions,
): Promise<void> {
  interface Slot { name: string; callId: string; prepared: PreparedCall; output: unknown }
  const slots: (Slot | undefined)[] = batch.map(() => undefined)
  const inFlight = new Map<number, Promise<number>>()
  let startedUpTo = 0 // next batch index that has NOT started (never-started boundary)
  let committed = 0
  let aborted = opts.signal?.aborted ?? false
  let firstError: unknown

  const isExclusive = (name: string): boolean => tools.get(name)?.isConcurrencySafe !== true

  const commitReady = async (): Promise<void> => {
    while (committed < batch.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = batch[committed]!
      // finalize runs in the ordered commit lane (post-execute + wrap) — the
      // parallel path must not skip the staged post-execute seam.
      const finalized = await tools.finalize(slot.prepared, slot.output)
      append(session, { type: "tool/result", callId: slot.callId, name: slot.name, output: finalized.output })
      // M25: tool/end beside the tool/result commit (model-order lane).
      opts.telemetry?.emit({ type: "tool/end", ts: Date.now(), data: { tool: slot.name, callId: slot.callId } })
      // M10a ordering ruling: post-tool only for completed dispatches and only
      // when not aborted (the abort check precedes the observation).
      if (!aborted) {
        await ctx.emit("agent/post-tool", { name: call.name, args: call.args, output: finalized.output, session })
      }
      committed += 1
    }
  }

  const startCall = async (index: number): Promise<void> => {
    const call = batch[index]!
    // The never-started boundary (`startedUpTo`) advances only AFTER prepare
    // succeeds: a call whose `prepare` throws was never dispatched, so it must
    // not be counted as started — the boundary stays truthful (on abort the
    // [startedUpTo, batch.length) range decides which calls get synthesized
    // TOOL_ABORTED_BEFORE_DISPATCH results).
    const prepared = await tools.prepare(
      { name: call.name, args: call.args },
      opts.signal,
      { sessionId: opts.sessionId, callId: call.callId, callEventSeq: call.eventSeq },
    )
    startedUpTo = index + 1
    // M25: tool/start only once the call is REALLY dispatched (after prepare —
    // a prepare failure means the tool never started, mirroring the
    // never-started boundary that abort synthesis relies on).
    opts.telemetry?.emit({ type: "tool/start", ts: Date.now(), data: { tool: call.name, callId: call.callId } })
    const promise = tools
      .dispatch(prepared)
      .then((output) => {
        slots[index] = { name: call.name, callId: call.callId, prepared, output }
      })
      .catch((err: unknown) => {
        // M25: tool/error — the tool body failed (throw-fails-turn semantics).
        opts.telemetry?.emit({
          type: "tool/error",
          ts: Date.now(),
          data: { tool: call.name, callId: call.callId, error: err instanceof Error ? err.message : String(err) },
        })
        firstError ??= err
      })
      .then(() => index)
    inFlight.set(index, promise)
  }

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

  const runGroup = async (indices: number[]): Promise<void> => {
    let gi = 0
    while (gi < indices.length || inFlight.size > 0) {
      if (aborted || firstError) break
      while (gi < indices.length && inFlight.size < opts.maxParallel && !aborted && !firstError) {
        await startCall(indices[gi]!)
        gi += 1
        await commitReady()
        if (opts.signal?.aborted) aborted = true
      }
      if (inFlight.size === 0) continue
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      await commitReady()
      if (opts.signal?.aborted) aborted = true
    }
  }

  try {
    for (const group of groups) {
      await runGroup(group)
      if (firstError || aborted) break
    }
  } catch (err) {
    firstError ??= err
  }

  // Abort dominates: drain started, commit in model order, synthesize.
  if (aborted) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    // Abort dominates a coincident finalize failure: `commitReady` runs
    // user/policy-controlled tools/post-execute listeners that can throw, and
    // that must NOT suppress the synthetic TOOL_ABORTED_BEFORE_DISPATCH results
    // or the "agent aborted" throw — the turn is aborting regardless. The
    // NON-abort path keeps its throw (it flows into `firstError` via the outer
    // try → drain + rethrow, which is the correct throw-fails-turn behavior).
    try {
      await commitReady()
    } catch {
      // swallow — abort dominates
    }
    for (let i = startedUpTo; i < batch.length; i += 1) {
      const call = batch[i]!
      append(session, {
        type: "tool/result",
        callId: call.callId,
        name: call.name,
        output: { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH },
      })
    }
    throw new Error("agent aborted")
  }

  // Failure: drain started (results discarded), rethrow the first error.
  if (firstError) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    throw firstError
  }
}
