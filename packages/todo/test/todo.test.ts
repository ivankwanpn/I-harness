import { describe, expect, it } from "vitest"
import { createSession, append, metadataFactsFor } from "@i-harness/core-session"
import { applyTodoProjection, createTodoTool, deriveTodoList, isTodoSnapshot, renderTodoContext, renderTodoSnapshot } from "../src/index.ts"

describe("todo_write tool", () => {
  it("writes through an owned metadata source without requiring a Session view", async () => {
    const session = createSession()
    const tool = createTodoTool({ metadata: metadataFactsFor(session) })
    const out = await tool.execute({ todos: [{ content: "owned", status: "pending" }] }, {})
    expect(out.counts.pending).toBe(1)
    expect(deriveTodoList(session)).toEqual([{ content: "owned", status: "pending" }])
  })
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
  it("incrementally projects writes and retains explicit empty lists", () => {
    const items = [{ content: "work", status: "pending" as const }]
    const current = applyTodoProjection(null, { type: "todo/write", version: 1, items })
    expect(current).toEqual(items)
    expect(applyTodoProjection(current, { type: "user/message", text: "hello" })).toBe(current)
    expect(applyTodoProjection(current, { type: "todo/write", version: 1, items: [] })).toEqual([])
  })
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
  it("renders absent and explicitly cleared owned snapshots distinctly", () => {
    expect(renderTodoSnapshot(null)).toBe("")
    expect(renderTodoSnapshot([])).toContain('"todos":[]')
  })
  it("validates closed owned snapshot data", () => {
    expect(isTodoSnapshot({kind:'absent'})).toBe(true)
    expect(isTodoSnapshot({kind:'present',items:[]})).toBe(true)
    expect(isTodoSnapshot({kind:'present',items:[{content:'x',status:'invalid'}]})).toBe(false)
    expect(isTodoSnapshot({kind:'absent',items:[]})).toBe(false)
    expect(isTodoSnapshot(Object.defineProperty({kind:'absent'},'extra',{value:true}))).toBe(false)
    expect(isTodoSnapshot(new Proxy({kind:'absent'},{}))).toBe(false)
    Object.defineProperty(Object.prototype,'kind',{value:'absent',configurable:true})
    try { expect(isTodoSnapshot({other:true})).toBe(false) } finally { delete (Object.prototype as {kind?:unknown}).kind }
    const sparse = new Array(1) as unknown[] & {extra?:boolean}; sparse.extra=true
    expect(isTodoSnapshot({kind:'present',items:sparse})).toBe(false)
  })
  it("keeps identical snapshots byte-stable while retaining every durable write and real list changes", () => {
    const session = createSession()
    const items = [{ content: "implement", status: "pending" as const }]
    append(session, { type: "todo/write", version: 1, items })
    const first = renderTodoContext(session)
    append(session, { type: "todo/write", version: 1, items: structuredClone(items) })
    expect(renderTodoContext(session)).toBe(first)
    expect(session.events.filter(event => event.type === "todo/write")).toHaveLength(2)
    append(session, { type: "todo/write", version: 1, items: [{ content: "implement", status: "completed" }] })
    expect(renderTodoContext(session)).not.toBe(first)
    expect(renderTodoContext(session)).toContain('"status":"completed"')
  })
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
