import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createNotificationHistory } from "../src/main/notification-history.ts"

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-notification-history-")); roots.push(root)
  const file = join(root, "notifications.json")
  return { file, history: createNotificationHistory(file) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe("durable native notification history", () => {
  it("retains attention targets and read state after reopening without duplicating the same request", async () => {
    const { file, history } = await fixture()
    const input = { id: "workspace:question", workspaceId: "workspace", sessionId: "parent", kind: "question" as const, summary: "等待回答" }
    await history.record(input)
    await history.record(input)
    const first = await history.list()
    expect(first.items).toHaveLength(1)
    expect(first.unread).toBe(1)
    await history.markRead(input.id)
    expect(await createNotificationHistory(file).list()).toMatchObject({ unread: 0, items: [{ sessionId: "parent", read: true }] })
  })
  it("serializes simultaneous records and read changes without losing another target", async () => {
    const { history } = await fixture()
    await Promise.all(Array.from({ length: 12 }, (_, index) => history.record({ id: `request-${index}`, workspaceId: "w", sessionId: `s-${index}`, kind: "approval", summary: `確認 ${index}` })))
    const saved = await history.list()
    expect(new Set(saved.items.map(row => row.id)).size).toBe(12)
    await Promise.all(saved.items.map(row => history.markRead(row.id)))
    expect((await history.list()).unread).toBe(0)
  })
  it("bounds history and stores only the declared display fields", async () => {
    const { file } = await fixture()
    const history = createNotificationHistory(file, { maxItems: 3 })
    for (let index = 0; index < 5; index++) await history.record({ id: `r-${index}`, workspaceId: "w", sessionId: "s", kind: "approval", summary: "x".repeat(800), credentials: "never-store" } as never)
    expect((await history.list()).items.map(row => row.id)).toEqual(["r-4", "r-3", "r-2"])
    const disk = await readFile(file, "utf8")
    expect(disk).not.toContain("never-store")
    expect((await history.list()).items.every(row => row.summary.length <= 512)).toBe(true)
  })
  it("clears only the history and reports damaged saved data instead of presenting an empty history", async () => {
    const { file, history } = await fixture()
    const sibling = join(file, "..", "settings.json")
    await writeFile(sibling, "keep", "utf8")
    await history.record({ id: "r", workspaceId: "w", sessionId: "s", kind: "question", summary: "等待回答" })
    await history.clear()
    expect((await createNotificationHistory(file).list()).items).toEqual([])
    expect(await readFile(sibling, "utf8")).toBe("keep")
    await writeFile(file, '{"version":1,"items":[{"id":"bad"}]}', "utf8")
    await expect(createNotificationHistory(file).list()).rejects.toThrow(/notification|通知/i)
  })
})
