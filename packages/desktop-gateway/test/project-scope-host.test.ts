import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

it.each([false, true])("reports the completed-turn fork precondition and lists a real child with project ownership (completed=%s)", async (completed) => {
  const root = await mkdtemp(join(tmpdir(), "desktop-project-fork-")); roots.push(root)
  const workspace = join(root, "one"), second = join(root, "two"), sessionDir = join(root, "sessions")
  await Promise.all([workspace, second].map((path) => mkdir(path)))
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
  await coordinator.create({ sessionId: "source", title: "Source" })
  if (completed) await coordinator.append("source", [
    { type: "turn/start", seq: 0 }, { type: "user/message", seq: 1, text: "first task" },
    { type: "assistant/message", seq: 2, text: "done" }, { type: "turn/end", seq: 3 },
  ])
  await coordinator.close()
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath: join(root, "settings.json"), onWrite: (frame) => frames.push(frame) })
  let id = 0
  const call = async (method: string, params: unknown = {}) => {
    const requestId = ++id
    await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    const frame = frames.find((frame) => "id" in frame && frame.id === requestId)
    if (!frame) throw new Error("missing reply")
    return frame
  }
  const success = async (method: string, params?: unknown) => {
    const frame = await call(method, params)
    if (!isRpcSuccess(frame)) throw new Error(JSON.stringify(frame))
    return frame.result
  }
  try {
    await success("initialize")
    await success("desktop/project/sync", { projects: [{ id: "p1", name: "Both folders", roots: [workspace, second], primaryRoot: workspace }] })
    await success("desktop/session/project/bind", { sessionId: "source", projectId: "p1" })
    expect(await success("session/list")).toEqual({ sessions: [{ id: "source", title: "Source", turnCount: completed ? 1 : 0 }] })
    const fork = await call("desktop/session/manage", { sessionId: "source", action: "fork" })
    if (!completed) {
      expect(isRpcSuccess(fork)).toBe(false)
      expect(JSON.stringify(fork)).toMatch(/completed turn/)
      expect((await success("session/list") as { sessions: unknown[] }).sessions).toHaveLength(1)
      return
    }
    expect(isRpcSuccess(fork)).toBe(true)
    if (!isRpcSuccess(fork)) throw new Error("fork failed")
    const childId = (fork.result as { sessionId: string }).sessionId
    expect((await success("session/list") as { sessions: { id: string }[] }).sessions.map((row) => row.id)).toContain(childId)
    expect((await success("session/dashboard") as { sessions: { id: string }[] }).sessions).toHaveLength(2)
    expect(await success("desktop/session/project/state", { sessionId: childId })).toEqual({ sessionId: childId, projectId: "p1" })
    expect(await success("desktop/session/navigation/state")).toMatchObject({ source: { projectId: "p1" }, [childId]: { projectId: "p1" } })
  } finally { await host.close() }
})
