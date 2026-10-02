import { expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../src/host.ts"

it.each(["off", "mixed", "only"] as const)("forwards saved %s Code Mode and normalized limits through the Desktop host", async (mode) => {
  const bodies: Array<{ tools?: Array<{ function: { name: string } }> }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()))
    const delta = mode !== "off" && bodies.length === 1
      ? { tool_calls: [{ index: 0, id: "code-fixture", function: { name: "code_exec", arguments: JSON.stringify({ code: 'text("long result for clamp"); await tools.list_dir({path:"."});' }) } }] }
      : { content: "done" }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  const originalFetch = globalThis.fetch
  const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== origin) throw new Error("Code Mode fixture refused non-loopback provider request")
    return originalFetch(input, init)
  })
  const root = await mkdtemp(join(tmpdir(), "ih-code-desktop-"))
  const workspace = join(root, "workspace"); await mkdir(workspace)
  const settingsPath = join(root, "settings.json")
  const credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: "read-only", codeMode: { mode, defaultOutputTokens: 1 }, llm: { providers: { fixture: { protocol: "openai-completions", baseURL: `${origin}/v1`, apiKeyEnv: "IH_CODE_FIXTURE_KEY", models: [{ id: "fixture", contextWindow: 272000 }] } }, defaultModel: { provider: "fixture", model: "fixture" } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_CODE_FIXTURE_KEY: "fixture" } }))
  const frames: RpcMessage[] = []
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  let id = 0
  const call = async (method: string, params = {}) => {
    const requestId = ++id
    await host!.handleLine(encodeFrame(makeRequest(requestId, method, params)))
    const reply = frames.find(frame => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try {
    host = await createDesktopHost({ workspace, settingsPath, credentialsPath, sessionDir: join(root, "sessions"), onWrite: frame => frames.push(frame) })
    await call("initialize")
    const { sessionId } = await call("session/create") as { sessionId: string }
    await call("session/prompt", { sessionId, prompt: "run fixture" })
    const names = bodies[0]!.tools!.map(tool => tool.function.name)
    if (mode === "only") expect(names).toEqual(["code_exec", "code_wait"])
    else { expect(names).toContain("list_dir"); expect(names.includes("code_exec")).toBe(mode === "mixed") }
    const { events } = await call("session/history", { sessionId, afterSeq: 0, limit: 200 }) as { events: Array<{ type: string; output?: unknown }> }
    if (mode !== "off") {
      expect(events.some(event => event.type === "code/dispatch")).toBe(true)
      expect(events.find(event => event.type === "tool/result")).toMatchObject({ output: { status: "completed", text: "long", truncated: true } })
    } else expect(events.some(event => event.type.startsWith("code/"))).toBe(false)
  } finally {
    await host?.close()
    fetchGuard.mockRestore()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
