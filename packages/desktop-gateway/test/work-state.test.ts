import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionService } from "@i-harness/session-executor"
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
    expect(await state.read("s1")).toEqual({ todos: null, goal: null })
    await coordinator.append("s1", [
      { type: "todo/write", version: 1, items: [{ content: "old", status: "pending" }], seq: 0 },
      { type: "goal/change", version: 1, operation: "create", goal: { id: "g1", revision: 1, objective: "Finish UI", phase: "active" }, updatedAt: 1, seq: 0 },
      { type: "todo/write", version: 1, items: [{ content: "new", status: "in_progress" }, { content: "test", status: "completed" }], seq: 0 },
    ])
    await coordinator.flush("s1")
    expect(await state.read("s1")).toEqual({ todos: [{ content: "new", status: "in_progress" }, { content: "test", status: "completed" }], goal: { id: "g1", revision: 1, objective: "Finish UI", phase: "active", updatedAt: 1 } })
    await coordinator.append("s1", [
      { type: "todo/write", version: 1, items: [], seq: 0 },
      { type: "goal/change", version: 1, operation: "clear", cleared: { id: "g1", revision: 1 }, seq: 0 },
    ])
    await coordinator.flush("s1")
    expect(await state.read("s1")).toEqual({ todos: [], goal: null })
    await expect(state.read("missing")).rejects.toThrow()
    expect(service.hasAssembly("s1")).toBe(false)
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
