// Gemini Developer API fixture exercises the native desktop settings and conversation RPCs.
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

it("uses models discovered via a Gemini API key for a real desktop conversation", async () => {
  const requests: { path: string; key?: string; bearer?: string }[] = []
  const sentCaps: (number | undefined)[] = []
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url!, key: req.headers["x-goog-api-key"] as string | undefined, bearer: req.headers.authorization })
    if (req.url === "/v1beta/models") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ models: [{ name: "models/studio-flash", displayName: "Studio Flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 65536, outputTokenLimit: 8192 }] }))
      return
    }
    if (req.method === "POST" && req.url === "/v1beta/models/studio-flash:streamGenerateContent?alt=sse") {
      let payload = ""
      for await (const block of req) payload += block
      const input = JSON.parse(payload) as { contents: { parts: { text?: string }[] }[]; generationConfig?: { maxOutputTokens?: number } }
      sentCaps.push(input.generationConfig?.maxOutputTokens)
      if (input.contents.some(row => row.parts.some(part => part.text === "Confirm the Gemini route."))) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end("data: " + JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Gemini route confirmed." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 321, cachedContentTokenCount: 64, candidatesTokenCount: 8, totalTokenCount: 329 } }) + "\n\n")
        return
      }
    }
    res.writeHead(404).end()
  })
  const root = await mkdtemp(join(tmpdir(), "ih-gemini-studio-"))
  const workspace = join(root, "project")
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  try {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Missing fixture port")
    await mkdir(workspace)
    const settingsPath = join(root, "settings.json")
    await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: "read-only", compaction: { auto: false } }))
    const frames: RpcMessage[] = []
    const open = () => createDesktopHost({ workspace, sessionDir: join(root, "sessions"), settingsPath, credentialsPath: join(root, "keys.json"), onWrite: frame => frames.push(frame) })
    host = await open()
    let serial = 0
    async function call<T>(method: string, params: unknown = {}): Promise<T> {
      const id = ++serial
      await host!.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      const reply = frames.find(frame => "id" in frame && frame.id === id)
      if (!isRpcSuccess(reply)) throw Error(method + " failed: " + JSON.stringify(reply))
      return reply.result as T
    }
    const id = "studio"
    await call("initialize")
    await call("desktop/provider/mutate", { action: "provider/create", id, fields: { baseURL: "http://127.0.0.1:" + address.port + "/v1beta/", protocol: "gemini" } })
    await call("desktop/provider/mutate", { action: "key/set", id, value: "local-fixture-key" })
    const models = await call<{ id: string; name: string; inputTokenLimit: number; outputTokenLimit: number; protocol: string }[]>("desktop/provider/probe", { id, token: "local-model-list" })
    expect(models).toEqual([{ id: "studio-flash", name: "Studio Flash", inputTokenLimit: 65536, outputTokenLimit: 8192, protocol: "gemini" }])
    const { id: model, ...fields } = models[0]!
    await call("desktop/provider/mutate", { action: "model/add", id, model, fields })
    await call("desktop/provider/mutate", { action: "default/set", id, model })
    await host.close()
    host = await open()
    await call("initialize")
    const directory = await call<{ id: string; models: unknown[] }[]>("desktop/provider/directory")
    expect(directory.find(row => row.id === id)?.models).toContainEqual(expect.objectContaining({ id: model, inputTokenLimit: 65536, outputTokenLimit: 8192 }))
    const { sessionId } = await call<{ sessionId: string }>("session/create")
    await call("desktop/project/sync", { projects: [{ id: "test", name: "Test", roots: [workspace], primaryRoot: workspace }] })
    await call("desktop/session/project/bind", { sessionId, projectId: "test" })
    await call("session/prompt", { sessionId, prompt: "Confirm the Gemini route." })
    const { events } = await call<{ events: { type: string; text?: string }[] }>("session/history", { sessionId, afterSeq: 0, limit: 100 })
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant/message", text: "Gemini route confirmed." }))
    expect(events).toContainEqual(expect.objectContaining({ type: "turn/end" }))
    expect(sentCaps).toEqual([undefined])
    const state = await call<{ observation: { dimensions: { dimension: string; limit?: number }[] } }>("session/context", { sessionId })
    expect(state.observation.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "input", limit: 65536 }),
      expect.objectContaining({ dimension: "output", limit: 8192 }),
    ]))
    expect(state.observation.dimensions.find(row => row.dimension === "context")?.limit).toBeUndefined()
    expect(requests).toEqual([
      { path: "/v1beta/models", key: "local-fixture-key", bearer: undefined },
      { path: "/v1beta/models/studio-flash:streamGenerateContent?alt=sse", key: "local-fixture-key", bearer: undefined },
    ])
  } finally {
    try { await host?.close() } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }
}, 60000)
