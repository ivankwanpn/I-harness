import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { createTodoTool, deriveTodoList } from "../src/index.ts"

describe("todo_write tool", () => {
  it("appends todo/write and returns counts", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s })
    const out = (await tool.execute({ todos: [{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }] }, {})) as { counts: { pending: number; inProgress: number } }
    expect(out.counts).toEqual({ pending: 1, inProgress: 1, completed: 0 })
    expect(s.events.at(-1)!.type).toBe("todo/write")
  })
  it("rejects empty/whitespace content", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s })
    await expect(tool.execute({ todos: [{ content: "   ", status: "pending" }] }, {})).rejects.toThrow(/empty|whitespace/i)
  })
  it("rejects duplicate content", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s })
    await expect(tool.execute({ todos: [{ content: "a", status: "pending" }, { content: "a", status: "pending" }] }, {})).rejects.toThrow(/duplicate/i)
  })
  it("rejects multiple in_progress when allowParallelInProgress false", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s })
    await expect(tool.execute({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] }, {})).rejects.toThrow(/one.*in_progress|at most one/i)
  })
  it("allowParallelInProgress true permits multiple", async () => {
    const s = createSession()
    const tool = createTodoTool({ session: s, allowParallelInProgress: true })
    const out = (await tool.execute({ todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }] }, {})) as { counts: { inProgress: number } }
    expect(out.counts.inProgress).toBe(2)
  })
})

describe("deriveTodoList", () => {
  it("returns null with no todo/write events", () => {
    const s = createSession()
    expect(deriveTodoList(s)).toBeNull()
  })
  it("last-write-wins", () => {
    const s = createSession()
    append(s, { type: "todo/write", version: 1, items: [{ content: "old", status: "pending" }] })
    append(s, { type: "todo/write", version: 1, items: [{ content: "new", status: "completed" }] })
    expect(deriveTodoList(s)).toEqual([{ content: "new", status: "completed" }])
  })
})
