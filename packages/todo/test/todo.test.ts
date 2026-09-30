import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { createTodoTool, deriveTodoList, renderTodoContext } from "../src/index.ts"

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

describe("authoritative Todo model context", () => {
  it("keeps the latest snapshot even when compaction shadows and resets its event", () => {
    const session = createSession()
    append(session, { type: "todo/write", version: 1, items: [{ content: "obsolete plan", status: "pending" }] })
    append(session, { type: "todo/write", version: 1, items: [{ content: "human correction", status: "in_progress" }, { content: "verify restart", status: "pending" }] })
    append(session, { type: "compaction/summary", text: "Summary has no Todo details", shadowedSeqs: [0, 1] })
    append(session, { type: "compaction/prune", version: 1, pruned: [] })
    append(session, { type: "compaction/reset", removedSeqs: [0, 1, 2] })
    const context = renderTodoContext(session)
    expect(context).toContain('"content":"human correction","status":"in_progress"')
    expect(context).toContain('"content":"verify restart","status":"pending"')
    expect(context).not.toContain("obsolete plan")
    expect(deriveTodoList(session)).toEqual([{ content: "human correction", status: "in_progress" }, { content: "verify restart", status: "pending" }])
  })

  it("distinguishes no snapshot from an explicitly cleared list after reset", () => {
    const session = createSession()
    expect(renderTodoContext(session)).toBe("")
    append(session, { type: "todo/write", version: 1, items: [{ content: "removed task", status: "pending" }] })
    append(session, { type: "todo/write", version: 1, items: [] })
    append(session, { type: "compaction/reset", removedSeqs: [0, 1] })
    expect(renderTodoContext(session)).toContain('"todos":[]')
    expect(renderTodoContext(session)).not.toContain("removed task")
  })
})
