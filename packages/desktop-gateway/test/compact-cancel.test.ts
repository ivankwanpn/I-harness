import { it, expect } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDesktopHost } from "../src/host.ts"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"

it.each(["cancel", "shutdown"])("interrupts a stalled manual summarizer on %s", async (action) => {
  const root = await mkdtemp(join(tmpdir(), "ih-compact-cancel-"))
  let arrived!: () => void
  const started = new Promise<void>(r => { arrived = r })
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(": pending\n\n")
    arrived()
  })
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("address missing")
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const sessionDir = join(root, "sessions")
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
  const { id: sessionId } = await coordinator.create()
  await coordinator.append(sessionId, [{ type: "user/message", text: "Remember this task. ".repeat(200), seq: 0 }])
  await coordinator.close()
  const settingsPath = join(root, "settings.json")
  const credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: "read-only", llm: {
    providers: { fixture: { protocol: "openai-completions", baseURL: "http://127.0.0.1:" + address.port, apiKeyEnv: "IH_COMPACT_TEST", models: [{ id: "fixture", contextWindow: 100000 }] } },
    defaultModel: { provider: "fixture", model: "fixture" },
  } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_COMPACT_TEST: "fixture" } }))
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: f => frames.push(f) })
  const call = (id: number, method: string, params: unknown) => host.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await call(1, "initialize", {})
    const compact = call(2, "desktop/session/compact", { sessionId })
    await Promise.race([started, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("summarizer did not start")), 5000) })])
    clearTimeout(timer)
    if (action === "cancel") {
      await call(3, "session/cancel", { sessionId })
      const cancel = frames.find(f => "id" in f && f.id === 3)
      if (!isRpcSuccess(cancel)) throw new Error("cancel failed")
      expect(cancel.result).toMatchObject({ cancelled: true })
    } else { await host.close() }
    await compact
    await host.close()
  } finally {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
