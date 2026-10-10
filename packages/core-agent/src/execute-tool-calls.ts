import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"
import type { PreparedCall, ToolRegistry } from "@i-harness/core-tools"
import { isPolicyRefusal, ToolArgsError, ToolNotFoundError } from "@i-harness/core-tools"
import {
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_ABORTED_MID_FLIGHT,
  TOOL_CANCELLED_BY_SIBLING,
  TOOL_FAILED,
} from "@i-harness/core-tools"
import type { Telemetry } from "@i-harness/telemetry"

// Re-exported from @i-harness/core-tools, which owns the tool-result contract.
// Kept here so every existing importer (and the tests) do not move.
export { TOOL_ABORTED_BEFORE_DISPATCH, TOOL_CANCELLED_BY_SIBLING, TOOL_FAILED }

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
  // M70: optional host checkpoint capability — make the session log durable up
  // to the `tool/dispatch` marker that was just appended, and REJECT when that
  // could not be done. The shipped host passes the coordinator's write-behind
  // drain (`() => coordinator.flush(sessionId)`), which resolves only after the
  // backend write returned; the marker is therefore on disk before the body
  // runs, and a kill cannot lose it. Absent (every subagent host today, and
  // every test that does not opt in) → NO checkpoint and byte-identical pre-M70
  // behavior — this seam is optional exactly like `telemetry` above.
  flush?: () => Promise<void>
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
  // Preserve each rejection before observations/classification so an abort or
  // checkpoint drain never attributes a sibling's error to this call.
  const failures = new Map<number, unknown>()
  const inFlight = new Map<number, Promise<number>>()
  let startedUpTo = 0 // next batch index that has NOT started (never-started boundary)
  let committed = 0
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

  const isExclusive = (name: string): boolean => tools.get(name)?.isConcurrencySafe !== true

  const commitReady = async (): Promise<void> => {
    if (opts.signal?.aborted) aborted = true
    while (committed < batch.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = batch[committed]!
      if ("synthetic" in slot) {
        // M51 B3: an abort fill whose output is already decided — append only,
        // so the head-of-line cursor advances in model order without running
        // finalize (tools/post-execute) or agent/post-tool.
        append(session, { type: "tool/result", callId: slot.callId, name: slot.name, output: slot.output, isError: true })
        committed += 1
        continue
      }
      // finalize runs in the ordered commit lane (post-execute + wrap) — the
      // parallel path must not skip the staged post-execute seam.
      const finalized = await tools.finalize(slot.prepared, slot.output)
      // Filesystem, terminal and timeout tools return expected failures as a
      // typed {error, code} value so the model can retry without aborting the
      // turn. Preserve that disposition for protocols with an error flag.
      const outcome = finalized.output as { error?: unknown; code?: unknown } | null
      const isError = outcome !== null && typeof outcome === "object" && !Array.isArray(outcome)
        && typeof outcome.error === "string" && typeof outcome.code === "string"
      append(session, { type: "tool/result", callId: slot.callId, name: slot.name, output: finalized.output, ...(isError ? { isError: true } : {}) })
      // The durable answer already exists. A throwing observation must not
      // cause the abort drain to append this same call's answer a second time.
      committed += 1
      // finalize can await hooks while the owner presses Stop. Keep the real
      // completed answer, but do not start post-tool effects after that abort.
      if (opts.signal?.aborted) aborted = true
      // M25: tool/end beside the tool/result commit (model-order lane).
      opts.telemetry?.emit({ type: "tool/end", ts: Date.now(), data: { tool: slot.name, callId: slot.callId } })
      // M10a ordering ruling: post-tool only for completed dispatches and only
      // when not aborted (the abort check precedes the observation).
      if (!aborted) {
        await ctx.emit("agent/post-tool", { name: call.name, args: call.args, output: finalized.output, session })
      }
    }
  }

  const startCall = async (index: number): Promise<void> => {
    const call = batch[index]!
    // The never-started boundary (`startedUpTo`) advances only AFTER prepare
    // succeeds: a call whose `prepare` throws was never dispatched, so it must
    // not be counted as started — the boundary stays truthful (on abort the
    // [startedUpTo, batch.length) range decides which calls get synthesized
    // TOOL_ABORTED_BEFORE_DISPATCH results).
    let prepared: PreparedCall
    try {
      prepared = await tools.prepare(
        { name: call.name, args: call.args },
        batchSignal,
        { sessionId: opts.sessionId, session, callId: call.callId, callEventSeq: call.eventSeq },
      )
    } catch (err) {
      if (!isPolicyRefusal(err) && (err instanceof ToolArgsError || err instanceof ToolNotFoundError)) {
        // A TYPED disposition, checked by name — never a message list. The
        // model CAN fix these, so they are soft; every other `prepare`
        // refusal (guard / approval / guardian / host error) stays loud.
        //
        // Record and answer this call without advancing the dispatch boundary
        // or cancelling a sibling. The malformed body never runs.
        failures.set(index, err)
        slots[index] = {
          name: call.name,
          callId: call.callId,
          synthetic: true,
          output: { error: (err as Error).message, code: TOOL_FAILED },
        }
        // The flag AND the value, never one variable for both: `throw
        // undefined` is legal, so a value used as a flag reads falsy on a
        // failure that happened.
        if (!hasFailed) {
          firstError = err
          hasFailed = true
        }
        // Invalid names/arguments do not revoke independent calls' permission.
        return
      }
      throw err
    }
    // Approval/policy preparation can await. A stop in that window means the
    // prepared call never reached dispatch, so it gets the before-dispatch
    // verdict from the abort synthesis below and no marker/body.
    if (batchSignal.aborted) return
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
    // M70: make the marker above DURABLE before the body runs (checkpoint
    // policy, ported from dsh's `session-checkpoint-policy`). The append alone
    // is not enough: the host's write-behind batches on a fixed deadline
    // (200 ms shipped), so a kill inside that window takes the marker with the
    // batch — and recovery reads the marker to tell "the body started" from
    // "the body never ran" (`repair.ts`), so a lost marker makes a re-run of a
    // side effect look licensed. Awaiting the host's drain closes that window:
    // when this resolves, the marker is on disk. It is the LAST await before
    // the body, and there is no path to the body that skips it.
    if (opts.flush !== undefined) {
      try {
        await opts.flush()
      } catch (err: unknown) {
        // FAIL CLOSED: the body does not run. Its verdict is that fact, in the
        // vocabulary that already exists — the body never ran, so
        // TOOL_ABORTED_BEFORE_DISPATCH is literally true of it (M4's constant,
        // no new code: a flush failure is not a new KIND of outcome).
        //
        // Recorded FIRST, like the dispatch `.catch` and the typed-argument
        // arm: this call's own failure goes down before anything else can stamp
        // a sibling's message on its slot.
        failures.set(index, err)
        slots[index] = {
          name: call.name,
          callId: call.callId,
          synthetic: true,
          output: {
            error: `tool call aborted before dispatch: ${err instanceof Error ? err.message : String(err)}`,
            code: TOOL_ABORTED_BEFORE_DISPATCH,
          },
        }
        if (!hasFailed) {
          firstError = err
          hasFailed = true
        }
        // A broken store is an EXECUTION-level event, and this file already
        // rules on a lost durable write: record it, let the fills and the
        // commit lane run so the log is not half-committed, then RETHROW (M5
        // T4 R5 — "a durable write failure must not become a silently
        // continuing turn"). The throw happens at the end of this function;
        // see `firstFlushError`/`hasFlushError` above for why it cannot happen
        // here and why the flag is what the rethrow tests.
        if (!hasFlushError) {
          firstFlushError = err
          hasFlushError = true
        }
        stopped = true
        // A batch whose store is broken must not keep starting bodies.
        batchAbort.abort()
        return
      }
    }
    // The checkpoint can also await while the owner cancels or a sibling's
    // policy gate stops the batch. The marker exists, but the body did not run.
    if (batchSignal.aborted) {
      slots[index] = { name: call.name, callId: call.callId, synthetic: true,
        output: { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH } }
      return
    }
    // M25: tool/start only once the call is REALLY dispatched (after prepare —
    // a prepare failure means the tool never started, mirroring the
    // never-started boundary that abort synthesis relies on; M70 adds the
    // checkpoint to that same rule, so a call whose marker could not be made
    // durable is never reported as started).
    opts.telemetry?.emit({ type: "tool/start", ts: Date.now(), data: { tool: call.name, callId: call.callId } })
    const promise = tools
      .dispatch(prepared)
      .then((output) => {
        slots[index] = { name: call.name, callId: call.callId, prepared, output }
      })
      .catch((err: unknown) => {
        // Record this rejection before classification and observations. The
        // drain needs its own reason even if another error stops the batch.
        failures.set(index, err)
        if (!hasFailed) {
          firstError = err
          hasFailed = true
        }
        // Fill the ordinary failure immediately: leaving it empty until a
        // batch-wide drain stalls ordered commits while later calls continue.
        // An owner abort still uses the mid-flight synthesis below.
        if (isPolicyRefusal(err)) stopForRefusal(err)
        else if (!opts.signal?.aborted) {
          slots[index] = { name: call.name, callId: call.callId, synthetic: true,
            output: { error: err instanceof Error ? err.message : String(err), code: TOOL_FAILED } }
        }
        try {
          opts.telemetry?.emit({
            type: "tool/error", ts: Date.now(),
            data: { tool: call.name, callId: call.callId, error: err instanceof Error ? err.message : String(err) },
          })
        } catch (error) {
          // An observation failure must not disappear inside allSettled,
          // especially when it arrives after another dispatch failed.
          stopForRefusal(error)
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
      if (opts.signal?.aborted) aborted = true
      if (aborted || stopped) break
      while (gi < indices.length && inFlight.size < opts.maxParallel && !aborted && !stopped) {
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
      if (stopped || aborted) break
    }
  } catch (err) {
    if (!hasFailed) firstError = err
    hasFailed = true
    // Anything thrown outside the dispatch `.catch` is a refusal. It DOMINATES:
    // a policy refusal must never be silently downgraded by a coincident body
    // failure, so a refusal that arrives second still wins.
    stopForRefusal(err)
  }

  // Drain before deciding disposition: a late marked policy refusal must
  // dominate an ordinary body failure, and no dispatch may outlive this call.
  await Promise.allSettled([...inFlight.values()])
  inFlight.clear()
  // Cancellation can arrive while draining after any stopping condition.
  if (opts.signal?.aborted) aborted = true

  // Abort dominates: commit what settled in model order, synthesize.
  if (aborted) {
    // Abort dominates a coincident commit-lane failure: `commitReady` runs
    // user/policy-controlled tools/post-execute listeners that can throw, and
    // that must NOT suppress the synthetic TOOL_ABORTED_BEFORE_DISPATCH results
    // or the "agent aborted" throw — the turn is aborting regardless. The
    // swallow is safe HERE and only here, because this branch throws on the
    // very next line: a swallowed error cannot leave behind a turn that keeps
    // running. The non-abort failure path suppresses nothing — it records the
    // lane's error, lets the fills run, and rethrows it (M5 T6), so a lost
    // durable write fails the turn instead of continuing it in silence.
    // M51 B3: every STARTED slot that produced no output failed; leaving it
    // undefined stalled the head-of-line cursor forever, so a sibling that had
    // already settled successfully never got a tool/result. Fill each with a
    // synthetic failure so the cursor advances and the settled siblings commit
    // their REAL outputs in model order.
    //
    // Per call, from the SAME map the soft fill reads. (M5 T4 block ②: the
    // shared message was merely imprecise while `firstError` could only be a
    // tool-body failure; `firstError` can now be a TYPED ARGUMENT REFUSAL, and
    // stamping it on every slot told a sibling killed by the cancel about a
    // DIFFERENT call's arguments.)
    const fallbackMessage = firstError instanceof Error
      ? firstError.message
      : firstError === undefined ? "tool call aborted before dispatch" : String(firstError)
    for (let i = committed; i < startedUpTo; i += 1) {
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      // THIS call's own message when it has one. The test is `failures.has(i)`
      // — NOT `failures.get(i) !== undefined`: a body that rejects with
      // `undefined` DOES record itself (`set(i, undefined)`), and a value test
      // cannot tell that record from "no entry" — so that call would be stamped
      // with its SIBLING's message, the misattribution this map exists to kill.
      // `fallbackMessage` is only for a slot that never got an entry of its own
      // (the defensive fallback the soft fill below also keeps).
      const own = failures.get(i)
      const message = failures.has(i)
        ? (own instanceof Error ? own.message : String(own))
        : fallbackMessage
      slots[i] = { name: call.name, callId: call.callId, synthetic: true, output: { error: message, code: TOOL_ABORTED_MID_FLIGHT } }
    }
    try {
      await commitReady()
    } catch {
      // swallow — abort dominates
    }
    for (let i = startedUpTo; i < batch.length; i += 1) {
      // A call can be in the never-started range AND already have a result: a
      // malformed-argument refusal fills its slot and returns before
      // `startedUpTo` advances (it truly never started). Appending again would
      // write TWO results for one callId — a `tool_use` answered twice.
      //
      // `slots[i] !== undefined` is the SAFE kind of "was this filled?" test:
      // a filled slot is always an OBJECT (`Slot | SyntheticSlot` both are), so
      // there is no "filled with `undefined`" state that a value test would
      // confuse with "not filled" — unlike the flag/value pairs this file has
      // collided with three times.
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      append(session, {
        type: "tool/result",
        callId: call.callId,
        name: call.name,
        isError: true,
        output: { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH },
      })
    }
    throw new Error("agent aborted")
  }

  // A refusal is never soft. The drain above has already settled every
  // in-flight dispatch, so `firstRefusal` is final here.
  if (hasRefusal) {
    throw firstRefusal
  }

  // A checkpoint failure stops the batch, records what settled and fills
  // pending calls before rethrowing the store error. Ordinary failed calls
  // already committed in the rolling pool and never reach this branch.
  if (hasFlushError) {
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
      // A call can be in the never-started range AND already have a result: a
      // malformed-argument refusal fills its slot and returns before
      // `startedUpTo` advances (it truly never started). Appending again would
      // write TWO results for one callId — a `tool_use` answered twice.
      //
      // `slots[i] !== undefined` is the SAFE kind of "was this filled?" test:
      // a filled slot is always an OBJECT (`Slot | SyntheticSlot` both are), so
      // there is no "filled with `undefined`" state that a value test would
      // confuse with "not filled" — unlike the flag/value pairs this file has
      // collided with three times.
      if (slots[i] !== undefined) continue
      const call = batch[i]!
      append(session, {
        type: "tool/result",
        callId: call.callId,
        name: call.name,
        isError: true,
        output: {
          error: "tool call cancelled: the batch checkpoint failed",
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
    //
    // M70: the checkpoint's failure is rethrown FIRST, and it is the same rule
    // read from the other end — a store that cannot accept a write is exactly
    // the "lost durable write" this rethrow exists for (M5 T4 R5), and every
    // fill and commit above has already run, so the log keeps the record of what
    // happened before the store broke. It dominates a coincident commit-lane
    // error because it is the root cause of it; both mean the same thing here.
    // The body's OWN failure is still on its result (`failures`), and this
    // error is the store's — the two are different facts and neither hides the
    // other. Two coincidences keep their existing dominance, and in both the
    // turn fails anyway, so only the MESSAGE differs: a POLICY refusal (rethrown
    // above this branch, on the rule that makes a refusal never soft) and a
    // user ABORT (the branch above this one, "agent aborted"). In the abort case
    // the failed call's own verdict is still committed first — the abort path's
    // commit lane runs the slot filled here, synthetic as it is.
    //
    // The FLAG decides, never `firstFlushError !== undefined`: a `flush` that
    // rejects without a reason is a failure that happened, and the value
    // test would call it "no failure" (the trap `hasFailed`/`hasCommitError`
    // are split for — see their notes above).
    if (hasFlushError) throw firstFlushError
    if (hasCommitError) throw commitError
  }
}
