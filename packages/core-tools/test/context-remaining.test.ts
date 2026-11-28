import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, append } from "@i-harness/core-session"
import { createToolRegistry } from "../src/index.ts"
import { registerContextRemaining } from "../src/context-remaining.ts"

describe("get_context_remaining (R-A8)", () => {
  it("reports remaining budget", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    registerContextRemaining(ctx, tools, { contextWindow: 1000 })
    const result = await tools.execute({ name: "get_context_remaining", args: {} })
    const output = result.output as { window: number; used: number; remaining: number; percentage: number }
    expect(output).toMatchObject({ window: 1000 })
    expect(output.remaining).toBeGreaterThanOrEqual(0)
    expect(output).toMatchObject({ used: expect.any(Number), percentage: expect.any(Number) })
  })

  it.each([undefined, 0, -1, Infinity, NaN, 1.5])("does not register without a valid fallback window (%s)", window => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    registerContextRemaining(ctx, tools, { contextWindow: window })
    expect(tools.schemas().map((s) => s.name)).not.toContain("get_context_remaining")
  })

  it("uses the live session for used (M15 projection: deriveMessages)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const session = createSession()
    append(session, { type: "user/message", text: "hello world this is a priced message" })
    registerContextRemaining(ctx, tools, { contextWindow: 1000, session })
    const { output } = await tools.execute({ name: "get_context_remaining", args: {} })
    const priced = output as { window: number; used: number; remaining: number; percentage: number }
    expect(priced.used).toBeGreaterThan(0)
    expect(priced).toMatchObject({ window: 1000 })
  })

  it("keeps the old prepared numerical breakdown without sending journal identities back to the model", async () => {
    const ctx = createContext(), tools = createToolRegistry(ctx)
    registerContextRemaining(ctx, tools, { budgetRead: () => ({ kind: 'ready', snapshot: {
      version: 1, ownerSessionId: 'private-session', modelId: 'm', protocol: 'chat', bindingFingerprint: 'a'.repeat(64),
      bindingRevision: 1, projectionRevision: 2, neutralFingerprint: 'b'.repeat(64), identityCoverage: 'partial',
      contextWindow: 1000, estimatedInputTokens: 40, admissionInputTokens: 40,
      estimateSource: 'projected-heuristic', coverage: 'complete', confidence: 'estimated',
      roleTokens: { user: 15, assistant: 0, tool: 0 }, systemTokens: 10, schemaTokens: 15, reasoningTokens: 0,
      outputReserve: 100, safetyMargin: 20, capSupport: 'supported', effectiveOutputCap: 100,
      remainingInputBudget: 840, admission: 'fit', recoveryRequired: false, fullByProvider: false,
    } }) })
    const { output } = await tools.execute({ name: 'get_context_remaining', args: {} })
    expect(output).toMatchObject({ window: 1000, used: 40, remaining: 840, snapshot: { schemaTokens: 15, safetyMargin: 20, outputReserve: 100 } })
    expect(JSON.stringify(output)).not.toMatch(/private-session|Fingerprint|[a-f0-9]{64}/)
  })
})
