import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"
import type { PreparedCall, ToolRegistry } from "@i-harness/core-tools"

export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"

export interface BatchCall {
  callId: string
  name: string
  args: unknown
}

export interface ExecuteToolCallsOptions {
  maxParallel: number
  signal?: AbortSignal
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
    startedUpTo = index + 1
    const prepared = await tools.prepare({ name: call.name, args: call.args }, opts.signal)
    const promise = tools
      .dispatch(prepared)
      .then((output) => {
        slots[index] = { name: call.name, callId: call.callId, prepared, output }
      })
      .catch((err: unknown) => {
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
    await commitReady()
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
