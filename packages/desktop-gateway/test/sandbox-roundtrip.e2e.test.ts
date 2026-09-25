import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost, type DesktopHost } from "../src/host.ts"

type Mode = "read-only" | "workspace-write"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture(mode: Mode, target: "inside" | "outside") {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-confinement-"))
  roots.push(root)
  const workspace = join(root, "workspace")
  const sessionDir = join(root, "sessions")
  mkdirSync(workspace)
  mkdirSync(sessionDir)
  const targetPath = target === "inside" ? "inside.txt" : join(root, "outside.txt")
  let providerCalls = 0
  const server = createServer((req, res) => {
    req.resume()
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end()
      return
    }
    providerCalls++
    const delta = providerCalls === 1
      ? { tool_calls: [{ index: 0, id: "call_write", function: { name: "write", arguments: JSON.stringify({ path: targetPath, text: "from agent" }) } }] }
      : { content: "finished" }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture server unavailable")
  const settingsPath = join(root, "settings.json")
  writeFileSync(settingsPath, JSON.stringify({
    sandboxMode: mode,
    llm: {
      providers: {
        fixture: {
          protocol: "openai-completions",
          baseURL: `http://127.0.0.1:${address.port}`,
          apiKeyEnv: "FIXTURE_API_KEY",
          models: [{ id: "fixture-model" }],
        },
      },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    },
  }), "utf8")
  writeFileSync(join(root, "credentials.json"), JSON.stringify({ refs: { FIXTURE_API_KEY: "fixture-key" } }), "utf8")
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: (frame) => { frames.push(frame) } })
  return {
    root, workspace, targetPath, frames, host, providerCalls: () => providerCalls,
    async close() {
      await host.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections()
    },
  }
}

async function request(host: DesktopHost, frames: RpcMessage[], id: number, method: string, params: unknown) {
  await host.handleLine(encodeFrame(makeRequest(id, method, params)))
  const reply = frames.find((frame) => "id" in frame && frame.id === id)
  expect(isRpcSuccess(reply)).toBe(true)
  if (!isRpcSuccess(reply)) throw new Error(`${method} failed`)
  return reply.result
}

async function runWrite(mode: Mode, target: "inside" | "outside") {
  const f = await fixture(mode, target)
  try {
    await request(f.host, f.frames, 1, "initialize", {})
    const prompt = f.host.handleLine(encodeFrame(makeRequest(2, "session/prompt", { sessionId: "s1", prompt: "write the file" })))
    if (target === "outside") {
      const deadline = Date.now() + 10_000
      while (!f.frames.some((frame) => "method" in frame && frame.method === "desktop/interaction/request")) {
        if (Date.now() > deadline) throw new Error("approval request did not arrive")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const notice = f.frames.find((frame) => "method" in frame && frame.method === "desktop/interaction/request") as {
        params: { requestId: string; sessionId: string }
      }
      expect(existsSync(f.targetPath)).toBe(false)
      await request(f.host, f.frames, 3, "desktop/interaction/reply", {
        requestId: notice.params.requestId,
        sessionId: notice.params.sessionId,
        decision: { kind: "approval", approved: true },
      })
    }
    await prompt
    const result = f.frames.find((frame) => "method" in frame && frame.method === "session/event"
      && (frame.params as { event?: { type?: string } })?.event?.type === "tool/result") as {
        params: { event: { output: unknown } }
      } | undefined
    expect(result).toBeDefined()
    expect(f.providerCalls()).toBeGreaterThanOrEqual(2)
    return { output: result!.params.event.output, exists: existsSync(target === "inside" ? join(f.workspace, f.targetPath) : f.targetPath) }
  } finally { await f.close() }
}

describe("Desktop host uses the existing sandbox at a real tool call", () => {
  it("read-only denies a workspace write even when the model requests it", async () => {
    const result = await runWrite("read-only", "inside")
    expect(result.exists).toBe(false)
    expect(JSON.stringify(result.output)).toContain("SANDBOX_DENIED")
  }, 30_000)

  it("workspace-write permits an in-workspace write", async () => {
    const result = await runWrite("workspace-write", "inside")
    expect(result.exists).toBe(true)
    expect(result.output).toMatchObject({ ok: true })
  }, 30_000)

  it("workspace-write denies an outside write after explicit human approval", async () => {
    const result = await runWrite("workspace-write", "outside")
    expect(result.exists).toBe(false)
    expect(JSON.stringify(result.output)).toContain("SANDBOX_DENIED")
  }, 30_000)
})
