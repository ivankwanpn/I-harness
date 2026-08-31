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

  it("the bundled prompt fragment is non-empty text", () => {
    expect(PLAN_MODE_SYSTEM_PROMPT).toContain("plan")
  })
})
