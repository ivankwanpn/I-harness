import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgentWithSummary } from './fixtures/agent.ts'

function pressureAgent(
  selection: { provider?: string; modelId?: string },
  globalPolicy = { thresholdRatio: 0.8, retainTokens: 0 },
) {
  const ctx = createContext(), session = createSession()
  for (let i = 0; i < 7; i++) append(session, { type: "user/message", text: `${i}: ` + "word ".repeat(80) })
  const agent = createAgentWithSummary(ctx, {
    session, tools: createToolRegistry(ctx), systemPrompt: "",
    model: createMockClient([{ role: "assistant", text: "done" }]),
    contextMetadata: selection.modelId ? { version: 1, providerId: selection.provider, modelId: selection.modelId, protocol: "custom", identityCoverage: "partial", contextWindow: 10000 } : undefined,
    compact: {
      contextWindow: 10000, ...globalPolicy,
      summarizationModel: createMockClient([{ role: "assistant", text: "## Primary Request and Intent\n- " + "work ".repeat(120) }]),
      modelPolicies: { "deepseek/deepseek-v4-pro": { thresholdRatio: 0.05, retainTokens: 400 } },
    },
  })
  return { agent, session }
}

describe("createAgent per-model compaction policies", () => {
  // Actual owned binding metadata supplies the current policy key.
  it("applies the resolved provider/model threshold and retention when the agent runs", async () => {
    const { agent, session } = pressureAgent({ provider: "deepseek", modelId: "deepseek-v4-pro" })
    expect((await agent.run("continue")).finalText).toBe("done")
    const marker = session.events.find(event => event.type === "compaction/summary")
    expect(marker).toMatchObject({ shadowedSeqs: [0, 1, 2] })
    const visibleHistory = deriveMessages(session).filter(message => typeof message.content === "string" && /^[0-9]: /.test(message.content))
    expect(visibleHistory.map(message => (message.content as string).slice(0, 1))).toEqual(["3", "4", "5", "6"])
  })

  it("compacts the same fixture with the equivalent global threshold and retention", async () => {
    const { agent, session } = pressureAgent({}, { thresholdRatio: 0.05, retainTokens: 400 })
    expect((await agent.run("continue")).finalText).toBe("done")
    expect(session.events.find(event => event.type === "compaction/summary")).toMatchObject({ shadowedSeqs: [0, 1, 2] })
    const visibleHistory = deriveMessages(session).filter(message => typeof message.content === "string" && /^[0-9]: /.test(message.content))
    expect(visibleHistory.map(message => (message.content as string).slice(0, 1))).toEqual(["3", "4", "5", "6"])
  })

  it("refreshes the policy key on a direct metadata rebind", async () => {
    const { agent, session } = pressureAgent({ provider: "deepseek", modelId: "unlisted" })
    const compact = { contextWindow: 10000, thresholdRatio: 0.8, retainTokens: 0,
      summarizationModel: createMockClient([{ role: "assistant", text: "checkpoint " + "work ".repeat(120) }]),
      modelPolicies: { "deepseek/deepseek-v4-pro": { thresholdRatio: 0.05, retainTokens: 400 } } }
    agent.updateContext!({ compact, contextMetadata: { version: 1, providerId: "deepseek", modelId: "deepseek-v4-pro", protocol: "custom", contextWindow: 10000, identityCoverage: "partial" } })
    expect((await agent.run("continue")).finalText).toBe("done")
    expect(session.events.find(event => event.type === "compaction/summary")).toMatchObject({ shadowedSeqs: [0, 1, 2] })
    expect(deriveMessages(session).filter(message => typeof message.content === "string" && /^[0-9]: /.test(message.content)).map(message => (message.content as string).slice(0, 1))).toEqual(["3", "4", "5", "6"])
  })

  it("refreshes the inherited policy descriptor before the next logical step", async () => {
    const ctx = createContext(), session = createSession()
    for (let i = 0; i < 7; i++) append(session, { type: "user/message", text: `${i}: ` + "word ".repeat(80) })
    let binding = { identity: {}, contextWindow: 10000, contextMetadata: { version: 1 as const, providerId: "deepseek", modelId: "unlisted", protocol: "custom", contextWindow: 10000, identityCoverage: "partial" as const } }
    const agent = createAgentWithSummary(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: "", bindingForStep: () => binding,
      model: createMockClient([{ role: "assistant", text: "first" }, { role: "assistant", text: "second" }]),
      compact: { contextWindow: 10000, thresholdRatio: 0.8, summarizationModel: createMockClient([{ role: "assistant", text: "checkpoint " + "work ".repeat(120) }]),
        modelPolicies: { "deepseek/deepseek-v4-pro": { thresholdRatio: 0.05, retainTokens: 400 } } } })
    expect((await agent.run("continue")).finalText).toBe("first")
    expect(session.events.some(event => event.type === "compaction/summary")).toBe(false)
    binding = { ...binding, identity: {}, contextMetadata: { ...binding.contextMetadata, modelId: "deepseek-v4-pro" } }
    expect((await agent.followup("continue")).finalText).toBe("second")
    expect(session.events.find(event => event.type === "compaction/summary")).toMatchObject({ shadowedSeqs: [0, 1, 2] })
    expect(deriveMessages(session).filter(message => typeof message.content === "string" && /^[0-9]: /.test(message.content)).map(message => (message.content as string).slice(0, 1))).toEqual(["3", "4", "5", "6"])
  })

  it.each([
    {},
    { provider: "deepseek" },
    { modelId: "deepseek-v4-pro" },
    { provider: "deepseek", modelId: "unlisted" },
  ])("keeps global behavior for absent or unlisted selection: %j", async selection => {
    const { agent, session } = pressureAgent(selection)
    expect((await agent.run("continue")).finalText).toBe("done")
    expect(session.events.some(event => event.type.startsWith("compaction/"))).toBe(false)
    expect(deriveMessages(session)).toHaveLength(9)
  })
})
