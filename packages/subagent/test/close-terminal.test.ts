import { describe, expect, it } from "vitest"
import { createCloseTool } from "../src/tools/cancel.ts"

function depsWithTerminal(path: string) {
  return {
    table: { get: () => undefined, update: () => {}, remove: () => {} },
    tasks: { list: () => [{ agentPath: path, outcome: "error" }] },
    jobs: { kill: () => {} },
    agents: { remove: () => {} },
  } as never
}

describe("close_agent terminal idempotency", () => {
  it("returns inactive for a terminal task path instead of TOOL_FAILED", async () => {
    const tool = createCloseTool(depsWithTerminal("root/a14-bg-retry"))
    await expect(tool.execute({ target: "root/a14-bg-retry" }, {} as never)).resolves.toEqual({ previous_status: "inactive" })
  })

  it("still rejects a path with no live entry and no terminal task", async () => {
    const tool = createCloseTool(depsWithTerminal("root/other"))
    await expect(tool.execute({ target: "root/missing" }, {} as never)).rejects.toThrow(/unknown subagent/)
  })
})
