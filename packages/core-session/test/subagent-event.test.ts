import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessages, deriveSearchText } from "../src/index.ts"

describe("subagent/start | subagent/end log events", () => {
  it("appends with seq and stays model-invisible (deriveMessages skips them)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "spawn now" })
    append(s, { type: "subagent/start", version: 1, taskId: "task-1", agentPath: "root/helper", role: "general", description: "helper", parentSessionId: "s-main" })
    append(s, { type: "subagent/end", version: 1, taskId: "task-1", outcome: "completed", resultText: "done" })
    expect(s.events.map((e) => e.seq)).toEqual([0, 1, 2])
    // log-only: the model surface only sees the user message
    expect(deriveMessages(s).map((m) => m.role)).toEqual(["user"])
    // searchable: description/agentPath and result text are FTS-visible
    expect(deriveSearchText(s.events[1]!)).toContain("helper")
    expect(deriveSearchText(s.events[1]!)).toContain("root/helper")
    expect(deriveSearchText(s.events[2]!)).toBe("done")
  })
})
