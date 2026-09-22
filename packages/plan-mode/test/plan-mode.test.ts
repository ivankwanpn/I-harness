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

  // M1 Phase B Task 4. The withdraw half of this seam was deleted in that task: it was
  // a dead declaration nothing consumed on any production path, and the requirement a
  // re-add would have to satisfy is recorded in that task's commit message and report.
  // What survives as the seam's contract is this case: `ensurePlanModeTool` registers by
  // name and is idempotent, and plan-mode OFF is a session-log event that leaves the
  // tool registered, so `exit_plan_mode` stays in the request catalog while plan mode is
  // inactive. The OFF assertion is the part no sibling case makes; the idempotency half
  // the case above already reaches by a different route (it registers, then ensures).
  // This case passes before and after that deletion: it is not evidence for it and it is
  // not its guard -- the instrument's row count is. It also cannot see a wiring inside
  // the session assembly, which owns its own registry.
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
