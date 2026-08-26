// TDD: activity — edge-triggered wait with domain-level noProgress + disposal
// release (M19 Task 8).
//
// Ruling 6 (controller, binding): the brief's test called
// waitForChange(20, undefined) against createActivity({ waitMinMs: 10_000 })
// — but waitForChange validates t < waitMinMs and throws TEAM_INVALID_TIMEOUT.
// The test config is fixed to waitMinMs: 10 (20ms is then valid); the impl
// stays strict per spec (timeout must be waitMinMs..waitMaxMs, else throw).
//
// Semantics under test:
//   - edge-triggered: only POST-registration notify() wakes a waiter (no replay
//     of changes that already happened);
//   - timeout resolves { timedOut: true };
//   - close() releases all waiters ({ timedOut: false }) and later waits return
//     immediately;
//   - abort resolves { timedOut: false };
//   - noProgress: hasActivePeer() === false → immediate
//     { timedOut: false, noProgress: { reason: "no-active-peer" } }.
import { describe, expect, it } from "vitest"
import { createActivity } from "../src/index.ts"
import type { TeamCaller } from "../src/index.ts"

const CALLER: TeamCaller = { id: "lead-1", name: "lead", role: "lead" }

// Ruling 6: waitMinMs 10 so the 20ms timeout test is valid.
const CFG = { waitMinMs: 10, waitMaxMs: 3_600_000, waitDefaultMs: 30_000 }

describe("TeamActivity", () => {
  it("edge-triggered: wakes on a post-registration change", async () => {
    const act = createActivity(CFG)
    const p = act.waitForChange(CALLER, 30_000)
    setTimeout(() => act.notify(), 10)
    expect(await p).toEqual({ timedOut: false })
  })

  it("edge-triggered: a change that already happened does not replay", async () => {
    const act = createActivity(CFG)
    act.notify() // before any waiter registers
    expect(await act.waitForChange(CALLER, 20)).toEqual({ timedOut: true })
  })

  it("times out and reports timedOut", async () => {
    const act = createActivity(CFG)
    expect(await act.waitForChange(CALLER, 20)).toEqual({ timedOut: true })
  })

  it("close releases waiters", async () => {
    const act = createActivity(CFG)
    const p = act.waitForChange(CALLER, 30_000)
    act.close()
    expect(await p).toEqual({ timedOut: false })
  })

  it("after close, new waits return immediately", async () => {
    const act = createActivity(CFG)
    act.close()
    expect(await act.waitForChange(CALLER, 30_000)).toEqual({ timedOut: false })
  })

  it("abort resolves { timedOut: false }", async () => {
    const act = createActivity(CFG)
    const ac = new AbortController()
    const p = act.waitForChange(CALLER, 30_000, ac.signal)
    ac.abort()
    expect(await p).toEqual({ timedOut: false })
  })

  // Ruling 16 (binding): a PRE-aborted signal must resolve immediately
  // ({ timedOut: false }) — an aborted signal's addEventListener never fires,
  // so without the pre-check the wait would run a full timeout.
  it("pre-aborted signal resolves immediately { timedOut: false }", async () => {
    const act = createActivity(CFG)
    const ac = new AbortController()
    ac.abort()
    const t0 = Date.now()
    expect(await act.waitForChange(CALLER, 30_000, ac.signal)).toEqual({ timedOut: false })
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it("throws TEAM_INVALID_TIMEOUT below min / above max / non-integer", async () => {
    const act = createActivity(CFG)
    await expect(act.waitForChange(CALLER, 5)).rejects.toThrow(/INVALID_TIMEOUT/)
    await expect(act.waitForChange(CALLER, 3_700_000)).rejects.toThrow(/INVALID_TIMEOUT/)
    await expect(act.waitForChange(CALLER, 10.5)).rejects.toThrow(/INVALID_TIMEOUT/)
  })

  it("noProgress: no active peer → immediate no-active-peer result", async () => {
    const act = createActivity(CFG)
    const r = await act.waitForChange(CALLER, 30_000, undefined, () => false)
    expect(r.timedOut).toBe(false)
    expect(r.noProgress).toEqual({ reason: "no-active-peer", message: expect.stringContaining("No other Team member") })
  })

  it("hasActivePeer true: noProgress path skipped, notify still wakes", async () => {
    const act = createActivity(CFG)
    const p = act.waitForChange(CALLER, 30_000, undefined, () => true)
    setTimeout(() => act.notify(), 10)
    expect(await p).toEqual({ timedOut: false })
  })
})
