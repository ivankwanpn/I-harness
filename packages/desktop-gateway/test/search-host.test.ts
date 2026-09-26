import { it, expect } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDesktopHost } from "../src/host.ts"
import { isRpcSuccess, isRpcFailure, type RpcMessage } from "@i-harness/sdk"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"

it("searches persisted sessions only inside its workspace session store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-search-host-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const sessionDir = join(root, "sessions")
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
  const { id } = await coordinator.create()
  await coordinator.append(id, [{ type: "user/message", text: "uniqueneedle remembered decision", seq: 0 }])
  await coordinator.close()
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath: join(root, "settings.json"), onWrite: f => frames.push(f) })
  const otherFrames: RpcMessage[] = []
  const other = await createDesktopHost({ workspace, sessionDir: join(root, "other-sessions"), settingsPath: join(root, "other.json"), onWrite: f => otherFrames.push(f) })
  const call = (target: typeof host, id: number, method: string, params: unknown) => target.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  try {
    await call(host, 1, "desktop/session/search", { query: "uniqueneedle" })
    expect(isRpcFailure(frames.find(f => "id" in f && f.id === 1))).toBe(true)
    await call(host, 2, "initialize", {})
    await call(host, 3, "desktop/session/search", { query: "uniqueneedle", limit: 10 })
    const result = frames.find(f => "id" in f && f.id === 3)
    expect(isRpcSuccess(result)).toBe(true)
    if (!isRpcSuccess(result)) throw new Error("search unavailable")
    expect((result.result as { hits: { sessionId: string }[] }).hits).toEqual([expect.objectContaining({ sessionId: id })])
    await call(other, 4, "initialize", {})
    await call(other, 5, "desktop/session/search", { query: "uniqueneedle" })
    const empty = otherFrames.find(f => "id" in f && f.id === 5)
    if (!isRpcSuccess(empty)) throw new Error("second search unavailable")
    expect(empty.result).toEqual({ hits: [] })
    await call(host, 6, "desktop/session/search", { query: "x", limit: -1 })
    expect(isRpcFailure(frames.find(f => "id" in f && f.id === 6))).toBe(true)
  } finally {
    await host.close()
    await other.close()
    await rm(root, { recursive: true, force: true })
  }
})
