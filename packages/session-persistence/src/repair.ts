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
import type { SessionEvent } from "@i-harness/core-session"

/** M10a vocabulary (single source of truth: `@i-harness/core-agent`'s
 * TOOL_ABORTED_BEFORE_DISPATCH synthetic result — imported as a literal here
 * because session-persistence must never depend on core-agent (dependency
 * direction: core-agent consumes session-persistence). */
export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"

/** The synthetic tool/result payload, byte-identical in shape to the live
 * abort path (core-agent/src/execute-tool-calls.ts). */
export const TOOL_ABORTED_RECOVERY_RESULT = {
  error: "tool call aborted before dispatch",
  code: TOOL_ABORTED_BEFORE_DISPATCH,
} as const

interface PendingCall {
  callId: string
  name: string
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
 *   receives a synthetic aborted result (M10a TOOL_ABORTED_BEFORE_DISPATCH
 *   vocabulary), in call order.
 * - If the last turn never ended: a closing `step/end` is appended when the
 *   turn's step region is open (or the turn carries step content without any
 *   step marker — torn writes lose markers), then the `turn/end`.
 * - An already-closed end (turn/end present) is returned with NO additions.
 *
 * @param events the events as loaded (after backend repair + version gate)
 * @returns a NEW array (input untouched); the original log is never modified.
 */
export function repairTurnTail(events: SessionEvent[]): SessionEvent[] {
  if (events.length === 0) return []

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
        pending.push({ callId: typeof callId === "string" ? callId : "unknown", name: typeof name === "string" ? name : "" })
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
      output: TOOL_ABORTED_RECOVERY_RESULT,
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
