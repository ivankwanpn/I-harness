import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("Desktop host passes the existing sandbox mode to the assembly", () => {
  it("records this host's read-only construction mode in a new durable session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-desktop-sandbox-"))
    roots.push(root)
    const workspace = join(root, "workspace")
    const sessionDir = join(root, "sessions")
    const settingsPath = join(root, "settings.json")
    mkdirSync(workspace)
    mkdirSync(sessionDir)
    const server = createServer((req, res) => {
      req.resume()
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n')
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("fixture address unavailable")
    writeFileSync(settingsPath, JSON.stringify({
      sandboxMode: "read-only",
      llm: {
        providers: {
          fixture: {
            protocol: "openai-completions",
            baseURL: "http://127.0.0.1:" + address.port,
            apiKeyEnv: "FIXTURE_API_KEY",
            models: [{ id: "fixture-model" }],
          },
        },
        defaultModel: { provider: "fixture", model: "fixture-model" },
      },
    }), "utf8")
    writeFileSync(join(root, "credentials.json"), JSON.stringify({ refs: { FIXTURE_API_KEY: "fixture-key" } }), "utf8")
    const frames: RpcMessage[] = []
    const host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: (frame) => frames.push(frame) })
    const request = async (id: number, method: string, params: unknown) => {
      await host.handleLine(encodeFrame(makeRequest(id, method, params)))
      const reply = frames.find((frame) => "id" in frame && frame.id === id)
      expect(isRpcSuccess(reply)).toBe(true)
      if (!isRpcSuccess(reply)) throw new Error(`${method} failed`)
      return reply.result
    }
    try {
      await request(1, "initialize", {})
      const created = await request(2, "session/create", {}) as { sessionId: string }
      // Reading history is now pure. Execute a turn to construct its sandbox.
      await request(3, "session/prompt", { sessionId: created.sessionId, prompt: "hello" })
      const history = await request(4, "session/history", { sessionId: created.sessionId }) as {
        events: Array<{ type: string; mode?: string }>
      }
      expect(history.events).toContainEqual(expect.objectContaining({ type: "sandbox/mode", mode: "read-only" }))
    } finally {
      await host.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
