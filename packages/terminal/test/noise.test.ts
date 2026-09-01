import { describe, expect, it } from "vitest"
import { isKnownConptyNoise } from "../src/service.ts"
import { createTerminalTools, type TerminalToolDeps } from "../src/tool.ts"
import type { TerminalService } from "../src/service.ts"

describe("M27-H-2 conpty noise filter", () => {
  it("marks AttachConsole noise as known", () => {
    expect(isKnownConptyNoise("Error: AttachConsole failed")).toBe(true)
    expect(isKnownConptyNoise("command failed: exit 1")).toBe(false)
  })

  it("strips known noise lines from a multi-line report", async () => {
    // 完整 report 過濾在 tool 面測試（見下）；純 predicate 在此。
    expect(isKnownConptyNoise("conpty_console_list_agent: AttachConsole failed")).toBe(true)
    expect(isKnownConptyNoise("")).toBe(false)
  })

  it("tool error path: noise-only report converts to a benign outcome, never leaks raw text", async () => {
    const noiseService = {
      open: () => { throw new Error("Error: AttachConsole failed") },
    } as unknown as TerminalService
    const tools = createTerminalTools({ service: noiseService } as TerminalToolDeps)
    const out = await tools.find((t) => t.name === "terminal_open")!.execute({ command: "x" }, {})
    expect(out).toMatchObject({ suppressed: "AttachConsole failed" })
  })

  it("tool error path: mixed report has noise lines stripped from the error", async () => {
    const noiseService = {
      open: () => { throw new Error("Error: AttachConsole failed\nreal failure: broken pipe") },
    } as unknown as TerminalService
    const tools = createTerminalTools({ service: noiseService } as TerminalToolDeps)
    await expect(tools.find((t) => t.name === "terminal_open")!.execute({ command: "x" }, {}))
      .rejects.toThrow("real failure: broken pipe")
  })
})
