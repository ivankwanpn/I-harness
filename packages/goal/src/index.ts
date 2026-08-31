/**
 * Task 4.2 goal domain: per-session goal projection + CAS mutations, folded
 * from `goal/change` session events (core-session, DSH goal parity simplified).
 *
 * DSH alignment: dsh-goal's single `goal/change` event type with a
 * whole-snapshot payload (`goal` + counters/timestamps, last-wins fold) and a
 * `clear` tombstone (`cleared` ref, projection → null) is mirrored exactly in
 * form; we simplify the DOMAIN: no `blocked` phase / blockedReason, no
 * mandatory maxGoalRounds (no deployment default), no round admission
 * (DSH's roundsStarted — explicitly out of scope; the `round` view field is a
 * documented seam, never populated in v0).
 *
 * The host owns mutation semantics: every mutation validates the CAS ref,
 * validates the transition, appends the durable event (the DSH way — the
 * event IS the change; there is no separate state store), then returns the
 * freshly projected view.
 */

import { randomUUID } from "node:crypto"
import type {
  GoalOperation,
  GoalPhase,
  GoalRef,
  GoalSnapshot,
  SessionEvent,
} from "@i-harness/core-session"

/** Projected view of the current goal — GET /api/sessions/:id/goal response. */
export interface GoalView {
  id: string
  revision: number
  phase: GoalPhase
  objective: string
  maxGoalRounds?: number
  /**
   * DSH `roundsStarted` seam: highest admitted goal round. Round admission is
   * NOT implemented in v0 (no goal enforcement, no turn-count logic —
   * controller pre-ruling), so this field is never populated. It stays in the
   * wire vocabulary so the UI/host contract does not break when round
   * tracking lands (the fold would start counting goal-source user/messages
   * exactly like dsh-goal's fold).
   */
  round?: number
  /** Epoch ms of the latest goal mutation (host-stamped at append time). */
  updatedAt?: number
}

export type GoalStateErrorCode =
  | "goal-invalid"
  | "goal-exists"
  | "goal-none"
  | "goal-stale-ref"
  | "goal-invalid-transition"

/** Typed goal state failure (status mapping is the host route's job). */
export class GoalStateError extends Error {
  readonly code: GoalStateErrorCode
  constructor(code: GoalStateErrorCode, message: string) {
    super(message)
    this.name = "GoalStateError"
    this.code = code
  }
}

/** Mutation request body surface (fields validated per operation). */
export interface GoalMutationRequest {
  ref?: GoalRef
  objective?: string
  maxGoalRounds?: number
}

/** Result of one settled mutation: the durable event to append + the next view. */
export interface GoalMutationResult {
  event: SessionEvent
  next: GoalView | null
}

const SNAPSHOT_OPERATIONS: ReadonlySet<Exclude<GoalOperation, "clear">> = new Set([
  "create",
  "edit",
  "pause",
  "resume",
  "complete",
])

function resolveObjective(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GoalStateError("goal-invalid", "goal objective must be a non-blank string")
  }
  return value.trim()
}

function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalStateError("goal-invalid", "maxGoalRounds must be a positive safe integer")
  }
  return value
}

/**
 * Project one `goal/change` event onto a view. Returns the next view (null for
 * a clear tombstone), or `undefined` for a non-goal or MALFORMED event —
 * projection-grade, DSH's applyGoalProjection posture: a bad event returns
 * the same reference so a corrupted persisted log cannot crash the fold (the
 * write side validated it; the invariant is enforced by append-side tests,
 * not by the projection).
 */
function viewFromEvent(ev: SessionEvent): GoalView | null | undefined {
  if (ev.type !== "goal/change") return undefined
  const { goal, cleared, updatedAt } = ev
  if (ev.operation === "clear") {
    // Tombstone validity: a clear must carry the exact ref of the cleared
    // goal; malformed tombstones are ignored (keep the previous view).
    if (cleared?.id !== undefined && typeof cleared.id === "string" && cleared.id !== ""
      && Number.isSafeInteger(cleared.revision) && cleared.revision >= 1) return null
    return undefined
  }
  if (!SNAPSHOT_OPERATIONS.has(ev.operation) || goal === undefined) return undefined
  if (typeof goal.id !== "string" || goal.id === "") return undefined
  if (!Number.isSafeInteger(goal.revision) || goal.revision < 1) return undefined
  if (typeof goal.objective !== "string" || goal.objective.trim() === "") return undefined
  if (goal.phase !== "active" && goal.phase !== "paused" && goal.phase !== "complete") return undefined
  if (goal.maxGoalRounds !== undefined
    && (!Number.isSafeInteger(goal.maxGoalRounds) || goal.maxGoalRounds < 1)) return undefined
  return {
    id: goal.id,
    revision: goal.revision,
    phase: goal.phase,
    objective: goal.objective,
    ...(goal.maxGoalRounds !== undefined ? { maxGoalRounds: goal.maxGoalRounds } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

/**
 * Fold the current goal projection from a session's events, in sequence order.
 * Last-wins: every non-clear goal/change carries the complete post-change
 * state; a clear sets the projection to null. Non-goal and malformed events
 * leave the projection unchanged (same-reference rule).
 */
export function foldGoal(events: readonly SessionEvent[]): GoalView | null {
  let view: GoalView | null = null
  for (const ev of events) {
    const next = viewFromEvent(ev)
    if (next === undefined) continue
    view = next
  }
  return view
}

/** Require a current goal and a matching CAS ref; throws the typed conflicts. */
function requireCurrent(current: GoalView | null, request: GoalMutationRequest): GoalView {
  if (current === null) {
    throw new GoalStateError("goal-none", "no current goal")
  }
  const ref = request.ref
  if (ref === undefined || ref.id !== current.id || ref.revision !== current.revision) {
    throw new GoalStateError(
      "goal-stale-ref",
      `stale goal ref "${String(ref?.id)}" revision ${String(ref?.revision)}; current is "${current.id}" revision ${current.revision}`,
    )
  }
  return current
}

function buildSnapshot(operation: Exclude<GoalOperation, "clear">, snapshot: GoalSnapshot, now: number): GoalMutationResult {
  return {
    event: { type: "goal/change", version: 1, operation, goal: snapshot, updatedAt: now },
    next: {
      id: snapshot.id,
      revision: snapshot.revision,
      phase: snapshot.phase,
      objective: snapshot.objective,
      ...(snapshot.maxGoalRounds !== undefined ? { maxGoalRounds: snapshot.maxGoalRounds } : {}),
      updatedAt: now,
    },
  }
}

/**
 * Apply one mutation to the current projection. Pure: returns the durable
 * event to append (the caller owns the log) and the next view; never mutates
 * input. Throws GoalStateError for every invalid request (CAS conflict,
 * invalid fields, invalid transition) — the route maps code → HTTP status.
 */
export function applyGoalMutation(
  current: GoalView | null,
  operation: GoalOperation,
  request: GoalMutationRequest,
  now: number,
): GoalMutationResult {
  const objective = request.objective !== undefined ? resolveObjective(request.objective) : undefined
  const maxGoalRounds = request.maxGoalRounds !== undefined ? resolveMaxGoalRounds(request.maxGoalRounds) : undefined

  switch (operation) {
    case "create": {
      if (objective === undefined) {
        // Field validation precedes the state check (DSH's resolveCreateGoal
        // runs before the already-exists rejection — the request is malformed
        // regardless of the current state).
        throw new GoalStateError("goal-invalid", "goal create requires an objective")
      }
      if (current !== null && current.phase !== "complete") {
        // DSH parity: a completed goal may be replaced; every other phase
        // must be cleared/resumed instead.
        throw new GoalStateError("goal-exists", `goal "${current.id}" already exists with phase "${current.phase}"`)
      }
      const snapshot: GoalSnapshot = {
        id: `goal-${randomUUID()}`,
        revision: 1,
        objective,
        phase: "active",
        ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
      }
      return buildSnapshot(operation, snapshot, now)
    }
    case "edit": {
      // Edit never changes phase (DSH parity); at least one field required.
      if (objective === undefined && maxGoalRounds === undefined) {
        throw new GoalStateError("goal-invalid", "goal edit requires objective and/or maxGoalRounds")
      }
      const currentGoal = requireCurrent(current, request)
      const snapshot: GoalSnapshot = {
        id: currentGoal.id,
        revision: currentGoal.revision + 1,
        objective: objective ?? currentGoal.objective,
        phase: currentGoal.phase,
        ...(maxGoalRounds ?? currentGoal.maxGoalRounds) !== undefined
          ? { maxGoalRounds: (maxGoalRounds ?? currentGoal.maxGoalRounds)! }
          : {},
      }
      return buildSnapshot(operation, snapshot, now)
    }
    case "pause": {
      const currentGoal = requireCurrent(current, request)
      if (currentGoal.phase !== "active") {
        throw new GoalStateError("goal-invalid-transition", `cannot pause goal from phase "${currentGoal.phase}"`)
      }
      return buildSnapshot(operation, { ...currentGoal, revision: currentGoal.revision + 1, phase: "paused" }, now)
    }
    case "resume": {
      const currentGoal = requireCurrent(current, request)
      if (currentGoal.phase !== "paused") {
        throw new GoalStateError("goal-invalid-transition", `cannot resume goal from phase "${currentGoal.phase}"`)
      }
      return buildSnapshot(operation, { ...currentGoal, revision: currentGoal.revision + 1, phase: "active" }, now)
    }
    case "complete": {
      const currentGoal = requireCurrent(current, request)
      if (currentGoal.phase !== "active" && currentGoal.phase !== "paused") {
        throw new GoalStateError("goal-invalid-transition", `cannot complete goal from phase "${currentGoal.phase}"`)
      }
      return buildSnapshot(operation, { ...currentGoal, revision: currentGoal.revision + 1, phase: "complete" }, now)
    }
    case "clear": {
      const currentGoal = requireCurrent(current, request)
      // DSH parity: the tombstone ref's revision is one past the cleared
      // snapshot, so a later stale-ref write against the cleared goal fails.
      const tombstone: GoalRef = { id: currentGoal.id, revision: currentGoal.revision + 1 }
      return {
        event: { type: "goal/change", version: 1, operation: "clear", cleared: tombstone },
        next: null,
      }
    }
  }
}
