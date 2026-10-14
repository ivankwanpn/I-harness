import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { deriveContextBudget, type ContextBindingMetadata } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { wrapPreparedRequest, type ModelClient } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { createSessionAssembly } from "../src/index.ts"

it("inherited followups copy the rebound window/model while a declared role keeps its own binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-child-binding-")), coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "parent" })
  const calls: string[] = []
  const metadata = (modelId: string, contextWindow: number): ContextBindingMetadata => ({ version: 1, providerId: "route", modelId, protocol: "anthropic-messages", contextWindow, maxOutputTokens: 2048, identityCoverage: "complete", bindingConfigFingerprint: modelId.repeat(64) })
  const client = (modelId: string): ModelClient => {
    const actual = createAnthropicClient({ model: modelId, apiKey: "controlled" })
    return { async *stream() { throw new Error("unprepared") }, async prepare(request) {
      const prepared = await actual.prepare!(request)
      return wrapPreparedRequest(prepared, (_stream, control) => (async function*() { control?.validateBeforeTransport?.(); calls.push(modelId); yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const })())
    } }
  }
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: "parent", approveAll: true, model: client("a"), contextWindow: 200000, maxOutputTokens: 2048, contextMetadata: metadata("a", 200000),
    allowSubagentModelSelection: true, pluginAgents: [{ name: "independent", description: "independent", systemPrompt: "role", tools: [], model: { provider: "route", model: "c" } }],
    resolveRoleModel: async () => ({ status: "ready", binding: { client: client("c"), contextWindow: 60000, maxOutputTokens: 2048, contextMetadata: metadata("c", 60000) } }) })
  try {
    for (const [task_name, agent_type] of [["inherited", "general"], ["declared", "independent"]]) {
      await assembly.tools.execute({ name: "spawn_agent", args: { task_name, agent_type, message: "first", background: true } })
    }
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    await vi.waitFor(() => expect(assembly.tasks().filter(row => row.group === "subagent").every(row => row.status === "completed")).toBe(true))
    const sessions = assembly.subagentState().agentTable.map(row => ({ path: row.path, id: row.sessionId! }))
    expect(sessions).toHaveLength(2)
    assembly.setModelBinding!({ model: client("b"), contextWindow: 50000, maxOutputTokens: 2048, contextMetadata: metadata("b", 50000) })
    for (const session of sessions) await assembly.tools.execute({ name: "followup_task", args: { target: session.path, message: "next" } })
    await vi.waitFor(() => expect(calls).toHaveLength(4))
    for (const session of sessions) {
      const owned = assembly.liveChildSession!(session.id)!
      const snapshot = deriveContextBudget(owned, session.id)!
      expect(snapshot).toMatchObject({ ownerSessionId: session.id, modelId: session.path.endsWith("inherited") ? "b" : "c", contextWindow: session.path.endsWith("inherited") ? 50000 : 60000 })
      expect(snapshot.ownerSessionId).not.toBe("parent")
    }
    expect(calls.filter(model => model === "a")).toHaveLength(1)
    expect(calls.filter(model => model === "b")).toHaveLength(1)
    expect(calls.filter(model => model === "c")).toHaveLength(2)
  } finally { await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
