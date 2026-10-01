import { expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

it("omits new and legacy approval reviews from conversation navigation without removing their logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-review-navigation-"))
  const workspace = join(root, "workspace"); await mkdir(workspace)
  const sessionDir = join(root, "sessions")
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
  const reviewPrompt = 'An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),\nallow (ask the user first), or deny (never execute).\n\n<request>\ntool: read\n</request>\n\n<recent_context>\ncontext\n</recent_context>\nOutput STRICT JSON only — one object, no fences, no prose: {"outcome":"approve"|"allow"|"deny"}'
  const create = async (sessionId: string, metadata: Record<string, unknown>, text: string) => {
    await coordinator.create({ sessionId, ...metadata })
    await coordinator.append(sessionId, [{ type: "user/message", seq: 0, text }])
  }
  await create("main", { title: "Main conversation" }, "task")
  await create("review-new", { origin: "approval-review", parentSession: "main", seedLength: 0 }, reviewPrompt)
  await create("review-old", { origin: "subagent", parentSession: "main", seedLength: 0 }, reviewPrompt)
  await create("review-archived", { origin: "approval-review", parentSession: "main", seedLength: 0, archived: true }, reviewPrompt)
  await create("normal-child", { origin: "subagent", parentSession: "main", seedLength: 0 }, "ordinary delegated work")
  await create("user-copy", {}, reviewPrompt)
  await create("user-fork", { origin: "fork", parentSession: "main" }, "a user-created fork")
  await create("user-archived", { archived: true }, "archived user work")
  await coordinator.close()
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Read-only navigation must not call a provider"))
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    for (let restart = 0; restart < 2; restart++) {
      const frames: RpcMessage[] = []
      host = await createDesktopHost({ workspace, sessionDir, settingsPath: join(root, "settings.json"), onWrite: (frame) => frames.push(frame) })
      let id = 0
      const call = async (method: string, params = {}) => {
        const requestId = ++id
        await host!.handleLine(encodeFrame(makeRequest(requestId, method, params)))
        const reply = frames.find((frame) => "id" in frame && frame.id === requestId)
        if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
        return reply.result as { sessions: { id: string }[] }
      }
      await call("initialize")
      expect((await call("session/list")).sessions.map((row) => row.id).sort()).toEqual(["main", "user-copy", "user-fork"])
      expect((await call("session/dashboard")).sessions.map((row) => row.id).sort()).toEqual(["main", "user-copy", "user-fork"])
      expect(await call("desktop/session/archived")).toEqual([expect.objectContaining({ id: "user-archived" })])
      expect(await call("desktop/session/navigation/state")).not.toHaveProperty("normal-child")
      expect(await call("desktop/session/search", { query: "ordinary" })).toEqual({ hits: [] })
      expect(await call("desktop/session/subagents/list", { sessionId: "main" })).toMatchObject({ parentSessionId: "main", agents: [expect.objectContaining({ sessionId: "normal-child", live: false, canFollowup: false })] })
      expect(await call("desktop/session/subagents/history", { sessionId: "main", childSessionId: "normal-child" })).toMatchObject({ events: [expect.objectContaining({ text: "ordinary delegated work" })], nextSeq: 1 })
      expect(fetch).not.toHaveBeenCalled()
      await host.close(); host = undefined
    }
    const preserved = createSessionCoordinator(createJsonlBackend(sessionDir))
    expect((await preserved.list()).length).toBe(8)
    expect((await preserved.snapshot!("review-old")).session.events[0]).toMatchObject({ text: reviewPrompt })
    await preserved.close()
  } finally { await host?.close(); fetch.mockRestore(); await rm(root, { recursive: true, force: true }) }
})
