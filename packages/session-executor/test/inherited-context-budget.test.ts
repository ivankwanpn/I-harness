import { afterEach as afterFixture } from 'vitest'
afterFixture(() => vi.unstubAllGlobals())
import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { deriveContextBudget } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { type ModelClient } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { SettingsStore } from "@i-harness/settings"
import { createProviderRuntime } from "../../provider-runtime/src/index.ts"
import { createProviderRegistry } from "../../provider/src/index.ts"
import { createCredentialStore } from "../../credentials/src/index.ts"
import { createSessionAssembly } from "../src/index.ts"
import { createUnmanagedTaskChildHost } from "../src/lifecycle/task-child-host.ts"

it.each([true, false])("inherited followups capture their own descriptor; declared evidence present=%s", async declaredEvidence => {
  const root = await mkdtemp(join(tmpdir(), "owned-child-binding-")), coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "parent" })
  const calls: string[] = []
  const release = Promise.withResolvers<void>(), mainEntered = Promise.withResolvers<void>(), mainRelease = Promise.withResolvers<void>()
  // The main model turn issues both durable spawns as REAL accepted tool calls
  // and answers the resulting tool results in its second step. A synthetic
  // tools.execute cannot stand in for that: the task leaf rightly refuses a
  // prepared body with no accepted model exchange behind it.
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const textResponse = [
    { type: 'message_start', message: { id: 'fixture', role: 'assistant', content: [], usage: {} } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
    { type: 'message_stop' },
  ].map(frame).join('')
  const spawnCalls = [
    { id: 'spawn-inherited', name: 'spawn_agent', args: { task_name: 'inherited', agent_type: 'general', message: 'first', fork_turns: 'none', background: false } },
    { id: 'spawn-declared', name: 'spawn_agent', args: { task_name: 'declared', agent_type: 'independent', message: 'first', fork_turns: 'none', background: false } },
  ]
  const spawnResponse = [
    { type: 'message_start', message: { id: 'fixture', role: 'assistant', content: [], usage: {} } },
    ...spawnCalls.flatMap((call, index) => [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} },
    { type: 'message_stop' },
  ].map(frame).join('')
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== 'https://inherited-binding.fixture.invalid/v1/messages') throw new Error('Unexpected network destination')
    const request = JSON.parse(String(init.body)) as { model: string; messages: readonly unknown[] }
    calls.push(request.model)
    const serialized = JSON.stringify(request.messages)
    if (serialized.includes('main request')) {
      if (serialized.includes('"tool_result"')) return new Response(textResponse)
      mainEntered.resolve(); await mainRelease.promise
      return new Response(spawnResponse)
    }
    // Followup requests are held so the live child descriptors can be read
    // while the resident children are mid-turn.
    if (serialized.includes('"next"')) await release.promise
    return new Response(textResponse)
  })
  const client = (modelId: string, executionIdentity: import('@i-harness/llm-seam').LiveExecutionIdentity | undefined): ModelClient => createAnthropicClient({ model: modelId, apiKey: 'fixture-only', baseUrl: 'https://inherited-binding.fixture.invalid', executionIdentity })
  const settings = new SettingsStore({ path: join(root, "settings.json") }); await settings.load()
  await settings.set({ llm: { providers: { route: { protocol: "anthropic-messages", apiKeyEnv: "R2A_SYNTHETIC", models: [{ id: "a", contextWindow: 200000, maxTokens: 2048 }, { id: "b", maxTokens: 2048 }, { id: "c", contextWindow: 60000, maxTokens: 2048 }] } }, defaultModel: { provider: "route", model: "a" } } })
  const registry = createProviderRegistry()
  registry.register({ name: "route", displayName: "Route", protocol: "anthropic-messages", contextWindow: 50000 })
  const runtime = createProviderRuntime({ settings, registry, credentials: createCredentialStore(join(root, "keys.json")),
    auth: { async resolve() { return { kind: "api-key", value: "controlled", source: "file" } }, async describe() { return { configured: true, source: "file", writable: true } } },
    buildClient: (profile, modelId) => { if (!modelId) throw new Error("fixture requires a model"); return client(modelId, profile.executionIdentity) } })
  const resolve = async (model: string) => {
    const state = await runtime.resolveModel({ sessionSelection: { provider: "route", model } })
    if (state.status !== "ready") throw new Error(JSON.stringify(state))
    return state.binding
  }
  const a = await resolve("a"), b = await resolve("b"), c = await resolve("c")
  const parentA = a.budgetBinding!, parentB = b.budgetBinding!, childC = c.budgetBinding!
  expect(parentA.limits.contextTokens).toMatchObject({ value: 200000, origin: "configured-model-row" })
  expect(parentB.limits.contextTokens).toMatchObject({ value: 50000, origin: "profile" })
  expect(childC.metadata.modelId).toBe("c")
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: "parent", approveAll: true, model: a.client, contextWindow: 200000, maxOutputTokens: 2048, contextMetadata: a.contextMetadata, budgetBinding: parentA, maxParallelToolCalls: 1,
    allowSubagentModelSelection: true, prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: "unmanaged" }), pluginAgents: [{ name: "independent", description: "independent", systemPrompt: "role", tools: [], model: { provider: "route", model: "c" } }],
    resolveRoleModel: async () => ({ status: "ready", binding: { client: c.client, contextWindow: 60000, maxOutputTokens: 2048, contextMetadata: c.contextMetadata, budgetBinding: declaredEvidence ? childC : undefined } }) })
  try {
    const mainRun = assembly.agent.run("main request")
    await mainEntered.promise
    expect(assembly.agent.contextBudget!()).toMatchObject({ kind: "ready", observation: { disposition: 'compatibility', freshness: 'current', modelId: "a" } })
    ;(parentA.limits.contextTokens as { sourceId: string }).sourceId = "main-revision-v2"
    expect(assembly.agent.contextBudget!()).toMatchObject({ kind: "ready", observation: { freshness: 'stale' } })
    mainRelease.resolve(); await mainRun
    // One main turn with two accepted foreground spawn steps (serialized inside
    // the batch), then the two resident children's initial turns.
    await vi.waitFor(() => expect(calls).toHaveLength(4))
    await vi.waitFor(() => expect(assembly.tasks().filter(row => row.group === "subagent").every(row => row.status === "completed")).toBe(true))
    const sessions = assembly.subagentState().agentTable.map(row => ({ path: row.path, id: row.sessionId! }))
    expect(sessions).toHaveLength(2)
    assembly.setModelBinding!({ model: b.client, contextWindow: 50000, maxOutputTokens: 2048, contextMetadata: b.contextMetadata, budgetBinding: parentB })
    for (const session of sessions) await assembly.tools.execute({ name: "followup_task", args: { target: session.path, message: "next" } })
    await vi.waitFor(() => expect(calls).toHaveLength(6))
    for (const session of sessions) {
      const owned = assembly.liveChildSession!(session.id)!
      const snapshot = deriveContextBudget(owned, session.id)!
      expect(snapshot).toMatchObject({ version: 2, ownerSessionId: session.id, modelId: session.path.endsWith("inherited") ? "b" : "c", dimensions: expect.arrayContaining([expect.objectContaining({dimension:'context',limit:session.path.endsWith("inherited") ? 50000 : 60000})]) })
      expect(snapshot.ownerSessionId).not.toBe("parent")
    }
    // Descriptor-only mutation invalidates reads through actual child captures.
    ;(parentB.limits.contextTokens as { sourceId: string }).sourceId = "parent-revision-v2"
    for (const child of sessions) {
      const read = assembly.liveChildBudget!(child.id)
      expect(read).toMatchObject({ kind: "ready", observation: { freshness: child.path.endsWith("inherited") ? "stale" : "current" } })
    }
    if (declaredEvidence) {
      ;(childC.limits.contextTokens as { sourceId: string }).sourceId = "child-revision-v2"
      expect(assembly.liveChildBudget!(sessions.find(row => row.path.endsWith("declared"))!.id)).toMatchObject({ kind: "ready", observation: { freshness: 'stale' } })
    }
    expect(calls.filter(model => model === "a")).toHaveLength(3)
    expect(calls.filter(model => model === "b")).toHaveLength(1)
    expect(calls.filter(model => model === "c")).toHaveLength(2)
    release.resolve()
    // Let both resident followup turns settle before the assembly is disposed.
    await vi.waitFor(() => expect(assembly.subagentState().agentTable.every(row => row.status === "waiting")).toBe(true))
  } finally { mainRelease.resolve(); release.resolve(); await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
