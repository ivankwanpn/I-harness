import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { SessionService } from "@i-harness/session-executor"
import { createSessionManagement } from "../src/session-management.ts"
import { createConversationVisibility } from "../src/session-visibility.ts"
import { createProjectScopeBroker } from "../src/project-scope.ts"
import { mkdir } from "node:fs/promises"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "session-management-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "s1", title: "First" })
  await coordinator.create({ sessionId: "s2", title: "Second" })
  const service = { queueState: () => ({ running: false, queued: 0 }), tasks: () => [] } as unknown as SessionService
  return { root, coordinator, service }
}

describe("session navigation metadata", () => {
  it("forks a completed conversation visibly and persists its project owner without cached SDK authority", async () => {
    const { root, coordinator, service } = await setup()
    const second = join(root, "second"); await mkdir(second)
    const broker = createProjectScopeBroker(coordinator, root)
    await broker.configure({ id: "p1", name: "Both folders", roots: [root, second], primaryRoot: root })
    await broker.bind("s1", "p1")
    const manager = createSessionManagement(coordinator, service, async () => true, { projectFor: broker.projectFor, onFork: broker.inherit })
    try {
      await expect(manager.mutate("s1", "fork")).rejects.toThrow(/completed turn/)
      expect(await coordinator.list()).toHaveLength(2)
      await coordinator.append("s1", [
        { type: "turn/start", seq: 0 }, { type: "user/message", seq: 1, text: "first task" },
        { type: "assistant/message", seq: 2, text: "done" }, { type: "turn/end", seq: 3 },
      ])
      const forked = await manager.mutate("s1", "fork")
      expect(await coordinator.list()).toContain(forked.sessionId)
      expect((await manager.navigation())[forked.sessionId]).toEqual({ pinned: false, unread: false, projectId: "p1" })
      expect((await broker.forSession(forked.sessionId))()?.roots).toEqual([root, second])
      await manager.mutate(forked.sessionId, "archive")
      expect(await manager.archived()).toEqual([expect.objectContaining({ id: forked.sessionId, projectId: "p1" })])
    } finally { await coordinator.close() }
  })
  it("persists independent pin/read choices after coordinator restart without conversation events", async () => {
    const { root, coordinator, service } = await setup()
    const manager = createSessionManagement(coordinator, service)
    await Promise.all([manager.mutate("s1", "pin"), manager.mutate("s1", "unread")])
    expect(await manager.navigation()).toEqual({ s1: { pinned: true, unread: true }, s2: { pinned: false, unread: false } })
    expect((await coordinator.snapshot!("s1")).session.events).toEqual([])
    await coordinator.close()
    const reloaded = createSessionCoordinator(createJsonlBackend(root))
    try {
      const restarted = createSessionManagement(reloaded, service)
      expect((await restarted.navigation()).s1).toEqual({ pinned: true, unread: true })
      await restarted.mutate("s1", "read")
      await restarted.mutate("s1", "unpin")
      expect((await restarted.navigation()).s1).toEqual({ pinned: false, unread: false })
    } finally { await reloaded.close() }
  })

  it("hides internal reviewers from metadata and rejects direct actions against them", async () => {
    const { coordinator, service } = await setup()
    await coordinator.create({ sessionId: "reviewer", origin: "approval-review", archived: true })
    const manager = createSessionManagement(coordinator, service, createConversationVisibility(coordinator))
    try {
      expect(await manager.navigation()).not.toHaveProperty("reviewer")
      expect(await manager.archived()).toEqual([])
      await expect(manager.mutate("reviewer", "pin")).rejects.toThrow(/unavailable/)
      await expect(manager.mutate("reviewer", "restore")).rejects.toThrow(/unavailable/)
      await expect(manager.mutate("missing", "pin")).rejects.toThrow()
    } finally { await coordinator.close() }
  })

  it("allows navigation choices during execution and keeps structural changes guarded", async () => {
    const { coordinator } = await setup()
    const busy = { queueState: () => ({ running: true, queued: 1 }), tasks: () => [] } as unknown as SessionService
    const manager = createSessionManagement(coordinator, busy)
    try {
      await manager.mutate("s1", "pin")
      await manager.mutate("s1", "unread")
      expect((await manager.navigation()).s1).toEqual({ pinned: true, unread: true })
      await expect(manager.mutate("s1", "archive")).rejects.toThrow("busy")
      await expect(manager.mutate("s1", "rename", "New")).rejects.toThrow("busy")
      await expect(manager.mutate("s1", "fork")).rejects.toThrow("busy")
    } finally { await coordinator.close() }
  })

  it("validates actions and rename text before saving any metadata", async () => {
    const { coordinator, service } = await setup()
    const manager = createSessionManagement(coordinator, service)
    try {
      await expect(manager.mutate("s1", "invalid" as never)).rejects.toThrow(/Invalid/)
      await expect(manager.mutate("s1", "rename", " ")).rejects.toThrow(/title/)
      await manager.mutate("s1", "rename", "  New name  ")
      expect((await coordinator.profile("s1")).meta.title).toBe("New name")
      await manager.mutate("s1", "archive")
      expect(await manager.archived()).toMatchObject([{ id: "s1", title: "New name" }])
      expect((await manager.navigation()).s1).toEqual({ pinned: false, unread: false })
      await manager.mutate("s1", "restore")
      expect(await manager.archived()).toEqual([])
    } finally { await coordinator.close() }
  })
})
