// M27 R-A3: log-semantic repair (dsh core/session/src/repair.ts semantics).
//
// This layer fixes WHAT the backend repair cannot: the backend (jsonl/sqlite)
// truncates a torn write and appends structural closers (step/end, turn/end),
// but a crash mid-tool leaves a `tool/call` WITHOUT its `tool/result` — the
// replay then poses the model an assistant message with toolCalls and no tool
// responses (Messages API role alternation breaks on continue). This module
// is the LOG-SEMANTIC repair: it appends synthetic closers/results.
//
// Contract:
// - PURE: the input array is never mutated (events are clones; synthetics are
//   new objects) — the raw log stays replayable byte-for-byte.
// - DETERMINISTIC: same input → same output (no timestamps, no randomness).
// - TAIL-ONLY: the repair region is the LAST turn (the last `turn/start` to the
//   end of the log); every earlier turn — closed or not — is never touched
//   (spec §1 boundary: "只修最後一個打開序列；已閉檔不碰").
// - FAIL-CLOSED: nothing is silently rewritten; the caller keeps the original
//   when it disagrees (this function only ever ADDS).
//
// Q8 (M71): WHOLE-LOG is a READ, never a repair region. A log that records no
// `tool/dispatch` ANYWHERE cannot prove its pending tail calls never ran, so
// they get the UNKNOWN verdict rather than the benign one — see
// TOOL_OUTCOME_UNKNOWN_UNMARKED_LOG_RESULT. The four properties above are
// untouched: the check reads outside the tail, and still repairs nothing there.
import type { SessionEvent } from "@i-harness/core-session"

/** M10a vocabulary (single source of truth: `@i-harness/core-agent`'s
 * TOOL_ABORTED_BEFORE_DISPATCH synthetic result — imported as a literal here
 * because session-persistence must never depend on core-agent (dependency
 * direction: core-agent consumes session-persistence). */
export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"

/**
 * M4: the verdict for a tool the log says WAS DISPATCHED and whose outcome it
 * does not contain.
 *
 * It is deliberately NOT a flavour of "it did not run", and it is not a failure
 * either — it is the absence of a fact. A `tool/call` is written when the MODEL
 * emits the call and the body runs later, in a batch, so before `tool/dispatch`
 * existed the log could not tell "never dispatched" from "dispatched, still
 * running" — and it answered the benign one. A model that reads the benign
 * answer may re-run the tool, and a `rm` or a `git push` then happens twice.
 *
 * Nothing may auto-replay this. It is a state a human resolves.
 */
export const TOOL_OUTCOME_UNKNOWN = "TOOL_OUTCOME_UNKNOWN"

/** The synthetic tool/result payload, byte-identical in shape to the live
 * abort path (core-agent/src/execute-tool-calls.ts). */
export const TOOL_ABORTED_RECOVERY_RESULT = {
  error: "tool call aborted before dispatch",
  code: TOOL_ABORTED_BEFORE_DISPATCH,
} as const

/** The synthetic result for a DISPATCHED tool whose outcome the log does not
 * contain (M4). Says what is known and stops there — see TOOL_OUTCOME_UNKNOWN. */
export const TOOL_OUTCOME_UNKNOWN_RESULT = {
  error: "tool call was dispatched but its outcome is unknown (the process ended mid-execution)",
  code: TOOL_OUTCOME_UNKNOWN,
  replay: false,
} as const

/**
 * Q8 (M71): the conservative verdict for a pending call in a log that records
 * NO `tool/dispatch` marker ANYWHERE.
 *
 * Such a log cannot prove that the body never ran: a log written by a build
 * that predates the boundary, and a log whose crash landed between `tool/call`
 * and the marker append, leave the same bytes. Reading that absence as "aborted
 * before dispatch" asserts a fact the log does not contain — and a model that
 * believes it may re-run a `git push` whose body had already started.
 *
 * Same `code` as the dispatched arm: the verdict CLASS is identical (the
 * outcome is unknown), so every machine consumer keyed on the code reads it
 * unchanged. It is a separate payload because TOOL_OUTCOME_UNKNOWN_RESULT's
 * message says the call "was dispatched", which is exactly what this log cannot
 * establish.
 *
 * It also does not say the log is OLD: the rule infers from absence, and
 * absence is the whole of what it cannot interpret.
 *
 * ACCEPTED COST, recorded rather than hidden: a call that genuinely never
 * dispatched (the crash landed between `tool/call` and the marker) lands here
 * too. That is the price of the rule — no in-band signal tells the two apart.
 */
export const TOOL_OUTCOME_UNKNOWN_UNMARKED_LOG_RESULT = {
  error: "tool call outcome unknown: the log records no tool/dispatch marker anywhere, so whether the body ran is not recorded; do not replay blindly",
  code: TOOL_OUTCOME_UNKNOWN,
  replay: false,
} as const

interface PendingCall {
  callId: string
  name: string
  /** M4: the log contains a `tool/dispatch` for this call, so the body STARTED
   * and the outcome is genuinely unknown rather than "never ran". */
  dispatched: boolean
}

/** Deterministic lexical set of events that establish a step region even when
 * the step/start marker itself was lost with the torn write — a turn carrying
 * such content is an IMPLICIT step and gets a closing step/end. */
const STEP_CONTENT_TYPES = new Set<SessionEvent["type"]>([
  "assistant/message",
  "assistant/chunk",
  "tool/call",
  "tool/result",
])

/**
 * Append synthetic closers to open sequences at the END of a session log.
 *
 * - Every `tool/call` in the LAST turn without a matching `tool/result`
 *   receives a synthetic result, in call order, whose payload the log's own
 *   evidence picks: TOOL_OUTCOME_UNKNOWN for a call the log marks dispatched;
 *   TOOL_ABORTED_RECOVERY_RESULT (M10a vocabulary) for a marker-less call in a
 *   log that carries a marker SOMEWHERE; and — when the log carries no marker
 *   AT ALL (Q8, a read over the WHOLE log) — the conservative
 *   TOOL_OUTCOME_UNKNOWN_UNMARKED_LOG_RESULT.
 * - If the last turn never ended: a closing `step/end` is appended when the
 *   turn's step region is open (or the turn carries step content without any
 *   step marker — torn writes lose markers), then the `turn/end`.
 * - An already-closed end (turn/end present) is returned with NO additions.
 *
 * @param events the events as loaded (after backend repair + version gate) —
 *   the WHOLE log, earlier turns included: the Q8 read needs them.
 * @returns a NEW array (input untouched); the original log is never modified.
 */
export function repairTurnTail(events: SessionEvent[]): SessionEvent[] {
  if (events.length === 0) return []

  // Q8 (M71): does THIS LOG prove its writing build had the boundary? One
  // marker in ANY turn does — and then a marker-less call elsewhere in the same
  // log is honestly "never dispatched" rather than unknown. A log with no
  // marker anywhere proves nothing about any call, so its pending tail calls
  // read conservatively. This is a READ of the whole log; the repair region
  // below is still the last turn alone.
  const boundaryProven = events.some((e) => e.type === "tool/dispatch")

  // Locate the last turn's region. No turn/start at all → nothing to repair.
  let turnStart = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === "turn/start") { turnStart = i; break }
  }
  if (turnStart === -1) return events.map((e) => ({ ...e }))

  let turnClosed = false
  let stepsStarted = 0
  let stepsEnded = 0
  let stepContent = false
  let lastCallIdx = -1
  const pending: PendingCall[] = []
  for (let i = turnStart; i < events.length; i += 1) {
    const ev = events[i]!
    if (STEP_CONTENT_TYPES.has(ev.type)) stepContent = true
    switch (ev.type) {
      case "turn/end": turnClosed = true; break
      case "step/start": stepsStarted += 1; break
      case "step/end": stepsEnded += 1; break
      case "tool/call": {
        lastCallIdx = i
        const callId = (ev as { callId?: unknown }).callId
        const name = (ev as { name?: unknown }).name
        pending.push({
          callId: typeof callId === "string" ? callId : "unknown",
          name: typeof name === "string" ? name : "",
          dispatched: false,
        })
        break
      }
      case "tool/dispatch": {
        // M4: the body STARTED. Marking the pending call changes its verdict from
        // "aborted before dispatch" to "outcome unknown" — they demand opposite
        // responses, so reading them apart is the whole point.
        const dispatchedId = (ev as { callId?: unknown }).callId
        if (typeof dispatchedId === "string") {
          const call = pending.find((p) => p.callId === dispatchedId)
          if (call !== undefined) call.dispatched = true
        }
        lastCallIdx = i
        break
      }
      case "tool/result": {
        lastCallIdx = i
        const callId = (ev as { callId?: unknown }).callId
        if (typeof callId === "string") {
          const idx = pending.findIndex((p) => p.callId === callId)
          if (idx !== -1) pending.splice(idx, 1)
        }
        break
      }
      default:
        break
    }
  }

  const out: SessionEvent[] = events.map((e) => ({ ...e }))

  // 1. Missing tool results in the tail. Inserted BEFORE any closer that the
  //    backend structural repair already appended (a result belongs inside its
  //    step, never after step/end/turn/end): first closer strictly after the
  //    last call, else at the end of the region.
  if (pending.length > 0) {
    let insertIdx = out.length
    for (let i = lastCallIdx + 1; i < out.length; i += 1) {
      if (out[i]!.type === "step/end" || out[i]!.type === "turn/end") { insertIdx = i; break }
    }
    out.splice(insertIdx, 0, ...pending.map((call) => ({
      type: "tool/result",
      callId: call.callId,
      name: call.name,
      // M4 + Q8: the verdict is READ from the log's own evidence, never guessed.
      // - this call is marked dispatched → the body started, outcome unknown;
      // - the log carries a marker SOMEWHERE → this call's absence is evidence:
      //   "aborted before dispatch";
      // - no marker ANYWHERE → the log proves nothing about any call, so the
      //   conservative unknown (a benign verdict here licenses a re-run).
      output: call.dispatched
        ? TOOL_OUTCOME_UNKNOWN_RESULT
        : boundaryProven
          ? TOOL_ABORTED_RECOVERY_RESULT
          : TOOL_OUTCOME_UNKNOWN_UNMARKED_LOG_RESULT,
    }) as SessionEvent))
  }

  // 2. Closing markers only for an open last turn: the step region is open when
  //    markers are unbalanced, or the turn carries step content but lost its
  //    markers with the torn write (implicit step).
  if (!turnClosed) {
    const stepOpen = stepsStarted > stepsEnded || (stepsStarted === 0 && stepContent)
    if (stepOpen) out.push({ type: "step/end" } as SessionEvent)
    out.push({ type: "turn/end" } as SessionEvent)
  }

  return out
}
