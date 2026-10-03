import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../src/index.ts"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it("persists minimal original visibility before removal and resumes only the same exact manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "delete-receipt-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "s", origin: "subagent", parentSession: "parent", title: "private deleted title" })
  await coordinator.append("s", [{ type: "user/message", seq: 0, text: "private deleted prompt" }])
  const manifest = { documents: ["session-title/s"], files: [] }
  await coordinator.deleteOwnedSession!("s", manifest); await coordinator.close()
  const backend = createJsonlBackend(root)
  expect(await backend.deletionReceipt!("s")).toEqual({ visibility: { origin: "subagent", parentSession: "parent" }, manifest })
  const marker = join(root, `desktop-deleted-session-${createHash("sha256").update("s").digest("hex")}.tombstone`)
  const content = await readFile(marker, "utf8")
  expect(content).not.toContain("private deleted"); expect(Object.keys(JSON.parse(content))).toEqual(["version", "sessionId", "visibility", "documents", "files"])
  await backend.deleteOwnedSession!("s", manifest)
  await expect(backend.deleteOwnedSession!("s", { documents: [] })).rejects.toThrow(/manifest changed/)
  expect(await backend.deletionReceipt!("missing")).toBeUndefined()
  await writeFile(marker, JSON.stringify({ version: 1, sessionId: "s", ...manifest }))
  expect(await backend.deletionReceipt!("s")).toBeUndefined()
  await writeFile(marker, JSON.stringify({ version: 2, sessionId: "other", visibility: {}, ...manifest }))
  await expect(backend.deletionReceipt!("s")).rejects.toThrow(/Invalid deletion receipt/)
})
it("drains accepted writes, deletes exact owned documents, and fences recreation after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-delete-")); roots.push(root)
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend)
  await coordinator.create({ sessionId: "s" }); await coordinator.create({ sessionId: "sibling" })
  await coordinator.putDocument("session-title/s", { title: "owned" })
  await coordinator.putDocument("session-title/sibling", { title: "survives" })
  await writeFile(join(root, "source.txt"), "source survives")
  coordinator.enqueue("s", [{ type: "user/message", seq: 0, text: "accepted before deletion" }])
  expect(typeof coordinator.deleteOwnedSession).toBe("function")
  await coordinator.deleteOwnedSession!("s", { documents: ["session-title/s"] })
  expect(await coordinator.list()).toEqual(["sibling"])
  expect(await coordinator.getDocument("session-title/s")).toBeUndefined()
  expect(await coordinator.getDocument("session-title/sibling")).toEqual({ title: "survives" })
  expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source survives")
  expect(() => coordinator.enqueue("s", [{ type: "turn/start" }])).toThrow(/deleted|deleting/)
  await coordinator.close()
  const restarted = createSessionCoordinator(createJsonlBackend(root))
  await expect(restarted.create({ sessionId: "s" })).rejects.toThrow(/deleted/)
  await expect(backend.putDocument("session-title/s", {})).rejects.toThrow(/deleted/)
  await restarted.close()
})
it("withholds destructive capability for custom read-only backends", async () => {
  const root = await mkdtemp(join(tmpdir(), "readonly-delete-")); roots.push(root)
  const backend = createJsonlBackend(root)
  backend.deleteOwnedSession = undefined
  const coordinator = createSessionCoordinator(backend)
  expect(coordinator.deleteOwnedSession).toBeUndefined()
  await coordinator.close()
})
it.runIf(process.platform === "win32")("refuses deletion while another coordinator owns the actual session lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "delete-lease-")); roots.push(root)
  const owner = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const other = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true }, acquireDeadlineMs: 40, acquireRetryMs: 2 })
  await owner.create({ sessionId: "s" })
  try {
    await expect(other.deleteOwnedSession!("s", { documents: [] })).rejects.toThrow(/owned|lock|conflict/i)
    expect(await owner.profile("s")).toBeDefined()
  } finally { await other.close(); await owner.close() }
})
it("refuses sibling document identities before closing the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "delete-manifest-")); roots.push(root)
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend)
  await coordinator.create({ sessionId: "s" })
  await coordinator.putDocument("session-title/sibling", { title: "sibling" })
  await expect(backend.deleteOwnedSession!("s", { documents: ["session-title/sibling"] })).rejects.toThrow(/manifest|owned/)
  expect(await coordinator.profile("s")).toBeDefined()
  expect(await coordinator.getDocument("session-title/sibling")).toEqual({ title: "sibling" })
  await coordinator.close()
})
it("refuses a symlinked artifact parent and leaves outside documents intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "delete-confine-")); roots.push(root)
  const outside = await mkdtemp(join(tmpdir(), "delete-outside-")); roots.push(outside)
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "s" })
  await writeFile(join(outside, "s.doc.jsonl"), '{"source":"outside"}\n')
  await symlink(outside, join(root, "session-title"), process.platform === "win32" ? "junction" : "dir")
  await expect(coordinator.deleteOwnedSession!("s", { documents: ["session-title/s"] })).rejects.toThrow(/symlink/)
  expect(await readFile(join(outside, "s.doc.jsonl"), "utf8")).toContain("outside")
  await coordinator.close()
})
