import type { SessionEvent } from "@i-harness/core-session"

// F01-7: refusal before structural decode — "upgrade the harness", never a
// silent corruption.
export class SessionFormatUnsupportedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "SessionFormatUnsupportedError"
  }
}

// F01-1: stepwise upgrade chain — v(N) → v(N+1). Today only v1 exists, so the
// chain is empty; the first format bump only needs registerUpgrade(1, fn).
export const upgrades = new Map<number, (events: SessionEvent[]) => SessionEvent[]>()
upgrades.set(1, events => events)
upgrades.set(2, events => events)
upgrades.set(3, events => events)
export function registerUpgrade(from: number, fn: (events: SessionEvent[]) => SessionEvent[]): void {
  upgrades.set(from, fn)
}

const KNOWN_EVENT_TYPES = new Set([
  "turn/start", "step/start", "step/failed", "user/message", "assistant/chunk", "assistant/message",
  "tool/call", "tool/result", "step/end", "turn/end", "subagent/inbox",
  "compaction/start", "compaction/end", "compaction/summary",
  "code/cell", "code/output", "code/call", "code/dispatch", "code/result", "code/store",
  "context/result-ref",
])

// M19: extensible event-type registry (fixes the M16 closed-set gap). The
// builtin set above stays for backward compat; the load gate consults
// builtin ∪ extra, so new event types (e.g. team/*) can cross the
// guardIgnorable gate even when only this package is loaded.
const extraEventTypes = new Set<string>()
export function registerEventType(type: string): void {
  extraEventTypes.add(type)
}

export const isKnownEventType = (type: string): boolean =>
  KNOWN_EVENT_TYPES.has(type) || extraEventTypes.has(type)

// M19: register the 4 team/* session event types at module init so a plain
// session-persistence load accepts them standalone (no agent-team import —
// core-session would be the cycle, and this package must not depend on
// agent-team either).
registerEventType("team/member")
registerEventType("team/task")
registerEventType("team/message/queued")
registerEventType("team/message/delivered")
// M20: compaction pure-reset marker (compaction.resetWindow) — same reasoning:
// core-session must stay dependency-free, session-persistence owns the load
// gate, so the new type registers here (M19 pattern).
registerEventType("compaction/reset")
// M33: model-free prune marker (compaction.prune) — same load-gate reasoning.
registerEventType("compaction/prune")
// M21: todo tool list-write events (todo/write) — same
// reasoning as above: only this package loads on a plain persistence-only path,
// so without registration guardIgnorable would refuse the type at load.
registerEventType("todo/write")
// E-region (M26): goal/jobs/schedule — same load-gate reasoning.
registerEventType("goal/change")   // goal/change whole-snapshot events (packages/goal)
registerEventType("job/status")    // subagent job lifecycle events (packages/jobs)
registerEventType("schedule/change") // durable schedule mutation events (packages/schedule)
// R-A1 input tiers (agent/input/admitted|promoted|cancelled) — same
// reasoning as above: only this package loads on a plain persistence-only
// path, so without registration guardIgnorable would refuse the types.
registerEventType("agent/input/admitted")
registerEventType("agent/input/promoted")
registerEventType("agent/input/cancelled")
// R-A6: session title snapshot event (log-only).
registerEventType("session/title")
// R-A7: plan-mode marker (log-only).
registerEventType("plan/mode")
// M26 (R-D1): subagent task protocol log events — M19 team/* pattern: only
// this package loads on a plain persistence-only path, so without registration
// guardIgnorable would refuse the type at load.
registerEventType("subagent/start")
registerEventType("subagent/end")
// C-region (port): the three event types the C service surface streams/persists.
registerEventType("reasoning")
registerEventType("command/run")
registerEventType("command/done")
// M42: the rewind engine's durable conversation marker (core-session union
// member, `packages/core-session/src/index.ts:128`). M53 G1: without this the
// load gate refuses every session that has had a rewind applied — TUI resume,
// CLI headless --resume, --attach (session/history) and fork all fail with
// SessionFormatUnsupportedError. NOT `ignorable: true`: load() drops ignorable
// events, which would silently resurrect the rewound turns (probe D2).
registerEventType("rewind/point")
// M1 Phase B (Task 1): the sandbox mode marker (core-session union member,
// `packages/core-session/src/index.ts:43`). SAME load-gate defect class as
// `rewind/point` directly above, and it stayed latent only because the event
// had ZERO production producers: `createSessionAssembly` now appends it at
// construction whenever the host passes a `sandbox` option, so without this
// registration the first producer makes every sandboxed session unloadable —
// web-host `GET /api/sessions/:id/events` answers 500 and CLI `--resume`, TUI
// resume, `--attach` and fork all fail with SessionFormatUnsupportedError.
// NOT `ignorable: true`: core-session's own test asserts this event is "durable
// and replayable" across the JSONL round-trip (`packages/core-session/test/
// session.test.ts:483`), and load() DROPS ignorable events — which would erase
// the record of the mode a session actually ran under. It is registered, not
// dropped, so `effectiveSandboxMode` still sees the history it was built for.
registerEventType("sandbox/mode")

// M4: the dispatch boundary (see the type's own note in @i-harness/core-session).
// Registered so it crosses the guardIgnorable load gate on its own — a log that
// carries a dispatch marker must still load when only this package is present.
registerEventType("tool/dispatch")
// M3 §3.4: the CLI run path's durable run-end record. NOT `ignorable: true`:
// load() DROPS ignorable events, which would erase the very record this event
// exists to keep — the same defect class as `rewind/point` above and
// `sandbox/mode` before it.
registerEventType("operator/run-end")
// v0.1.11: the model-retry transition marker (core-session union member,
// `packages/core-session/src/index.ts:35`; producer `packages/core-agent/src/
// index.ts:588`). FOURTH instance of the same load-gate defect class as
// `rewind/point`, `sandbox/mode` and `operator/run-end` above — and unlike
// `sandbox/mode`, this one never had the excuse of a missing producer: the
// producer shipped WITH the type, because v0.1.11's bounded-wait work is what
// made retries reachable (`docs/releases/v0.1.11.md`: the first-response and
// progress deadlines reuse the existing automatic model retry).
//
// `model/retry` is DURABLE (`append`, not `publishTransient`), so it lands in
// the session log — its sibling `model/activity` is deliberately transient and
// core-session:413 throws if anyone tries to append it durably, so the two must
// NOT be treated symmetrically: only `model/retry` needs registration.
//
// MEASURED CONSEQUENCE BEFORE THIS REGISTRATION: any session whose log carried
// a retry became unloadable with
//   SessionFormatUnsupportedError: unknown event type 'model/retry' without ignorable marker
// which is exactly what the child/subagent path reported as
// "unknown event type 'model/retry' without ignorable marker" — a retry inside a
// child session made that child's log unloadable, so delegation failed outright.
// `--resume`, fork, restart and every `session/history` read over a session that
// had retried failed the same way. Reproduced deterministically in
// `test/model-retry-event.test.ts`.
//
// NOT `ignorable: true`: load() DROPS ignorable events, which would erase the
// record of the retry a session actually went through. Registering keeps it.
registerEventType("model/retry")
registerEventType("context/budget")
registerEventType("context/usage")
registerEventType("context/recovery")
registerEventType("conversation/semantics")
registerEventType("model/exchange-accepted")
