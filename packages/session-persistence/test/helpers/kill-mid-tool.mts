/**
 * M4's acceptance child — a REAL process that is killed while a tool call is in
 * flight.
 *
 * The roadmap's completion definition for M4 is deliberately not a unit test:
 * "在工具呼叫中途殺掉行程，斷言續行的 session 到達一個已記錄且正確的裁決 ——
 * **不是靠讀程式碼**". So this is a process, not a function: it writes a turn whose
 * tool has genuinely STARTED, prints a marker, and then blocks forever. The parent
 * SIGKILLs it at the marker and recovers from the log.
 *
 * argv: <dir> <sessionId> <"dispatched" | "not-dispatched" | "earlier-turn-marker">
 *
 *   dispatched      — turn/start, tool/call, tool/dispatch, then block.
 *                     The log says the body STARTED; the outcome is unknown.
 *   not-dispatched  — turn/start, tool/call, then block.
 *                     The log says only that the model ASKED — and, because the
 *                     log carries no marker ANYWHERE, that absence proves
 *                     nothing either way (Q8): outcome unknown, conservatively.
 *   earlier-turn-marker
 *                   — a CLOSED earlier turn that dispatched and completed a
 *                     call, then turn/start, tool/call, then block. The earlier
 *                     turn's marker is what makes the marker-less tail call
 *                     honestly "aborted before dispatch" (Q8's whole-log read).
 *                     This is the mode that still DISCRIMINATES: it and
 *                     `not-dispatched` differ only by a marker in ANOTHER turn.
 *
 * All are killed identically. The verdicts must differ — and after Q8 the pair
 * that differs is `earlier-turn-marker` vs `not-dispatched` (`dispatched` and
 * `not-dispatched` now both answer unknown; that contrast is gone by decision,
 * see the acceptance test).
 *
 * The flush before the marker is load-bearing: the write-behind batches on a
 * 200 ms deadline, so a kill that beat the deadline would lose the events and the
 * test would be measuring the LOSS CONTRACT rather than the dispatch boundary.
 */

import { mkdirSync } from "node:fs"
import { createSessionCoordinator } from "../../src/index.ts"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { SessionEvent } from "@i-harness/core-session"

const [dir, sessionId, mode] = process.argv.slice(2)
if (dir === undefined || sessionId === undefined || mode === undefined) {
  console.error("usage: kill-mid-tool.mts <dir> <sessionId> <dispatched|not-dispatched|earlier-turn-marker>")
  process.exit(2)
}

mkdirSync(dir, { recursive: true })
const coordinator = createSessionCoordinator(createJsonlBackend(dir))
await coordinator.create({ sessionId })

const events: SessionEvent[] = mode === "earlier-turn-marker"
  ? [
    // A CLOSED earlier turn whose call was dispatched AND completed: its
    // `tool/dispatch` is the whole-log evidence the tail is read against.
    { type: "turn/start" },
    { type: "step/start" },
    { type: "tool/call", callId: "c0", name: "read", args: { path: "a.ts" } },
    // eventSeq = the call's own position (the batch writes no `seq` fields; the
    // loader canonicalizes by index) — 2, not 1: this call is the third event.
    { type: "tool/dispatch", callId: "c0", eventSeq: 2 },
    { type: "tool/result", callId: "c0", name: "read", output: { ok: true } },
    { type: "step/end" },
    { type: "turn/end" },
    // The LAST turn: the model asked, no marker, then the kill.
    { type: "turn/start" },
    { type: "tool/call", callId: "c1", name: "bash", args: { cmd: "rm -rf build" } },
  ]
  : [
    { type: "turn/start" },
    { type: "tool/call", callId: "c1", name: "bash", args: { cmd: "rm -rf build" } },
    ...(mode === "dispatched"
      ? [{ type: "tool/dispatch", callId: "c1", eventSeq: 1 } satisfies SessionEvent]
      : []),
  ]
await coordinator.append(sessionId, events)
// Durability BEFORE the marker: otherwise the kill races the 200 ms window and
// the test measures loss, not the boundary.
await coordinator.flush(sessionId)

// The body is now "running": from here the process never returns, and the parent
// kills it. Nothing further is written by design — that is the crash.
console.log("IN_TOOL")
setInterval(() => { /* the tool body would be here */ }, 1_000)
