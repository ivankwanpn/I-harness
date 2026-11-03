import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { it, expect } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDesktopHost } from "../src/host.ts"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"

it.each([true, false])("honors Desktop auto-compaction setting %s with the configured model window", async (auto) => {
  const root = await mkdtemp(join(tmpdir(), "ih-context-host-"))
  let calls = 0
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    calls++
    res.writeHead(200, { "content-type": "text/event-stream" })
    const content = body.includes("You are now acting as a compaction engine") ? checkpointOfLength(600) : "Preserve the user objective and continue the requested work. ".repeat(12)
    res.end("data: " + JSON.stringify({ choices: [{ delta: { content } }] }) + "\n\ndata: [DONE]\n\n")
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing address")
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const settingsPath = join(root, "settings.json")
  const credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify({
    sandboxMode: "read-only", compaction: { auto },
    llm: { providers: { fixture: {
      protocol: "openai-completions", baseURL: "http://127.0.0.1:" + address.port,
      apiKeyEnv: "IH_CONTEXT_TEST_KEY", models: [{ id: "fixture", contextWindow: 100000, maxOutputTokens: 20000 }],
    } }, defaultModel: { provider: "fixture", model: "fixture" } },
  }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_CONTEXT_TEST_KEY: "fixture" } }))
  const frames: RpcMessage[] = []
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    host = await createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath, credentialsPath, onWrite: f => frames.push(f) })
    const request = (id: number, method: string, params: unknown) => host!.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    await request(1, "initialize", {})
    await request(2, "session/create", {})
    const created = frames.find(f => "id" in f && f.id === 2)
    if (!isRpcSuccess(created)) throw new Error("session creation failed")
    const { sessionId } = created.result as { sessionId: string }
    await request(3, "session/prompt", { sessionId, prompt: "context evidence ".repeat(12500) })
    await request(30, "session/prompt", { sessionId, prompt: "continue once" })
    await request(31, "session/prompt", { sessionId, prompt: "continue twice" })
    await request(4, "session/history", { sessionId, afterSeq: 0, limit: 200 })
    const history = frames.find(f => "id" in f && f.id === 4)
    if (!isRpcSuccess(history)) throw new Error("history unavailable")
    const events = (history.result as { events: { type: string }[] }).events
    expect(events.some(e => e.type === "compaction/replacement")).toBe(auto)
    expect(events.some(e => e.type === "session/title")).toBe(true)
    expect(calls).toBe(auto ? 5 : 4) // three main turns, one title, and optional compaction
    expect(isRpcSuccess(frames.find(f => "id" in f && f.id === 3))).toBe(true)
    if (!auto) {
      await request(5, "desktop/session/compact", { sessionId })
      const compact = frames.find(f => "id" in f && f.id === 5)
      expect(isRpcSuccess(compact)).toBe(true)
      if (!isRpcSuccess(compact)) throw new Error("manual compaction unavailable")
      expect(compact.result).toMatchObject({ compacted: true })
      await request(6, "session/history", { sessionId, afterSeq: 0, limit: 200 })
      const durable = frames.find(f => "id" in f && f.id === 6)
      if (!isRpcSuccess(durable)) throw new Error("history unavailable")
      expect((durable.result as { events: { type: string }[] }).events.some(e => e.type === "compaction/replacement")).toBe(true)
    }
  } finally {
    await host?.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
