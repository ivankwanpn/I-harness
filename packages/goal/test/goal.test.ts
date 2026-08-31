import { describe, expect, it } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import {
  applyGoalMutation,
  foldGoal,
  GoalStateError,
  type GoalView,
} from "../src/index.ts"

// ── Projection fold + CAS mutation domain (pure, no HTTP) ─────────────────━━
// DSH parity simplified: whole-snapshot `goal/change` events folded
// last-wins; a clear tombstone sets the projection to null; malformed events
// keep the previous projection (projection-grade, DSH applyGoalProjection).

/** One create event for goal-1 (single fixture used by the fold tests). */
function createEvent(goalOverrides: object = {}): SessionEvent {
  return {
    type: "goal/change",
    version: 1,
    operation: "create",
    goal: { id: "goal-1", revision: 1, objective: "write the report", phase: "active", maxGoalRounds: 5, ...goalOverrides },
    updatedAt: 10,
  } as unknown as SessionEvent
}

describe("goal fold (task 4.2)", () => {
  it("folds null on an empty log", () => {
    expect(foldGoal([])).toBeNull()
  })

  it("folds a create into the projection (round stays a never-populated seam)", () => {
    const view = foldGoal([createEvent()])
    expect(view).not.toBeNull()
    expect(view).toMatchObject({
      id: "goal-1", revision: 1, phase: "active", objective: "write the report", maxGoalRounds: 5, updatedAt: 10,
    })
    expect((view as GoalView).round).toBeUndefined()
  })

  it("last-wins: the latest event is the projection, whatever the phase", () => {
    const events: SessionEvent[] = [
      createEvent(),
      {
        type: "goal/change", version: 1, operation: "pause",
        goal: { id: "goal-1", revision: 2, objective: "write the report", phase: "paused", maxGoalRounds: 5 },
        updatedAt: 20,
      },
      {
        type: "goal/change", version: 1, operation: "complete",
        goal: { id: "goal-1", revision: 3, objective: "write the report", phase: "complete", maxGoalRounds: 5 },
        updatedAt: 30,
      },
    ]
    const view = foldGoal(events)
    expect(view).toMatchObject({ revision: 3, phase: "complete", updatedAt: 30 })
  })

  it("a clear tombstone sets the projection to null", () => {
    const events: SessionEvent[] = [
      createEvent(),
      { type: "goal/change", version: 1, operation: "clear", cleared: { id: "goal-1", revision: 2 } },
    ]
    expect(foldGoal(events)).toBeNull()
  })

  it("ignores non-goal events and malformed goal/change rows (projection-grade)", () => {
    const view = foldGoal([
      { type: "user/message", text: "hi" },
      createEvent(),
      // Malformed: snapshot op without a goal → keep previous.
      { type: "goal/change", version: 1, operation: "pause" } as unknown as SessionEvent,
      // Malformed: clear without a tombstone ref → keep previous.
      { type: "goal/change", version: 1, operation: "clear" } as unknown as SessionEvent,
    ])
    expect(view).toMatchObject({ id: "goal-1", phase: "active" })
  })

  it("a clear followed by a create starts a new goal", () => {
    const events: SessionEvent[] = [
      createEvent(),
      { type: "goal/change", version: 1, operation: "clear", cleared: { id: "goal-1", revision: 2 } },
      {
        type: "goal/change", version: 1, operation: "create",
        goal: { id: "goal-2", revision: 1, objective: "new", phase: "active" },
        updatedAt: 40,
      },
    ]
    expect(foldGoal(events)).toMatchObject({ id: "goal-2", revision: 1, objective: "new" })
  })
})

describe("goal mutations (task 4.2)", () => {
  it("create: objective required, trimmed; active revision 1", () => {
    const { event, next } = applyGoalMutation(null, "create", { objective: "  build it  " }, 1)
    expect(event.type).toBe("goal/change")
    expect(next).toMatchObject({ phase: "active", revision: 1, objective: "build it", updatedAt: 1 })
    expect(next!.id).toMatch(/^goal-/)
  })

  it("create: rejects a blank objective (code goal-invalid)", () => {
    expect(() => applyGoalMutation(null, "create", {}, 1)).toThrowError(/objective/)
    for (const objective of ["", "   "]) {
      try {
        applyGoalMutation(null, "create", { objective }, 1)
        expect.unreachable()
      } catch (error) {
        expect((error as GoalStateError).code).toBe("goal-invalid")
      }
    }
  })

  it("create: rejects an invalid maxGoalRounds", () => {
    for (const v of [0, -1, 1.5, Number.NaN]) {
      expect(() => applyGoalMutation(null, "create", { objective: "x", maxGoalRounds: v }, 1))
        .toThrowError(/maxGoalRounds/)
    }
  })

  it("create: an existing non-complete goal is a 409-style goal-exists; a complete goal may be replaced", () => {
    const active = applyGoalMutation(null, "create", { objective: "first" }, 1).next!
    expect(() => applyGoalMutation(active, "create", { objective: "second" }, 2))
      .toThrowError(/already exists/)
    const complete = applyGoalMutation(active, "complete", { ref: { id: active.id, revision: active.revision } }, 2).next!
    const replaced = applyGoalMutation(complete, "create", { objective: "second" }, 3).next!
    expect(replaced).toMatchObject({ revision: 1, objective: "second", id: expect.stringMatching(/^goal-/) })
    expect(replaced).not.toEqual({ id: active.id })
  })

  it("edit: requires a matching ref, never changes phase, only changed fields", () => {
    const active = applyGoalMutation(null, "create", { objective: "t", maxGoalRounds: 5 }, 1).next!
    const ref = { id: active.id, revision: active.revision }
    const result = applyGoalMutation(active, "edit", { ref, objective: "t2" }, 2)
    expect(result.next).toMatchObject({ id: active.id, revision: 2, phase: "active", objective: "t2", maxGoalRounds: 5 })
    // edit with neither field → goal-invalid
    expect(() => applyGoalMutation(active, "edit", { ref }, 2)).toThrowError(/objective and\/or maxGoalRounds/)
    // stale ref → goal-stale-ref
    expect(() => applyGoalMutation(active, "edit", { ref: { id: active.id, revision: 99 }, objective: "x" }, 2))
      .toThrowError(/stale goal ref/)
  })

  it("pause/resume/complete enforce the phase machine; clear resets to null", () => {
    const active = applyGoalMutation(null, "create", { objective: "t" }, 1).next!
    const ref = (v: GoalView) => ({ id: v.id, revision: v.revision })
    const paused = applyGoalMutation(active, "pause", { ref: ref(active) }, 2).next!
    expect(paused.phase).toBe("paused")
    // pause a paused goal → invalid transition
    expect(() => applyGoalMutation(paused, "pause", { ref: ref(paused) }, 3)).toThrowError(/cannot pause/)
    const resumed = applyGoalMutation(paused, "resume", { ref: ref(paused) }, 3).next!
    expect(resumed.phase).toBe("active")
    const completed = applyGoalMutation(resumed, "complete", { ref: ref(resumed) }, 4).next!
    expect(completed.phase).toBe("complete")
    // resume/complete a complete goal → invalid transition
    expect(() => applyGoalMutation(completed, "resume", { ref: ref(completed) }, 5)).toThrowError(/cannot resume/)
    expect(() => applyGoalMutation(completed, "complete", { ref: ref(completed) }, 5)).toThrowError(/cannot complete/)
    const cleared = applyGoalMutation(completed, "clear", { ref: ref(completed) }, 6)
    expect(cleared.next).toBeNull()
    // tombstone revision is one past the cleared snapshot
    expect((cleared.event as { cleared: { id: string; revision: number } }).cleared).toEqual({
      id: completed.id, revision: completed.revision + 1,
    })
  })

  it("action verbs without a current goal answer goal-none; without a ref goal-stale-ref", () => {
    expect(() => applyGoalMutation(null, "pause", {}, 1)).toThrowError(/no current goal/)
    const active = applyGoalMutation(null, "create", { objective: "t" }, 1).next!
    expect(() => applyGoalMutation(active, "pause", {}, 2)).toThrowError(/stale goal ref/)
  })
})
