import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"
import type { PreparedCall, ToolRegistry } from "@i-harness/core-tools"
import { isPolicyRefusal } from "@i-harness/core-tools"
import type { Telemetry } from "@i-harness/telemetry"

export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"
export const TOOL_FAILED = "TOOL_FAILED"
// A call that never started because a SIBLING failed. Deliberately a
// different code AND a different message from TOOL_ABORTED_BEFORE_DISPATCH:
// "the user stopped the step" and "a tool in this batch broke" are different
// facts, and a log that conflates them cannot be read back.
export const TOOL_CANCELLED_BY_SIBLING = "TOOL_CANCELLED_BY_SIBLING"

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
// Failure (soft since M5 T4 block ①): stop starting, drain started calls,
// fill the failed slot, commit what settled, and give never-started calls a
// TOOL_CANCELLED_BY_SIBLING result. That verdict is not fabricated: CANCELLED
// is what happened to that call — it never started — not a made-up outcome.
// (The FILL is a different thing and does not claim otherwise: it is written
// `synthetic: true`.) A policy refusal (a `prepare` throw, or a cascade throw
// carrying the `isPolicyRefusal` marker) still rethrows.
// Abort: stop starting, drain started (commit what settled in model order),
// synthesize TOOL_ABORTED_BEFORE_DISPATCH results for never-started calls,
// then throw "agent aborted". Abort dominates a coincident failure. M51 B3:
// a STARTED slot whose dispatch failed also gets a synthetic failure fill
// (no finalize / no agent/post-tool) so an already-settled sibling commits
// its REAL result instead of being orphaned behind the failed slot.
export async function executeToolCalls(
  ctx: PluginContext,
  session: Session,
  tools: ToolRegistry,
  batch: BatchCall[],
  opts: ExecuteToolCallsOptions,
): Promise<void> {
  interface Slot { name: string; callId: string; prepared: PreparedCall; output: unknown }
  // M51 B3: the abort path fills a STARTED slot whose dispatch never produced
  // an output (it threw) with a synthetic failure. It deliberately carries no
  // PreparedCall — the commit lane appends it WITHOUT running finalize
  // (tools/post-execute) or agent/post-tool (M10a ordering ruling).
  interface SyntheticSlot { name: string; callId: string; output: unknown; synthetic: true }
  const slots: ((Slot | SyntheticSlot) | undefined)[] = batch.map(() => undefined)
  // Each call's OWN failure, so the fill below can record what actually
  // happened to THAT call rather than stamping the first failure's message on
  // every sibling. After the drain above, an unfilled STARTED slot always has
  // an entry here (allSettled guarantees it settled, and a settled dispatch
  // either wrote `slots[i]` or ran the `.catch`).
  const failures = new Map<number, unknown>()
  const inFlight = new Map<number, Promise<number>>()
  let startedUpTo = 0 // next batch index that has NOT started (never-started boundary)
  let committed = 0
  let aborted = opts.signal?.aborted ?? false
  let firstError: unknown
  // "Did anything fail?" is a SEPARATE variable from the failure's value, on
  // purpose. `firstError` is used as a value (it is thrown on the loud paths and
  // its message is filled into the batch), and a variable cannot carry both jobs:
  // a body that rejects with `undefined` — `throw undefined` is legal — used to
  // fire `batchAbort.abort()` while every `if (firstError)` read falsy, so the
  // soft fill and the never-started fill both skipped and the projection emitted
  // a tool_use with no tool_result. The flag is the flag; the value is the value
  // (`firstError` is read for its content only).
  let hasFailed = false
  // M5 T4 block ①: WHICH KIND of failure decides whether the batch is soft.
  // A throw from a TOOL BODY (the dispatch `.catch` below) is soft: the failed
  // call gets a result and the turn continues. Every OTHER throw that reaches
  // this scope stays loud — a `prepare` refusal (unknown tool / guard denied /
  // a `tools/pre-execute` deny / denied / approval fail-closed / guardian
  // denied), and a throwing commit-lane listener.
  //
  // Structural, not a list: the SITE of the throw is the classification, so a
  // fifth refusal added to `prepare` tomorrow is loud without anyone
  // remembering to add it here. (A list is what gets forgotten — which is how
  // the first draft of this task got it wrong.)
  let firstRefusal: unknown
  // M5 T4: the batch's OWN abort channel. Measured before adding it: the failure
  // path said "drain started (results discarded)" and awaited `allSettled`, so a
  // failed call left its siblings running — a `bash` still spawning, a fetch
  // still in flight — threw their results away anyway, and made the caller wait
  // for the SLOWEST of them before the error surfaced. The roadmap asks for
  // "可取消", and the mechanism was already there: `prepare` puts the signal on
  // `prepared.exec.abortSignal` (core-tools:291), so a body can observe it.
  // Composed with the outer signal rather than replacing it — an abort and a
  // failure are different events and both must reach the body.
  const batchAbort = new AbortController()
  const batchSignal = opts.signal !== undefined
    ? AbortSignal.any([opts.signal, batchAbort.signal])
    : batchAbort.signal

  const isExclusive = (name: string): boolean => tools.get(name)?.isConcurrencySafe !== true

  const commitReady = async (): Promise<void> => {
    while (committed < batch.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = batch[committed]!
      if ("synthetic" in slot) {
        // M51 B3: an abort fill whose output is already decided — append only,
        // so the head-of-line cursor advances in model order without running
        // finalize (tools/post-execute) or agent/post-tool.
        append(session, { type: "tool/result", callId: slot.callId, name: slot.name, output: slot.output })
        committed += 1
        continue
      }
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
      batchSignal,
      { sessionId: opts.sessionId, callId: call.callId, callEventSeq: call.eventSeq },
    )
    startedUpTo = index + 1
    // M4: make the boundary DURABLE, at the exact point it becomes true. The
    // in-memory `startedUpTo` above already carries this fact for the abort path;
    // a process that DIES instead of aborting loses it, and `repairTurnTail` then
    // gave every pending call the "aborted before dispatch" verdict — including
    // the ones whose bodies had run, whose side effects a re-run would double.
    // `append` is the SAME call the tool/result path uses, so this costs one
    // event and no new store.
    append(session, {
      type: "tool/dispatch",
      callId: call.callId,
      ...(call.eventSeq !== undefined ? { eventSeq: call.eventSeq } : {}),
    })
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
        // M25: tool/error — the dispatched call's promise rejected. The M5 T4
        // classification below decides what that rejection means for the turn.
        opts.telemetry?.emit({
          type: "tool/error",
          ts: Date.now(),
          data: { tool: call.name, callId: call.callId, error: err instanceof Error ? err.message : String(err) },
        })
        if (isPolicyRefusal(err)) {
          // A veto is not a body failure: it must keep failing the turn.
          firstRefusal ??= err
        }
        // This call's OWN rejection, for the per-call fill on the soft path —
        // OUTSIDE the `hasFailed` guard below, which only keeps the first.
        failures.set(index, err)
        // M5 T4: on the FIRST failure, cancel the siblings. `abort()` lands here
        // (before the drains below), so `allSettled` returns their cancellations
        // instead of waiting out their work. Only the first, so a second failure
        // cannot re-open a channel that is already closed. "First" is read off
        // the FLAG, not off `firstError === undefined`: the value may legitimately
        // be `undefined`, the flag cannot.
        if (!hasFailed) {
          firstError = err
          hasFailed = true
          batchAbort.abort()
        }
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
      if (aborted || hasFailed) break
      while (gi < indices.length && inFlight.size < opts.maxParallel && !aborted && !hasFailed) {
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
      if (hasFailed || aborted) break
    }
  } catch (err) {
    if (!hasFailed) firstError = err
    hasFailed = true
    // Anything thrown outside the dispatch `.catch` is a refusal. It DOMINATES:
    // a policy refusal must never be silently downgraded by a coincident body
    // failure, so a refusal that arrives second still wins.
    firstRefusal ??= err
  }

  // Abort dominates: drain started, commit in model order, synthesize.
  if (aborted) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    // Abort dominates a coincident commit-lane failure: `commitReady` runs
    // user/policy-controlled tools/post-execute listeners that can throw, and
    // that must NOT suppress the synthetic TOOL_ABORTED_BEFORE_DISPATCH results
    // or the "agent aborted" throw — the turn is aborting regardless. The
    // swallow is safe HERE and only here, because this branch throws on the
    // very next line: a swallowed error cannot leave behind a turn that keeps
    // running. The non-abort failure path swallows nothing — it records the
    // lane's error, lets the fills run, and rethrows it (M5 T6), so a lost
    // durable write fails the turn instead of continuing it in silence.
    // M51 B3: every STARTED slot that produced no output failed; leaving it
    // undefined stalled the head-of-line cursor forever, so a sibling that had
    // already settled successfully never got a tool/result. Fill each with a
    // synthetic failure (the first error's message) so the cursor advances and
    // the settled siblings commit their REAL outputs in model order. This fill
    // belongs to the abort path; the soft failure path below fills the same
    // holes, but per call — each slot there carries its OWN failure's message
    // rather than one shared message, because it can attribute them.
    const failureMessage = firstError instanceof Error
      ? firstError.message
      : firstError === undefined ? "tool call aborted before dispatch" : String(firstError)
    for (let i = committed; i < startedUpTo; i += 1) {
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      slots[i] = { name: call.name, callId: call.callId, synthetic: true, output: { error: failureMessage } }
    }
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

  // Drain BEFORE the disposition tests. Every write to `firstError` and
  // `firstRefusal` happens in a `.catch` handler, so until the in-flight
  // promises have settled neither is final — and a refusal that settles one
  // microtask late is tested as "not a refusal" and silently downgraded to
  // the soft path. (Measured before this drain existed: the same marked veto
  // threw when its own .catch ran first, and resolved softly — recorded
  // against a sibling's error message — when a sibling's failure got there
  // first. A pre-tool hook is a SUBPROCESS; losing that race is the normal
  // case, not the exotic one.)
  await Promise.allSettled([...inFlight.values()])
  inFlight.clear()

  // A refusal is never soft. The drain above has already settled every
  // in-flight dispatch, so `firstRefusal` is final here.
  if (firstRefusal !== undefined) {
    throw firstRefusal
  }

  // Failure: cancel the siblings (M5 T4), then COMMIT — every DISPATCHED call
  // ends in exactly one tool/result. This used to `throw firstError` and
  // discard the batch; fs/src/error.ts records the consequence in its own
  // words ("no tool/result and no turn/end are appended ... read as hung").
  //
  // Cancelling and committing are different questions: cancellation answers
  // "do the siblings keep working" (no), committing answers "how does what
  // happened get written down" (honestly). Discarding the siblings' already
  // settled results made the M5 T4 cancellation pointless — they were
  // cancelled AND thrown away.
  //
  // Reached ONLY when `firstRefusal` is undefined (checked above): a throw
  // from a tool body. A refusal never gets here.
  if (hasFailed) {
    // Fill every STARTED slot that produced no output, so the head-of-line
    // cursor advances and an already-settled sibling commits its REAL result
    // (the SAME mechanism M51 B3 added to the abort path, one branch up).
    for (let i = committed; i < startedUpTo; i += 1) {
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      // THIS call's own message. The test is `failures.has(i)` — NOT
      // `failures.get(i) !== undefined`: a body that rejects with `undefined`
      // DOES record itself (`set(i, undefined)`), and a value test cannot tell
      // that record from "no entry" — so that call would be stamped with its
      // SIBLING's message, the exact misattribution this map was added to
      // kill. `firstError` is only a defensive fallback: after the drain, a
      // settled started call either wrote `slots[i]` or ran its `.catch` and
      // recorded its own error here.
      const own = failures.get(i)
      const message = failures.has(i)
        ? (own instanceof Error ? own.message : String(own))
        : firstError instanceof Error ? firstError.message : String(firstError)
      slots[i] = {
        name: call.name,
        callId: call.callId,
        synthetic: true,
        output: { error: message, code: TOOL_FAILED },
      }
    }
    let commitError: unknown
    let hasCommitError = false
    try {
      await commitReady()
    } catch (err) {
      // A throwing commit-lane listener must not suppress the never-started
      // fills below — the abort path swallows for exactly this reason (see its
      // comment at the top of the abort branch). But this catch must not
      // swallow the WHOLE commit lane either, the way a BARE `catch {}` did
      // before M5 T6: `commitReady` also runs `append`, whose fail-loud paths
      // (core-session's image validation among them) must stay loud, and a turn
      // that keeps running after a lost durable write is worse than a turn that
      // fails. So: record the error, let the fills run, rethrow it after them.
      // The flag carries "it threw" and the value carries what it threw — one
      // variable cannot do both jobs, because `throw undefined` is legal (the
      // same split `hasFailed`/`firstError` makes above).
      hasCommitError = true
      commitError = err
    }
    // Calls that never started: no `prepare`, no `tool/dispatch`, no body.
    // They get a result too, so the projection never emits a tool_use with no
    // tool_result — but their verdict is CANCELLATION, not abort.
    for (let i = startedUpTo; i < batch.length; i += 1) {
      const call = batch[i]!
      append(session, {
        type: "tool/result",
        callId: call.callId,
        name: call.name,
        output: {
          error: "tool call cancelled: a sibling call in the same batch failed",
          code: TOOL_CANCELLED_BY_SIBLING,
        },
      })
    }
    // STATED COST (inherited, not introduced): the cursor stopped where the
    // commit lane threw, so every slot from there on never reached the log — a
    // settled sibling's REAL result AND the synthetic fills written just above
    // (the filled slots lose their tool/result too, not only the settled
    // siblings). The never-started calls are appended outside the cursor, so
    // they do get theirs. The abort path has the same hole. The rethrow below
    // does not repair the cursor; it makes the half-committed log fail the turn
    // loudly instead of letting the turn continue in silence.
    if (hasCommitError) throw commitError
  }
}
