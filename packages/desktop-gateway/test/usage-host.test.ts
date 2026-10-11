import { expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import type { UsageSnapshot } from "../../usage-stats/src/types.ts"
import { createDesktopHost } from "../src/host.ts"

it("captures real host turns, titles and compaction with provenance, surviving a host restart globally", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-usage-host-"))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  const settingsPath = join(root, "settings.json")
  const credentialsPath = join(root, "credentials.json")
  await writeFile(settingsPath, JSON.stringify({ sandboxMode: "read-only", compaction: { auto: false },
    llm: { providers: { fixture: { protocol: "openai-completions", baseURL: "http://127.0.0.1:1", apiKeyEnv: "IH_USAGE_FIXTURE", models: [{ id: "model-a", contextWindow: 100000 }] } }, defaultModel: { provider: "fixture", model: "model-a" } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_USAGE_FIXTURE: "fake-key" } }))
  const frames: RpcMessage[] = []
  let modelCalls = 0
  const options = { workspace, sessionDir: join(root, "sessions"), settingsPath, credentialsPath, onWrite: (frame: RpcMessage) => frames.push(frame),
    buildProviderClient: () => ({ async *stream() {
      modelCalls++
      yield { type: "usage" as const, usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheCreationTokens: 0, inputTokenSemantics: "includes-cache" as const } }
      yield { type: "text/chunk" as const, text: "Keep the objective and useful facts in this conversation. ".repeat(12) }
      yield { type: "end" as const }
    } }) }
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  let id = 0
  const call = async (method: string, params: unknown = {}) => {
    const requestId = ++id
    await host!.handleLine(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }))
    const reply = frames.find(frame => "id" in frame && frame.id === requestId)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  const query = { start: Date.now() - 60000, end: Date.now() + 60000, timeZone: "UTC", pageSize: 100 }
  try {
    host = await createDesktopHost(options)
    await call("initialize")
    const { sessionId } = await call("session/create") as { sessionId: string }
    await call("desktop/project/sync", { projects: [{ id: "usage-project", name: "Usage project", roots: [workspace], primaryRoot: workspace }] })
    await call("desktop/session/project/bind", { sessionId, projectId: "usage-project" })
    await call("session/prompt", { sessionId, prompt: "private prompt ".repeat(300) })
    await call("desktop/session/compact", { sessionId })
    const stats = await call("desktop/usage/query", { query }) as UsageSnapshot
    expect(modelCalls).toBe(3)
    expect(stats.summary.requests).toBe(3)
    expect(stats.records.every(row => row.workspace === workspace && row.projectId === "usage-project" && row.sessionId === sessionId && row.providerId === "fixture" && row.modelId === "model-a" && row.billing === "api")).toBe(true)
    expect(stats.summary.totalTokens).toBe(315)
    expect((await call("desktop/usage/query", { query: { ...query, projectId: "another-project" } }) as UsageSnapshot).summary.requests).toBe(0)
    expect(JSON.stringify(stats)).not.toMatch(/private prompt|fake-key|useful facts/)
    await host.close()
    host = await createDesktopHost({ ...options, workspace: root, sessionDir: join(root, "other-sessions") })
    await call("initialize")
    const restarted = await call("desktop/usage/query", { query }) as UsageSnapshot
    expect(restarted.summary.requests).toBe(3)
    expect(restarted.records.map(row => row.id).sort()).toEqual(stats.records.map(row => row.id).sort())
  } finally {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
