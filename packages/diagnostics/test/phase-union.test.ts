// packages/diagnostics/test/phase-union.test.ts — the union's exactness pin (M79).
//
// WHY A TYPE-LEVEL ASSERTION: the phase union is CLOSED and its contract is
// "enumerated from the MEASURED seams rather than invented". A runtime case can
// only observe members some caller exercises; it cannot observe an EXTRA one.
// The two `Exclude`s below are the shape that reddens on a member that has no
// producer — and they redden at `pnpm typecheck`, which is the gate the union's
// own doc comment already names ("adding a member is a decision").
//
// THE PAIR IS THE SURFACE MEASURED 2026-09-24 (M79): each of these eight has a
// producer on that date, and no other member did. The one direction that this
// file alone cannot see is the INLINED copy in core-session (its drift check is
// one-way by design, because that package stays dependency-free), so a sync
// there is a disciplined edit rather than a compile error — see that file's
// comment for the same list.
//
// A member with no producer is an over-declaration: the declaration then knows
// more than the code does. That is what the dated note in record.ts records; to
// add a member back, name the seam it comes from in the commit that adds it.
import { expect, it } from "vitest"
import type { DiagnosticPhase } from "../src/index.ts"

it("DiagnosticPhase is exactly the eight measured phases — no extra, none missing", () => {
  type MeasuredPhases = "cli" | "config" | "run" | "turn" | "sdk" | "session" | "mount" | "shutdown"
  // both directions: a member added on either side is a compile error here.
  type NoExtra = Exclude<DiagnosticPhase, MeasuredPhases>
  type NoMissing = Exclude<MeasuredPhases, DiagnosticPhase>
  const exactA: NoExtra extends never ? true : false = true
  const exactB: NoMissing extends never ? true : false = true
  expect(exactA && exactB).toBe(true)
})
