import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { openMemoryStore } from "@i-harness/memory"
import { createDesktopMemory } from "../src/memory-wire.ts"

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ih-memory-retry-"))
  const path = join(dir, "memory.sqlite")
  const store = openMemoryStore({ path, scope: "workspace", busyTimeoutMs: 0 })
  store.setEnabled(true)
  const memory = createDesktopMemory(store, true)
  const held = new DatabaseSync(path)
  held.exec("BEGIN IMMEDIATE")
  const note = memory.tools.find(tool => tool.name === "memory_note")!
  return { store, memory, held, note, async close() {
    memory.stop(); held.close(); store.close(); await rm(dir, { recursive: true, force: true })
  } }
}

it("keeps a waiting tool write through enable, and saves once after the lock is released", async () => {
  const f = await fixture()
  try {
    const writing = f.note.execute({ title: "tool", text: "once" }, { sessionId: "s" })
    const enable = f.memory.request("desktop/memory/configure", { enabled: true })
    f.held.exec("ROLLBACK")
    await expect(writing).resolves.toMatchObject({ saved: true, note: { sessionId: "s" } })
    await expect(enable).resolves.toMatchObject({ enabled: true })
    expect(f.store.list()).toHaveLength(1)
  } finally { await f.close() }
})

it.each(["tool cancel", "workspace close", "disable"])("cancels a contended note on %s", async reason => {
  const f = await fixture()
  try {
    const controller = new AbortController()
    const write = f.note.execute({ title: "late", text: "late" }, { abortSignal: controller.signal })
    const stopped = expect(write).rejects.toBeDefined()
    let change: Promise<unknown> | undefined
    if (reason === "tool cancel") controller.abort()
    if (reason === "workspace close") f.memory.stop()
    if (reason === "disable") change = f.memory.request("desktop/memory/configure", { enabled: false })
    await stopped
    f.held.exec("ROLLBACK")
    if (change) await expect(change).resolves.toMatchObject({ enabled: false })
    expect(f.store.list()).toEqual([])
  } finally { await f.close() }
})

it("observes another writer disabling memory before a pending note can commit", async () => {
  const f = await fixture()
  try {
    const write = f.memory.request("desktop/memory/note", { title: "late", text: "late" })
    f.held.prepare("UPDATE preferences SET enabled=0 WHERE scope=?").run("workspace")
    f.held.exec("COMMIT")
    await expect(write).rejects.toThrow(/disabled/)
    expect(f.store.list()).toEqual([])
  } finally { await f.close() }
})
