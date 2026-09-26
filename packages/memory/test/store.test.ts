import { it, expect } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openMemoryStore } from "../src/index.ts"

it("shares notes across instances and restarts while isolating workspace scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-memory-"))
  const path = join(root, "memory.sqlite")
  const a = openMemoryStore({ path, scope: "workspace:a" })
  const b = openMemoryStore({ path, scope: "workspace:a" })
  const other = openMemoryStore({ path, scope: "workspace:b" })
  try {
    const note = a.add({ title: "Build decision", text: "使用 pnpm 執行測試", sessionId: "source" })
    expect(b.read(note.id)).toMatchObject({ text: "使用 pnpm 執行測試", sessionId: "source" })
    expect(b.search("pnpm")).toEqual([expect.objectContaining({ id: note.id })])
    expect(other.search("pnpm")).toEqual([])
    expect(() => other.read(note.id)).toThrow(/not found/)
    a.close()
    const restarted = openMemoryStore({ path, scope: "workspace:a" })
    try {
      expect(restarted.list()).toHaveLength(1)
      expect(restarted.summary()).toContain("pnpm")
      expect(restarted.forget(note.id)).toBe(true)
      expect(b.search("pnpm")).toEqual([])
      expect(() => b.read(note.id)).toThrow(/not found/)
      expect(restarted.forget(note.id)).toBe(false)
    } finally { restarted.close() }
  } finally {
    a.close(); b.close(); other.close()
    await rm(root, { recursive: true, force: true })
  }
})

it("bounds stored and retrieved text and redacts recognizable secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-memory-"))
  const store = openMemoryStore({ path: join(root, "memory.sqlite"), scope: "workspace" })
  try {
    expect(() => store.add({ title: "large", text: "字".repeat(20000) })).toThrow(/large/)
    expect(() => store.add({ title: "empty", text: " " })).toThrow(/empty/)
    const note = store.add({ title: "credential", text: "Authorization: Bearer secret-example-value" })
    expect(store.read(note.id).text).not.toContain("secret-example-value")
    const chinese = store.add({ title: "部署決策", text: "部署前必須執行測試" })
    expect(store.search("測試")).toEqual([expect.objectContaining({ id: chinese.id })])
    expect(() => store.search("x", 1000)).toThrow(/limit/)
    for (let n = 0; n < 30; n++) store.add({ title: "decision " + n, text: "pnpm ".repeat(200) })
    expect(Buffer.byteLength(store.summary(), "utf8")).toBeLessThanOrEqual(6000)
    expect(store.search("pnpm", 3)).toHaveLength(3)
  } finally { store.close(); await rm(root, { recursive: true, force: true }) }
})
