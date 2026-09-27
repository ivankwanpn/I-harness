import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { createAfterScheduleRecord } from "@i-harness/schedule"
import { createDesktopSchedules } from "../src/schedules.ts"
import type { SessionService } from "@i-harness/session-executor"

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

async function fixture(modelPolicy: "test-mock" | "required" = "test-mock") {
  const root = mkdtempSync(join(tmpdir(), "desktop-schedules-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s1" })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelPolicy,
    ...(modelPolicy === "test-mock" ? { mockScript: [{ role: "assistant" as const, text: "unused" }] } : {}) })
  const schedules = createDesktopSchedules(coordinator, service)
  return { root, coordinator, service, schedules, close: async () => { await service.close(); await coordinator.close() } }
}

it("lists a cold session's persisted schedules without creating an Agent", async () => {
  const f = await fixture("required")
  try {
    const record = createAfterScheduleRecord("schedule-1", "later", 600, Date.now())
    await f.coordinator.append("s1", [{ type: "schedule/change", version: 1, operation: "create", schedule: record, seq: 0 }])
    expect(await f.schedules.list("s1")).toMatchObject({ schedules: [{ id: "schedule-1", prompt: "later", kind: "after" }] })
    expect(f.service.hasAssembly("s1")).toBe(false)
  } finally { await f.close() }
})

it("creates every rule kind durably and deletes one without sending a model prompt", async () => {
  const f = await fixture()
  try {
    const after = await f.schedules.create("s1", { prompt: "after", after_seconds: 600 })
    const at = await f.schedules.create("s1", { prompt: "at", at: new Date(Date.now() + 900_000).toISOString() })
    const every = await f.schedules.create("s1", { prompt: "repeat", every_seconds: 300 })
    expect([after.id, at.id, every.id]).toEqual(["schedule-1", "schedule-2", "schedule-3"])
    expect((await f.schedules.list("s1")).schedules.map((row) => row.kind)).toEqual(["after", "at", "every"])
    expect((await f.coordinator.load("s1")).session.events.filter((event) => event.type === "schedule/change")).toHaveLength(3)
    expect((await f.coordinator.load("s1")).session.events.some((event) => event.type === "assistant/message")).toBe(false)
    expect(await f.schedules.delete("s1", after.id)).toEqual({ deleted: after.id })
    expect((await f.schedules.list("s1")).schedules.map((row) => row.id)).toEqual([at.id, every.id])
    expect((await f.coordinator.load("s1")).session.events.filter((event) => event.type === "schedule/change")).toHaveLength(4)
  } finally { await f.close() }
})

it("rejects invalid rules and an unconfigured model without writing changes", async () => {
  const f = await fixture("required")
  try {
    await expect(f.schedules.create("s1", { prompt: "later", after_seconds: 600 })).rejects.toThrow(/model/i)
    expect((await f.schedules.list("s1")).schedules).toEqual([])
  } finally { await f.close() }
  const configured = await fixture()
  try {
    await expect(configured.schedules.create("s1", { prompt: " ", after_seconds: 600 })).rejects.toThrow(/prompt/i)
    await expect(configured.schedules.create("s1", { prompt: "bad", after_seconds: 1, every_seconds: 300 })).rejects.toThrow(/exactly one/i)
    await expect(configured.schedules.delete("s1", "schedule-999")).rejects.toThrow(/active schedule/i)
    expect((await configured.schedules.list("s1")).schedules).toEqual([])
  } finally { await configured.close() }
})

it("refuses create/delete during a running turn while keeping list readable", async () => {
  const f = await fixture()
  try {
    const busy = { ...f.service, queueState: () => ({ running: true, queued: 0 }) } as SessionService
    const schedules = createDesktopSchedules(f.coordinator, busy)
    await expect(schedules.create("s1", { prompt: "later", after_seconds: 600 })).rejects.toThrow(/busy/)
    await expect(schedules.delete("s1", "schedule-1")).rejects.toThrow(/busy/)
    expect(await schedules.list("s1")).toEqual({ schedules: [] })
    expect((await f.coordinator.load("s1")).session.events).toEqual([])
  } finally { await f.close() }
})
