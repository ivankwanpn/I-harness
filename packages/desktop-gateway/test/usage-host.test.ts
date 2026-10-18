import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import {checkpointOfLength} from '../../compaction/test/fixtures/checkpoint.ts'
import type {LLMRequest} from '@i-harness/llm-seam'
import { expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import type { UsageSnapshot } from "../../usage-stats/src/types.ts"
import { createDesktopHost } from "../src/host.ts"
import { createRuntimeDiagnostics } from "../../desktop/src/main/runtime-diagnostics.ts"
import type { DesktopEvent } from "../../desktop/src/shared/bridge.ts"

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
    buildProviderClient: (profile: import("@i-harness/provider").ProviderProfile, model?: string) => (controlledModel(request => ({ async *stream(request:LLMRequest) {
      modelCalls++
      yield { type: "usage" as const, usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheCreationTokens: 0, inputTokenSemantics: "includes-cache" as const } }
      yield { type: "text/chunk" as const, text: String(request.messages.at(-1)?.content).includes("You are now acting as a compaction engine") ? checkpointOfLength(600) : "Keep the objective and useful facts in this conversation. ".repeat(12) }
      yield { type: "end" as const }
    } } as import('@i-harness/llm-seam').ModelClient).stream(request), { modelId: model ?? profile.defaultModel, providerId: profile.name, executionIdentity: profile.executionIdentity })) }
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
    expect(stats.records.every(row => row.requestMetrics?.coverage === "complete")).toBe(true)
    const diagnostics = frames.filter(frame => "method" in frame && frame.method === "desktop/context/diagnostic")
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ params: expect.objectContaining({ sessionId, projectId: "usage-project", requestMetrics: expect.objectContaining({ version: 1, coverage: "complete" }) }) })]))
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ params: expect.objectContaining({ sessionId, compaction: expect.objectContaining({ operation: "summary", contextWindow: 100000 }) }) })]))
    expect(JSON.stringify(diagnostics)).not.toMatch(/private prompt|fake-key|useful facts/)
    const journal = createRuntimeDiagnostics(join(root, "runtime-diagnostics"))
    for (const frame of frames) if ("method" in frame && ["session/event", "session/status", "desktop/context/diagnostic"].includes(frame.method))
      journal.observe({ kind: "sdk/notification", workspaceId: "controlled-workspace", method: frame.method, params: frame.params } as DesktopEvent)
    await journal.flush()
    const entries = (await createRuntimeDiagnostics(join(root, "runtime-diagnostics")).list()).entries
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "context/request", sessionId, projectId: "usage-project", requestMetrics: expect.objectContaining({ coverage: "complete" }) }),
      expect.objectContaining({ kind: "context/budget", sessionId, contextAdmission: expect.objectContaining({ version: 2, estimate: expect.objectContaining({ kind:'estimated',source: "projected-heuristic" }), dimensions:expect.arrayContaining([expect.objectContaining({dimension:'context',limit:100000})]) }) }),
      expect.objectContaining({ kind: "context/compaction", sessionId, compaction: expect.objectContaining({ operation: "summary", contextWindow: 100000 }) }),
    ]))
    expect(JSON.stringify(entries)).not.toMatch(/private prompt|fake-key|useful facts/)
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
