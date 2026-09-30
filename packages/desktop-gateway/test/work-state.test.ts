import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import type { SessionService } from "@i-harness/session-executor"
import type { Session } from "@i-harness/core-session"
import { createDesktopWorkState } from "../src/work-state.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it("reads latest Todo and Goal snapshots from a cold saved session without a model", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-work-state-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s1" })
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  const state = createDesktopWorkState(coordinator, service)
  try {
    expect(await state.read("s1")).toEqual({ todos: null, todosRevision: 0, goal: null })
    await coordinator.append("s1", [
      { type: "todo/write", version: 1, items: [{ content: "old", status: "pending" }], seq: 0 },
      { type: "goal/change", version: 1, operation: "create", goal: { id: "g1", revision: 1, objective: "Finish UI", phase: "active" }, updatedAt: 1, seq: 0 },
      { type: "todo/write", version: 1, items: [{ content: "new", status: "in_progress" }, { content: "test", status: "completed" }], seq: 0 },
    ])
    await coordinator.flush("s1")
    expect(await state.read("s1")).toEqual({ todos: [{ content: "new", status: "in_progress" }, { content: "test", status: "completed" }], todosRevision: 2, goal: { id: "g1", revision: 1, objective: "Finish UI", phase: "active", updatedAt: 1 } })
    await coordinator.append("s1", [
      { type: "todo/write", version: 1, items: [], seq: 0 },
      { type: "goal/change", version: 1, operation: "clear", cleared: { id: "g1", revision: 1 }, seq: 0 },
    ])
    await coordinator.flush("s1")
    expect(await state.read("s1")).toEqual({ todos: [], todosRevision: 3, goal: null })
    await expect(state.read("missing")).rejects.toThrow()
    expect(service.hasAssembly("s1")).toBe(false)
  } finally { await service.close(); await coordinator.close() }
})

it("persists a human Todo edit in a cold session and reloads its revision without creating a model", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-todo-edit-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s1" })
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  try {
    const state = createDesktopWorkState(coordinator, service)
    expect(await state.writeTodos("s1", { expectedRevision: 0, items: [{ content: "  Review edits  ", status: "pending" }] })).toEqual({ todos: [{ content: "Review edits", status: "pending" }], todosRevision: 1, goal: null })
    expect(service.hasAssembly("s1")).toBe(false)
    const reload = createDesktopWorkState(coordinator, service)
    expect(await reload.read("s1")).toMatchObject({ todos: [{ content: "Review edits", status: "pending" }], todosRevision: 1 })
    await state.writeTodos("s1", { expectedRevision: 1, items: [] })
    expect((await coordinator.snapshot!("s1")).session.events).toEqual([
      { type: "todo/write", version: 1, items: [{ content: "Review edits", status: "pending" }], seq: 0 },
      { type: "todo/write", version: 1, items: [], seq: 1 },
    ])
  } finally { await service.close(); await coordinator.close() }
})

it("rejects concurrent stale human replacements while retaining the winning durable snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-todo-cas-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s1" })
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  try {
    const state = createDesktopWorkState(coordinator, service)
    const results = await Promise.allSettled([
      state.writeTodos("s1", { expectedRevision: 0, items: [{ content: "Human winner", status: "pending" }] }),
      state.writeTodos("s1", { expectedRevision: 0, items: [{ content: "Stale edit", status: "pending" }] }),
    ])
    expect(results[0].status).toBe("fulfilled")
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "TODO_REVISION_CONFLICT", actualRevision: 1 } })
    expect(await state.read("s1")).toMatchObject({ todos: [{ content: "Human winner", status: "pending" }], todosRevision: 1 })
    expect((await coordinator.snapshot!("s1")).session.events).toHaveLength(1)
  } finally { await service.close(); await coordinator.close() }
})

it("compares against an unflushed live model snapshot and saves through its durable append hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-todo-live-cas-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { maxDelayMs: 60_000 })
  await coordinator.create({ sessionId: "s1" })
  const live = await createDurableSessionLoader(coordinator)("s1")
  const { createTodoTool } = await import("@i-harness/todo")
  const modelTool = createTodoTool({ session: live })
  await modelTool.execute({ todos: [{ content: "Model update", status: "in_progress" }] }, {})
  const service = { liveSession: (id: string) => id === "s1" ? live : undefined } as SessionService
  try {
    const state = createDesktopWorkState(coordinator, service)
    await expect(state.writeTodos("s1", { expectedRevision: 0, items: [] })).rejects.toMatchObject({ code: "TODO_REVISION_CONFLICT", actualRevision: 1 })
    await state.writeTodos("s1", { expectedRevision: 1, items: [{ content: "Human finish", status: "completed" }] })
    expect(live.events.filter((event) => event.type === "todo/write")).toHaveLength(2)
    expect((await coordinator.snapshot!("s1")).session.events).toHaveLength(2)
    expect(await state.read("s1")).toMatchObject({ todos: [{ content: "Human finish", status: "completed" }], todosRevision: 2 })
  } finally { await coordinator.close() }
})

it.each([
  { expectedRevision: -1, items: [] },
  { expectedRevision: 0, items: [{ content: " ", status: "pending" }] },
  { expectedRevision: 0, items: [{ content: "same", status: "pending" }, { content: " same ", status: "completed" }] },
  { expectedRevision: 0, items: [{ content: "bad status", status: "running" }] },
  { expectedRevision: 0, items: [{ content: "one", status: "in_progress" }, { content: "two", status: "in_progress" }] },
])("rejects invalid human snapshots without adding events: %j", async (input) => {
  const root = mkdtempSync(join(tmpdir(), "desktop-todo-invalid-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s1" })
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  try {
    await expect(createDesktopWorkState(coordinator, service).writeTodos("s1", input as never)).rejects.toThrow()
    expect((await coordinator.snapshot!("s1")).session.events).toEqual([])
  } finally { await service.close(); await coordinator.close() }
})

it("uses the live session snapshot before its events are flushed to disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-work-state-live-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s1" })
  const live = { events: [{ type: "todo/write", version: 1, items: [{ content: "live item", status: "in_progress" }] }] } as Session
  const service = { liveSession: (id: string) => id === "s1" ? live : undefined } as SessionService
  try {
    expect(await createDesktopWorkState(coordinator, service).read("s1")).toMatchObject({ todos: [{ content: "live item", status: "in_progress" }], goal: null })
    expect((await coordinator.load("s1")).session.events).toEqual([])
  } finally { await coordinator.close() }
})

it("reads an authoritative session supplied by the host before its write-behind is flushed", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-work-state-source-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { maxDelayMs: 60_000 })
  await coordinator.create({ sessionId: "s1" })
  const authoritative = await createDurableSessionLoader(coordinator)("s1")
  const { createTodoTool } = await import("@i-harness/todo")
  await createTodoTool({ session: authoritative }).execute({ todos: [{ content: "Pending durability", status: "pending" }] }, {})
  const service = { liveSession: () => undefined } as unknown as SessionService
  try {
    const state = createDesktopWorkState(coordinator, service, { sessionFor: async () => authoritative })
    expect(await state.read("s1")).toMatchObject({ todos: [{ content: "Pending durability", status: "pending" }], todosRevision: 1 })
    expect((await coordinator.snapshot!("s1")).session.events).toEqual([])
  } finally { await coordinator.close() }
})

it("restores the same Todo and CAS revision after summary, prune, reset, and gateway restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-todo-compact-restart-")); roots.push(root)
  const store = join(root, "sessions")
  let coordinator = createSessionCoordinator(createJsonlBackend(store))
  await coordinator.create({ sessionId: "s1" })
  let service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
  try {
    await createDesktopWorkState(coordinator, service).writeTodos("s1", { expectedRevision: 0, items: [{ content: "Keep editing after compression", status: "in_progress" }, { content: "Verify restart", status: "pending" }] })
    await coordinator.append("s1", [
      { type: "compaction/summary", text: "Summary without Todo details", shadowedSeqs: [0], seq: 1 },
      { type: "compaction/prune", version: 1, pruned: [], seq: 2 },
      { type: "compaction/reset", removedSeqs: [0, 1], seq: 3 },
    ])
    await service.close()
    await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(store))
    service = createSessionService({ workspace: root, coordinator, modelPolicy: "required" })
    const state = createDesktopWorkState(coordinator, service)
    expect(await state.read("s1")).toEqual({ todos: [{ content: "Keep editing after compression", status: "in_progress" }, { content: "Verify restart", status: "pending" }], todosRevision: 1, goal: null })
    await expect(state.writeTodos("s1", { expectedRevision: 0, items: [] })).rejects.toMatchObject({ code: "TODO_REVISION_CONFLICT", actualRevision: 1 })
    expect(service.hasAssembly("s1")).toBe(false)
  } finally { await service.close(); await coordinator.close() }
})
