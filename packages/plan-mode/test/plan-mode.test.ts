import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, derivePlanMode } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { enterPlanMode, exitPlanMode, createPlanModeTools, ensurePlanModeTool, PLAN_MODE_SYSTEM_PROMPT } from "../src/index.ts"

describe("plan mode", () => {
  it("enterPlanMode appends the mode marker AND the proposal as a user message", () => {
    const s = createSession()
    enterPlanMode(s, "1. design 2. implement")
    expect(derivePlanMode(s).active).toBe(true)
    expect(derivePlanMode(s).proposal).toBe("1. design 2. implement")
    expect(s.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)).toEqual([
      "1. design 2. implement",
    ])
  })

  it("exitPlanMode appends off only when active; idempotent off", () => {
    const s = createSession()
    enterPlanMode(s, "plan")
    expect(exitPlanMode(s)).toBe(true)
    expect(derivePlanMode(s).active).toBe(false)
    expect(exitPlanMode(s)).toBe(false)
    expect(s.events.filter((e) => e.type === "plan/mode")).toHaveLength(2)
  })

  it("exit_plan_mode tool is read-only and exits when active", async () => {
    const s = createSession()
    enterPlanMode(s, "plan")
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    for (const tool of createPlanModeTools(s)) registry.register(tool)
    ensurePlanModeTool(registry, s) // idempotent second registration path? duplicate-register throws — use get guard
    const tool = registry.get("exit_plan_mode")!
    expect(tool.isReadOnly).toBe(true)
    expect(await tool.execute({}, {})).toEqual({ active: true })
    expect(derivePlanMode(s).active).toBe(false)
    expect(await tool.execute({}, {})).toEqual({ active: false })
  })

  // M1 Phase B Task 4 adds two cases, and they establish different things.
  //
  // (1) This one is the unit-level guard for the un-export itself: RED at the commit
  // before it (the keyword was there -- measured by putting it back) and GREEN after.
  // It asserts a surface, not a behaviour -- but the entry surface is exactly what the
  // change alters, and it makes a plain `pnpm test` catch an accidental re-export
  // without waiting for the audit instrument.
  it("the entry surface offers no withdraw half: the seam stays unwired", async () => {
    const mod = await import("../src/index.ts")
    expect(Object.keys(mod)).not.toContain("withdrawPlanModeTool")
  })

  // (2) What this next one pins: `ensurePlanModeTool` registers by name and is
  // idempotent (delete its `get()` guard and the second call throws on the duplicate
  // register), and the OFF transition a session alone can drive -- `exitPlanMode(s)` --
  // leaves the registry's catalog unchanged. That is the ruling which makes the
  // withdraw half's un-export correct rather than a loss.
  // What it does NOT establish: anything about `withdrawPlanModeTool`. After the
  // un-export it is not exported, so this file cannot name-import it, let alone call
  // it; its body is a one-line delegation to core-tools' `unregister`, covered at that
  // source. Nor does it cover a wiring inside the session assembly, which owns its own
  // registry (`packages/session-executor/src/assembly.ts`) -- a "wire the withdraw
  // half" edit there would not go red here. This case passes before and after the
  // un-export: it is not the guard for that change and must not be reported as one.
  it("exit_plan_mode: ensure is idempotent, and plan-mode OFF does not withdraw it", () => {
    const s = createSession()
    const registry = createToolRegistry(createContext())
    ensurePlanModeTool(registry, s)
    ensurePlanModeTool(registry, s) // idempotent: the duplicate-register path is guarded by a get()
    expect(registry.get("exit_plan_mode")).toBeDefined()

    enterPlanMode(s, "plan")
    expect(exitPlanMode(s)).toBe(true)
    expect(derivePlanMode(s).active).toBe(false)
    expect(registry.get("exit_plan_mode")).toBeDefined() // OFF is a log event, not a registry mutation
  })

  it("the bundled prompt fragment is non-empty text", () => {
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain("plan")
  })
})
