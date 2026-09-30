import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { GuardianReviewRecord } from "@i-harness/guard-approval"
import { createDesktopApprovalHistory } from "../src/approval-history.ts"

function record(id: string): GuardianReviewRecord {
  return { id, startedAt: 123, durationMs: 10, status: "completed", request: { name: "read", reason: "delegate", args: '{"path":"sample.txt"}', argsTruncated: false },
    model: { provider: "cheap", model: "small", protocol: "openai-completions", reasoningEffort: "low" }, reusedContext: true,
    outcome: "approve", reviewerOutcome: "approve", rationale: "Safe read" }
}
it("persists per-session review history through restart without creating chat events", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-approval-history-"))
  let coordinator = createSessionCoordinator(createJsonlBackend(root))
  try {
    await coordinator.create({ sessionId: "parent" }); await coordinator.create({ sessionId: "other" })
    const history = createDesktopApprovalHistory(coordinator)
    await history.append("parent", record("review-one")); await history.flush(); await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root))
    expect(await createDesktopApprovalHistory(coordinator).read("parent")).toEqual([record("review-one")])
    expect(await createDesktopApprovalHistory(coordinator).read("other")).toEqual([])
    expect((await coordinator.snapshot!("parent")).session.events).toEqual([])
    expect(await coordinator.list()).toEqual(["other", "parent"])
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it("serializes concurrent records and retains the newest bounded history", async () => {
  const docs = new Map<string, unknown>()
  const coordinator = { async profile() { return {} }, async getDocument(key: string) { return docs.get(key) }, async putDocument(key: string, data: unknown) { await Promise.resolve(); docs.set(key, structuredClone(data)) } } as unknown as SessionCoordinator
  const history = createDesktopApprovalHistory(coordinator)
  await Promise.all(Array.from({ length: 120 }, (_, index) => history.append("parent", record(String(index)))))
  const rows = await history.read("parent")
  expect(rows).toHaveLength(100)
  expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 100 }, (_, index) => String(index + 20)))
  expect([...docs.keys()][0]).toMatch(/^approval-history-[a-f0-9]{64}$/)
})
it("bounds stored request/rationale fields, strips unknown fields, and returns detached rows", async () => {
  let doc: unknown
  const coordinator = { async profile() { return {} }, async getDocument() { return doc }, async putDocument(_key: string, data: unknown) { doc = structuredClone(data) } } as unknown as SessionCoordinator
  const history = createDesktopApprovalHistory(coordinator)
  const oversized = { ...record("bounded"), rationale: "r".repeat(4000), request: { name: "read", reason: "r".repeat(4000), args: "a".repeat(20000), argsTruncated: false }, extra: "discard" }
  await history.append("parent", oversized)
  const rows = await history.read("parent")
  expect(rows[0]!.request).toMatchObject({ argsTruncated: true })
  expect(rows[0]!.request.args).toHaveLength(16000)
  expect(rows[0]!.rationale).toHaveLength(2000)
  expect(rows[0]).not.toHaveProperty("extra")
  rows[0]!.request.name = "changed"
  expect((await history.read("parent"))[0]!.request.name).toBe("read")
})
