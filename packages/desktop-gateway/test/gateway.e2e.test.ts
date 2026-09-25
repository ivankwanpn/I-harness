import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HarnessClient, type ServerInfo } from "@i-harness/sdk"

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)))
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href
const GATEWAY_ENTRY = join(REPO_ROOT, "packages", "desktop-gateway", "src", "cli.ts")

async function fixture(mode: "text" | "approval" = "text") {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-gateway-e2e-"))
  const workspace = join(root, "workspace")
  const sessionDir = join(root, "sessions")
  const configDir = join(root, "config")
  mkdirSync(workspace)
  mkdirSync(sessionDir)
  mkdirSync(configDir)
  const outsidePath = join(root, "outside.txt")
  let providerCalls = 0
  const provider = createServer((req, res) => {
    req.resume()
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end()
      return
    }
    providerCalls++
    const delta = mode === "approval" && providerCalls === 1
      ? { tool_calls: [{ index: 0, id: "call_write", function: { name: "write", arguments: JSON.stringify({ path: outsidePath, text: "no" }) } }] }
      : { content: "fixture answer" }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const address = provider.address()
  if (address === null || typeof address === "string") throw new Error("provider did not listen")
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({
    sandboxMode: "workspace-write",
    llm: {
      providers: {
        fixture: { protocol: "openai-completions", baseURL: `http://127.0.0.1:${address.port}`, apiKeyEnv: "FIXTURE_API_KEY", models: [{ id: "fixture-model" }] },
      },
      defaultModel: { provider: "fixture", model: "fixture-model" },
    },
  }), "utf8")
  writeFileSync(join(configDir, "credentials.json"), JSON.stringify({ refs: { FIXTURE_API_KEY: "fixture-key" } }), "utf8")
  const child = spawn(process.execPath, ["--import", TSX_LOADER, GATEWAY_ENTRY, "--session-dir", sessionDir], {
    cwd: workspace,
    env: { ...process.env, IH_CONFIG_DIR: configDir },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const client = new HarnessClient(child.stdout, child.stdin, { child })
  return {
    child, client, outsidePath,
    async close() {
      await client.close()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      provider.closeAllConnections()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe("desktop-gateway subprocess keeps SDK v3 compatible", () => {
  it("initializes, creates, prompts, replays and cancels through existing SDK methods", async () => {
    const f = await fixture()
    try {
      const info = await f.client.initialize() as ServerInfo
      expect(info.protocolVersion).toBe(3)
      expect(info.capabilities["desktop-sandbox"]).toEqual(["1"])
      expect(info.capabilities["desktop-interaction"]).toEqual(["1"])
      expect(info.capabilities["desktop-review"]).toEqual(["1"])
      expect(await f.client.request("desktop/sandbox/state", {})).toEqual({ mode: "workspace-write", source: "settings", wired: true })
      const created = await f.client.createSession()
      expect((await f.client.listSessions()).sessions.some((row) => row.id === created.sessionId)).toBe(true)
      await f.client.request("session/prompt", { sessionId: created.sessionId, prompt: "say hi" }, 30_000)
      const history = await f.client.history(created.sessionId)
      expect(history.events.some((event) => event.type === "assistant/message" && event.text.includes("fixture answer"))).toBe(true)
      expect(await f.client.cancel(created.sessionId)).toMatchObject({ cancelled: false, reason: "not-running" })
    } finally { await f.close() }
  }, 40_000)

  it("ignores malformed input and rejects unknown methods without losing the connection", async () => {
    const f = await fixture()
    try {
      await f.client.initialize()
      f.child.stdin.write("{bad frame\n")
      await expect(f.client.request("desktop/not-a-method", {})).rejects.toMatchObject({ code: -32601 })
      const state = await f.client.request("desktop/sandbox/state", {})
      expect(state).toMatchObject({ wired: true })
    } finally { await f.close() }
  }, 30_000)

  it("recovers a pending approval after a renderer listener detaches, then replies during the prompt", async () => {
    const f = await fixture("approval")
    try {
      await f.client.initialize()
      let wake!: () => void
      const arrived = new Promise<void>((resolve) => { wake = resolve })
      const off = f.client.onNotification((frame) => {
        if (frame.method === "desktop/interaction/request") wake()
      })
      const prompt = f.client.request("session/prompt", { sessionId: "s1", prompt: "write outside" }, 30_000)
      const denied = expect(prompt).rejects.toThrow(/denied by user/)
      await Promise.race([arrived, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("approval did not arrive")), 10_000))])
      off() // Renderer reload: the host stays alive; pending must remain authoritative.
      const pending = await f.client.request("desktop/interaction/pending", { sessionId: "s1" }) as Array<{
        requestId: string; sessionId: string; kind: string
      }>
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ sessionId: "s1", kind: "approval" })
      expect(await f.client.request("desktop/interaction/reply", {
        requestId: pending[0]!.requestId,
        sessionId: "s1",
        decision: { kind: "approval", approved: false },
      })).toEqual({ accepted: true })
      await denied
      expect(existsSync(f.outsidePath)).toBe(false)
      expect(await f.client.request("desktop/interaction/pending", { sessionId: "s1" })).toEqual([])
    } finally { await f.close() }
  }, 40_000)
})
