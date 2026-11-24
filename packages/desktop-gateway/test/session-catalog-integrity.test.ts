import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createJsonlCommitCoordinator } from "@i-harness/session-persistence-jsonl/internal/commit-coordinator"
import { createDesktopHost } from "../src/host.ts"
import { createCommittedSessionCatalog } from "../src/session-catalog.ts"

it.each(["jsonl", "commit-log"])("preserves healthy %s rows across cold and live catalog reads", async store => {
  const root = await mkdtemp(join(tmpdir(), "ih-catalog-partial-"))
  vi.stubEnv("IH_CONFIG_DIR", root)
  const workspace = join(root, "workspace"), sessionDir = join(root, "sessions"), settingsPath = join(root, "settings.json")
  const cold = createCommittedSessionCatalog()
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    await mkdir(workspace)
    await mkdir(sessionDir)
    await writeFile(settingsPath, JSON.stringify({ sessionStore: store }))
    const writer = store === "jsonl" ? createSessionCoordinator(createJsonlBackend(sessionDir)) : createJsonlCommitCoordinator(sessionDir)
    try {
      await writer.create({ sessionId: "good", title: "Healthy" })
      await writer.create({ sessionId: "damaged", title: "Damaged" })
    } finally { await writer.close() }
    let damaged = join(sessionDir, "damaged.jsonl")
    if (store === "commit-log") {
      const dir = join(sessionDir, "damaged")
      const journal = (await readdir(dir)).find(name => /^session\.v\d+\.jsonl$/.test(name))
      expect(journal).toBeDefined()
      damaged = join(dir, journal!)
    }
    await writeFile(damaged, "invalid session header\n")
    const dashboard = { listingPartial: true, sessions: [{ id: "good", title: "Healthy" }] }
    const navigation = { partial: true, entries: { good: { pinned: false, unread: false } } }
    expect(await cold.dashboard(sessionDir)).toMatchObject(dashboard)
    expect(await cold.navigationSnapshot(sessionDir)).toEqual(navigation)
    const frames: unknown[] = []
    host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame) })
    async function call(id: number, method: string, params = {}) {
      await host!.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      const frame = frames.find(frame => (frame as { id?: number }).id === id) as { result?: unknown; error?: unknown }
      expect(frame?.error).toBeUndefined()
      return frame.result
    }
    await call(1, "initialize")
    expect(await call(2, "session/dashboard")).toMatchObject(dashboard)
    expect(await call(3, "desktop/session/navigation/state", { includeCoverage: true })).toEqual(navigation)
    expect(await call(4, "session/list")).toMatchObject(dashboard)
  } finally { await host?.close(); await cold.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
}, 30000)

it("only treats a missing JSONL directory as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-list-io-"))
  const path = join(root, "sessions")
  try {
    expect(await createJsonlBackend(path).list()).toEqual([])
    await writeFile(path, "not a directory")
    await expect(createJsonlBackend(path).list()).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
