import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { RewindStore, sha256Hex } from "@i-harness/rewind"
import { encodeFrame, makeRequest, isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"
it.each(["conversation", "all", "files"] as const)("previews and rewinds a cold session without a configured model (%s)", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "ih-rewind-host-"))
  const workspace = join(root, "workspace"); const sessionDir = join(root, "sessions")
  await mkdir(workspace); await mkdir(sessionDir)
  const backend = createJsonlBackend(sessionDir)
  const coordinator = createSessionCoordinator(backend)
  await coordinator.create({ sessionId: "s" })
  await coordinator.append("s", [{ type: "turn/start", seq: 0 }, { type: "user/message", seq: 1, text: "hello" }, { type: "turn/end", seq: 2 }])
  await coordinator.close()
  const store = new RewindStore({ root: sessionDir, sessionId: "s", workspace })
  const path = join(workspace, "tracked.txt")
  await writeFile(path, "after")
  const preBlob = await store.writeBlob(new TextEncoder().encode("before"))
  await store.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "hello", files: [{ path: "tracked.txt", status: "modified", preBlob, afterHash: sha256Hex(new TextEncoder().encode("after")) }] })
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath: join(root, "settings.json"), onWrite: (frame) => frames.push(frame) })
  let id = 0
  const call = async (method: string, params: unknown) => {
    const requestId = ++id
    await host.handleLine(encodeFrame(makeRequest(requestId, method, params)))
    const reply = frames.find((frame) => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try {
    await call("initialize", {})
    expect(await call("desktop/rewind/points", { sessionId: "s" })).toEqual([{ turnIndex: 0, preview: "hello", files: 1 }])
    const plan = await call("desktop/rewind/plan", { sessionId: "s", target: 0, mode }) as { fingerprint: string }
    expect(await call("desktop/rewind/execute", { sessionId: "s", target: 0, mode, fingerprint: plan.fingerprint })).toMatchObject({ eventAppended: true, truncated: mode !== "files" })
    expect(await readFile(path, "utf8")).toBe(mode === "conversation" ? "after" : "before")
    expect((await backend.read("s")).events.at(-1)).toMatchObject({ type: "rewind/point", seq: 3, anchorSeq: 0 })
  } finally { await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
