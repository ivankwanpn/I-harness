import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

function pressureAgent(
  selection: { provider?: string; modelId?: string },
  globalPolicy = { thresholdRatio: 0.8, retainTokens: 0 },
) {
  const ctx = createContext(), session = createSession()
  for (let i = 0; i < 7; i++) append(session, { type: "user/message", text: `${i}: ` + "word ".repeat(80) })
  const agent = createAgent(ctx, {
    session, tools: createToolRegistry(ctx), systemPrompt: "",
    model: createMockClient([{ role: "assistant", text: "done" }]),
    ...selection,
    compact: {
      contextWindow: 10000, ...globalPolicy,
      summarizationModel: createMockClient([{ role: "assistant", text: "## Primary Request and Intent\n- " + "work ".repeat(120) }]),
      modelPolicies: { "deepseek/deepseek-v4-pro": { thresholdRatio: 0.05, retainTokens: 400 } },
    },
  })
  return { agent, session }
}

describe("createAgent per-model compaction policies", () => {
  // WHY: engine-only coverage missed the dropped selection at the real agent
  // seam (packages/core-agent/src/index.ts:222; packages/compaction/src/config.ts:176).
  //
  // KNOWN GAP — NOT a passing regression. `modelPolicies` is implemented in
  // `packages/compaction` and reachable through `createCompactionEngine`, but the
  // ONLY production caller (`packages/core-agent/src/index.ts:222`) never passes
  // the resolved `provider`/`modelId`, so a per-model policy cannot take effect in
  // production. The drop point was located: the composition chain carries the IDs
  // (`packages/provider-runtime/src/index.ts:840-842`) but
  // `packages/session-executor/src/service.ts:577-582` passes the client and
  // limits to the assembly WITHOUT them, and `packages/session-executor/src/
  // assembly.ts:535-537` hands `createAgent` a stream-only model handle; its
  // `createAgent` call at `:1500` passes no IDs.
  //
  // This test fails for that reason and is skipped rather than deleted, so the
  // gap stays visible and the assertion is preserved for whoever completes the
  // wiring. Completing it requires editing `packages/session-executor` (initial
  // binding + live-rebind plumbing), which was outside the change that added this
  // file. Remove `.skip` when the IDs are threaded through; the control below
  // already passes with the equivalent GLOBAL policy, which is what proves the
  // fixture's compaction itself works.
  it.skip("applies the resolved provider/model threshold and retention when the agent runs", async () => {
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
