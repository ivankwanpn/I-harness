import { expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

it("uses the changed role model for a new child in the same Desktop session", async () => {
  const models: string[] = []
  let spawn = true
  let childNumber = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    models.push(body.model)
    let delta: unknown = { content: "done" }
    if (body.model === "parent" && spawn) {
      spawn = false
      delta = { tool_calls: [{ index: 0, id: `spawn-${++childNumber}`, function: { name: "spawn_agent", arguments: JSON.stringify({ task_name: `child${childNumber}`, agent_type: "explore", message: "say done", background: false }) } }] }
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const root = await mkdtemp(join(tmpdir(), "ih-role-host-"))
  const workspace = join(root, "workspace"); await mkdir(workspace)
  const settingsPath = join(root, "settings.json")
  await writeFile(settingsPath, JSON.stringify({ plugins: { subagentModel: true }, sandboxMode: "read-only", llm: { providers: { fixture: { protocol: "openai-completions", baseURL: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "parent", contextWindow: 272000 }] } }, defaultModel: { provider: "fixture", model: "parent" } } }))
  const originalFetch = globalThis.fetch
  const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== `http://127.0.0.1:${address.port}`) throw new Error("Fixture refused a non-loopback provider request")
    return originalFetch(input, init)
  })
  const frames: RpcMessage[] = []
  let approvalId = 1000
  const host = await createDesktopHost({ workspace, settingsPath, sessionDir: join(root, "sessions"), onWrite: (frame) => {
    frames.push(frame)
    if ("method" in frame && frame.method === "desktop/interaction/request") {
      const pending = frame.params as { requestId: string; sessionId: string; payload: { name?: string } }
      queueMicrotask(() => { void host.handleLine(encodeFrame(makeRequest(++approvalId, "desktop/interaction/reply", { requestId: pending.requestId, sessionId: pending.sessionId, decision: { kind: "approval", approved: pending.payload.name === "spawn_agent" } }))) })
    }
  } })
  let id = 0
  async function call(method: string, params = {}) {
    const requestId = ++id
    await host.handleLine(encodeFrame(makeRequest(requestId, method, params)))
    const reply = frames.find((frame) => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try {
    await call("initialize")
    await call("desktop/provider/mutate", { action: "key/set", id: "fixture", value: "test-only-key" })
    const { sessionId } = await call("session/create") as { sessionId: string }
    await call("desktop/subagents/mutate", { action: "role/set", role: "explore", selection: { provider: "fixture", model: "small-one" } })
    await call("session/prompt", { sessionId, prompt: "spawn an explorer" })
    expect(models).toContain("small-one")
    await call("desktop/subagents/mutate", { action: "role/set", role: "explore", selection: { provider: "fixture", model: "small-two" } })
    spawn = true
    await call("session/prompt", { sessionId, prompt: "spawn another explorer" })
    expect(models).toContain("small-two")
  } finally {
    await host.close()
    fetchGuard.mockRestore()
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
