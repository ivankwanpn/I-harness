import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMemoryStore } from "../src/index.ts"

it("compares revisions inside SQLite, preserves identity, and replaces the scoped FTS content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-memory-cas-"))
  const path = join(root, "memory.sqlite")
  const a = openMemoryStore({ path, scope: "a" }), b = openMemoryStore({ path, scope: "a" }), other = openMemoryStore({ path, scope: "b" })
  try {
    const original = a.add({ title: "Original", text: "obsoleteword", sessionId: "session" })
    const draft = b.read(original.id)
    const updated = a.update({ id: original.id, title: "Revised", text: "replacementword Authorization: Bearer secret-example-value", expectedRevision: original.revision })
    expect(updated.kind).toBe("saved")
    const current = b.read(original.id)
    expect(current).toMatchObject({ id: original.id, sessionId: "session", createdAt: original.createdAt, title: "Revised" })
    expect(current.revision).not.toBe(original.revision)
    expect(current.text).not.toContain("secret-example-value")
    expect(b.search("obsoleteword")).toEqual([])
    expect(b.search("replacementword")).toMatchObject([{ id: original.id }])
    expect(b.search("replacementword")[0]?.revision).toBe(current.revision)
    expect(other.search("replacementword")).toEqual([])
    expect(b.update({ id: original.id, title: "stale", text: "draft", expectedRevision: draft.revision })).toMatchObject({ kind: "conflict", note: { title: "Revised" } })
    expect(() => other.update({ id: original.id, title: "wrong", text: "scope", expectedRevision: current.revision })).toThrow(/not found/)
    const second = a.add({ title: "Second", text: "secondword" })
    expect(a.forgetMany([{ id: current.id, expectedRevision: original.revision }, { id: second.id, expectedRevision: second.revision }])).toMatchObject({ kind: "conflict" })
    expect(b.read(second.id).title).toBe("Second")
    expect(a.forgetMany([{ id: current.id, expectedRevision: current.revision }, { id: second.id, expectedRevision: second.revision }])).toEqual({ kind: "forgotten", ids: [current.id, second.id] })
    expect(b.search("replacementword")).toEqual([])
  } finally { a.close(); b.close(); other.close(); await rm(root, { recursive: true, force: true }) }
})
