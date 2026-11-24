import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createForkOperation, createSessionCoordinator, type ForkOutcome, type ForkPrepareResult } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

it("keeps files, session state and search isolated across two live workspaces with the same session ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-shared-workspaces-")); roots.push(root)
  const hosts: Awaited<ReturnType<typeof createDesktopHost>>[] = []
  async function openWorkspace(label: string) {
    const workspace = join(root, label), sessionDir = join(root, label + "-sessions")
    await mkdir(workspace)
    await writeFile(join(workspace, "local.txt"), `file-content-${label}`)
    const writer = createSessionCoordinator(createJsonlBackend(sessionDir))
    try {
      await writer.create({ sessionId: "duplicate", title: label })
      await writer.append("duplicate", [{ type: "user/message", text: label }])
    } finally { await writer.close() }
    const replies = new Map<string | number, RpcMessage>()
    const host = await createDesktopHost({ workspace, sessionDir, settingsPath: join(root, "settings.json"),
      onWrite: frame => { if ("id" in frame && frame.id !== null) replies.set(frame.id, frame) } })
    hosts.push(host)
    let id = 0
    const request = async (method: string, params: unknown = {}) => {
      const requestId = ++id
      await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
      const result = replies.get(requestId)
      if (!result || !isRpcSuccess(result)) throw Error(JSON.stringify(result))
      return result.result
    }
    await request("initialize")
    return { request, host }
  }
  try {
    const [one, two] = await Promise.all([openWorkspace("alpha"), openWorkspace("bravo")])
    const inspect = async (side: typeof one, label: string, foreign: string) => {
      expect(await side.request("session/list")).toMatchObject({ sessions: [{ id: "duplicate", title: label }] })
      expect(await side.request("desktop/review/file", { path: "local.txt" })).toMatchObject({ kind: "text", text: `file-content-${label}` })
      expect(await side.request("desktop/session/search", { query: foreign })).toMatchObject({ hits: [] })
      expect(await side.request("desktop/session/search", { query: label })).toMatchObject({ hits: [expect.objectContaining({ sessionId: "duplicate" })] })
    }
    await Promise.all([inspect(one, "alpha", "bravo"), inspect(two, "bravo", "alpha")])
    await one.request("desktop/session/manage", { action: "pin", sessionId: "duplicate" })
    expect(await two.request("desktop/session/navigation/state")).toMatchObject({ duplicate: { pinned: false } })
    if (process.platform === "win32") {
      await Promise.all([{ side: one, label: "alpha" }, { side: two, label: "bravo" }].map(async ({ side, label }) => {
        const terminal = await side.request("desktop/terminal/open", { shell: "cmd" }) as { id: string }
        try {
          await side.request("desktop/terminal/write", { id: terminal.id, data: "type local.txt\r" })
          await vi.waitFor(async () => {
            const { data } = await side.request("desktop/terminal/read", { id: terminal.id }) as { data: string }
            expect(data).toContain(`file-content-${label}`)
          }, { timeout: 10000, interval: 50 })
        } finally { await side.request("desktop/terminal/close", { id: terminal.id }) }
      }))
    }
    await one.host.close()
    await inspect(two, "bravo", "alpha")
  } finally { await Promise.all(hosts.map(host => host.close())) }
}, 60_000)

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
    // Durable session rows carry the profile's updatedAt (4004bc54); the row
    // must still identify the original session, its title and its turn count.
    expect(await success("session/list")).toEqual({ sessions: [{ id: "source", title: "Source", turnCount: completed ? 1 : 0, updatedAt: expect.any(Number) }] })
    // 5c4e5e72 retired the `desktop/session/manage` fork action and moved the
    // product path to session/fork/prepare + session/fork/begin; the completed-
    // turn precondition is the core-session `no-completed-boundary` refusal
    // (see session-management.test.ts:199-225, packages/core-session/src/conversation/seed-selection.ts:50).
    const prepared = await success("session/fork/prepare", { version: 1, sourceSessionId: "source" }) as ForkPrepareResult
    expect(prepared.kind).toBe("prepared")
    if (prepared.kind !== "prepared") throw new Error("fork preparation refused")
    const operation = createForkOperation(prepared.prepared, { operationId: "project-fork", targetSessionId: "child", createdAt: new Date().toISOString() })
    const fork = await success("session/fork/begin", { operation }) as ForkOutcome
    if (!completed) {
      expect(fork).toMatchObject({ kind: "refused", reason: "no-completed-boundary" })
      expect((await success("session/list") as { sessions: unknown[] }).sessions).toHaveLength(1)
      return
    }
    expect(fork.kind).toBe("ready")
    if (fork.kind !== "ready" && fork.kind !== "adopted") throw new Error("fork refused")
    const childId = fork.sessionId
    expect((await success("session/list") as { sessions: { id: string }[] }).sessions.map((row) => row.id)).toContain(childId)
    expect((await success("session/dashboard") as { sessions: { id: string }[] }).sessions).toHaveLength(2)
    expect(await success("desktop/session/project/state", { sessionId: childId })).toEqual({ sessionId: childId, projectId: "p1" })
    expect(await success("desktop/session/navigation/state")).toMatchObject({ source: { projectId: "p1" }, [childId]: { projectId: "p1" } })
  } finally { await host.close() }
})
