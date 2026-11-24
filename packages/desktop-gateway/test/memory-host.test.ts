import { it, expect } from "vitest"
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openMemoryStore } from "@i-harness/memory"
import { createDesktopHost } from "../src/host.ts"
import { createDesktopProfileServices } from "../src/configuration-host.ts"
import { isRpcSuccess, isRpcFailure, type RpcMessage } from "@i-harness/sdk"

it("requires opt-in and persists workspace notes and preference across gateway restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-memory-host-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const frames: RpcMessage[] = []
  const options = { workspace, sessionDir: join(root, "sessions"), settingsPath: join(root, "settings.json"), onWrite: (frame: RpcMessage) => frames.push(frame) }
  let host = await createDesktopHost(options)
  let seq = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++seq
    await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return frames.find(f => "id" in f && f.id === id)
  }
  try {
    expect(isRpcFailure(await call("desktop/memory/list"))).toBe(true)
    await call("initialize")
    await expect(access(join(options.sessionDir, "memory.sqlite"))).rejects.toMatchObject({ code: "ENOENT" })
    const initial = await call("desktop/memory/state")
    if (!isRpcSuccess(initial)) throw new Error("state unavailable")
    expect(initial.result).toMatchObject({ enabled: false, generation: "unavailable" })
    expect(isRpcFailure(await call("desktop/memory/note", { title: "decision", text: "pnpm" }))).toBe(true)
    await call("desktop/memory/configure", { enabled: true })
    const saved = await call("desktop/memory/note", { title: "decision", text: "pnpm test" })
    if (!isRpcSuccess(saved)) throw new Error("save failed")
    const id = (saved.result as { note: { id: string } }).note.id
    await host.close()
    host = await createDesktopHost(options)
    await call("initialize")
    const restored = await call("desktop/memory/search", { query: "pnpm" })
    if (!isRpcSuccess(restored)) throw new Error("search failed")
    expect(restored.result).toMatchObject({ hits: [expect.objectContaining({ id })] })
    const enabled = await call("desktop/memory/state")
    if (!isRpcSuccess(enabled)) throw new Error("state failed")
    expect(enabled.result).toMatchObject({ enabled: true })
    await call("desktop/memory/forget", { id })
    const forgotten = await call("desktop/memory/search", { query: "pnpm" })
    if (!isRpcSuccess(forgotten)) throw new Error("search failed")
    expect(forgotten.result).toEqual({ hits: [] })
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

it("lists sessions with an unavailable memory database and retries memory access after repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-cold-memory-"))
  const workspace = join(root, "workspace"), sessionDir = join(root, "sessions")
  await Promise.all([mkdir(workspace), mkdir(sessionDir)])
  const path = join(sessionDir, "memory.sqlite")
  await writeFile(path, "invalid database")
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    const frames: RpcMessage[] = []
    host = await createDesktopHost({ workspace, sessionDir, settingsPath: join(root, "settings.json"), onWrite: frame => frames.push(frame) })
    const call = async (id: number, method: string) => {
      await host!.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }))
      return frames.find(frame => "id" in frame && frame.id === id)
    }
    expect(await call(1, "initialize")).toMatchObject({ result: { capabilities: { "desktop-memory": ["1"] } } })
    expect(isRpcSuccess(await call(2, "session/dashboard"))).toBe(true)
    expect(isRpcFailure(await call(3, "desktop/memory/state"))).toBe(true)
    expect(await readFile(path, "utf8")).toBe("invalid database")
    await rm(path)
    expect(await call(4, "desktop/memory/state")).toMatchObject({ result: { enabled: false } })
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }) }
})

it("admits a workspace during a memory transaction and leaves its sibling responsive to a contended write", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-shared-memory-"))
  const settingsPath = join(root, "settings.json")
  await writeFile(settingsPath, "{}")
  const profile = createDesktopProfileServices(settingsPath)
  const hosts: Awaited<ReturnType<typeof createDesktopHost>>[] = []
  let blocker: DatabaseSync | undefined
  const workspaceFor = (id: string) => join(root, id)
  const sessionDirFor = (id: string) => join(root, "sessions", id)
  async function connect(id: string) {
    const frames: RpcMessage[] = []
    const workspace = workspaceFor(id)
    await mkdir(workspace)
    const host = await createDesktopHost({ profile, workspace, sessionDir: sessionDirFor(id), settingsPath, onWrite: frame => frames.push(frame) })
    hosts.push(host)
    let seq = 0
    async function call(method: string, params: unknown = {}) {
      const id = ++seq
      await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      return frames.find(frame => "id" in frame && frame.id === id)
    }
    await call("initialize")
    return call
  }
  try {
    const a = await connect("a")
    const path = join(sessionDirFor("b"), "memory.sqlite")
    const seed = openMemoryStore({ path, scope: workspaceFor("b") })
    try { seed.setEnabled(true) } finally { seed.close() }
    blocker = new DatabaseSync(path)
    blocker.exec("BEGIN IMMEDIATE")
    const b = await connect("b")
    expect(await b("desktop/memory/state")).toMatchObject({ result: { enabled: true } })
    const started = performance.now()
    const [write, ping] = await Promise.all([b("desktop/memory/note", { title: "note", text: "once" }), a("ping")])
    expect(ping).toMatchObject({ result: { ok: true } })
    expect(write).toMatchObject({ error: { message: expect.stringMatching(/locked|busy/i) } })
    expect(performance.now() - started).toBeLessThan(2500) // prior synchronous SQLite timeout was 5000 ms
    blocker.exec("ROLLBACK")
    expect(isRpcSuccess(await b("desktop/memory/note", { title: "note", text: "once" }))).toBe(true)
    expect(await b("desktop/memory/list")).toMatchObject({ result: { notes: [expect.objectContaining({ title: "note" })] } })
  } finally {
    blocker?.close()
    for (const host of hosts) await host.close()
    await profile.close()
    await rm(root, { recursive: true, force: true })
  }
})
