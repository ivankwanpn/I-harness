import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { isRpcFailure, isRpcSuccess, type RpcMessage, type RpcSuccess, type RpcFailure } from "@i-harness/sdk"
import type { SessionEvent } from "@i-harness/core-session"
import { createDesktopHost } from "../../src/host.ts"

/** Real host, lock-enabled coordinator and loopback provider, all under root.
 * The caller owns root and decides whether to retain or remove its evidence. */
export async function createRevokedPromptFixture(root: string) {
  const workspace = join(root, "workspace"), sessionDir = join(root, "sessions"), settingsPath = join(root, "settings.json"), credentialsPath = join(root, "credentials.json")
  await mkdir(workspace, { recursive: true })
  const httpRequests: { url: string; body: unknown }[] = [], frames: RpcMessage[] = []
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    httpRequests.push({ url: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Owned allowed completion" } }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve))
  const address = provider.address()
  if (!address || typeof address === "string") throw new Error("Owned loopback provider did not listen")
  const origin = `http://127.0.0.1:${address.port}`
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: "workspace-write", compaction: { auto: false }, llm: {
    providers: { owned: { protocol: "openai-completions", baseURL: origin, apiKeyEnv: "IH_OWNED_REVOKED_PROMPT", models: [{ id: "owned-model" }] } },
    defaultModel: { provider: "owned", model: "owned-model" },
  } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_OWNED_REVOKED_PROMPT: "owned-loopback-only" } }))
  let host: Awaited<ReturnType<typeof createDesktopHost>>
  try { host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: frame => frames.push(frame) }) }
  catch (error) { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); throw error }
  let requestId = 0, closed = false
  async function call(method: string, params: unknown = {}): Promise<RpcSuccess | RpcFailure> {
    const id = ++requestId
    await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    const reply = frames.find(frame => "id" in frame && frame.id === id)
    if (!isRpcSuccess(reply) && !isRpcFailure(reply)) throw new Error(`Missing owned reply for ${method}`)
    return reply
  }
  async function success<T = unknown>(method: string, params?: unknown): Promise<T> {
    const reply = await call(method, params)
    if (!isRpcSuccess(reply)) throw new Error(reply.error.message)
    return reply.result as T
  }
  const projectId = "owned-revoked-project"
  async function removedSession() {
    await success("initialize")
    await success("desktop/project/configure", { project: { id: projectId, name: "Owned removed project", primaryRoot: workspace, roots: [workspace] } })
    const { sessionId } = await success<{ sessionId: string }>("session/create", { title: "Owned revoked prompt" })
    await success("desktop/session/project/bind", { sessionId, projectId })
    await success("desktop/project/revoke", { projectId })
    return sessionId
  }
  return { root, workspace, sessionDir, settingsPath, credentialsPath, origin, projectId, httpRequests, frames, call, success, removedSession,
    rawEvents: async (sessionId: string): Promise<SessionEvent[]> => (await readFile(join(sessionDir, `${sessionId}.jsonl`), "utf8")).trim().split("\n").slice(1).map(line => JSON.parse(line)),
    async close() {
      if (closed) return
      await host.close()
      provider.closeAllConnections()
      await new Promise<void>(resolve => provider.close(() => resolve()))
      closed = true
    },
  }
}
