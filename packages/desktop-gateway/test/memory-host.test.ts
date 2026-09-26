import { it, expect } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDesktopHost } from "../src/host.ts"
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
