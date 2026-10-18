import { prepareTextFixture, checkpointOfLength } from './fixtures/checkpoint.ts'
import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { createCompactionHarness } from './fixtures/engine.ts'
import { resolveCompactSpec, type CompactionConfig } from '../src/index.ts'


// M34 ⑦a: per-model compaction policies — `modelPolicies["provider/model"]`
// overlays the global chain (threshold/retention/max/summarizer/auto) at
// engine build time (dsh shape + grok per-model threshold). A missing
// provider/modelId or an unlisted model = the global defaults (forward compat).
function mockModel(text: string): ModelClient {
  return { prepare: prepareTextFixture,
    async *stream(): AsyncIterable<LLMStreamEvent> {
      yield { type: "text/chunk", text }
      yield { type: "end" }
    },
  }
}

const BASE: CompactionConfig = { contextWindow: 1000, thresholdRatio: 0.8, retainTokens: 0, maxTokens: 50 }

function pressureSession(): ReturnType<typeof createSession> {
  const s = createSession()
  // 7 × 100-token events → ~700 tokens: above the 500 policy threshold
  // (0.5 × 1000), below the 800 global threshold (0.8 × 1000).
  for (let i = 0; i < 7; i++) append(s, { type: "user/message", text: "word ".repeat(80) })
  return s
}

describe("per-model compaction policies (M34 ⑦a)", () => {
  it("resolveCompactSpec: the exact provider/model policy overlays threshold + retention", () => {
    const config: CompactionConfig = {
      ...BASE,
      modelPolicies: { "deepseek/deepseek-v4-pro": { thresholdRatio: 0.5, retainTokens: 400 } },
    }
    const spec = resolveCompactSpec(config, "deepseek", "deepseek-v4-pro")
    expect(spec.thresholdRatio).toBe(0.5)
    expect(spec.retainTokens).toBe(400)
    expect(spec.maxTokens).toBe(50) // untouched global value
    expect(spec.auto).toBe(true)
    expect(spec.contextWindow).toBe(1000)
  })

  it("resolveCompactSpec: an unlisted model keeps the global chain (0.8 / 0 retention)", () => {
    const config: CompactionConfig = {
      ...BASE,
      modelPolicies: { "deepseek/deepseek-v4-pro": { thresholdRatio: 0.5, retainTokens: 400 } },
    }
    expect(resolveCompactSpec(config, "deepseek", "deepseek-v4-flash")).toMatchObject({ thresholdRatio: 0.8, retainTokens: 0 })
    expect(resolveCompactSpec(config).thresholdRatio).toBe(0.8) // no provider/modelId → plain global
    expect(resolveCompactSpec(config, undefined, "deepseek-v4-flash").thresholdRatio).toBe(0.8)
  })

  it("engine applies selected model threshold and whole-exchange retention", async () => {
    const { closedExchange } = await import('./fixtures/history.ts')
    const s = createSession(); for (let i=0;i<20;i++) closedExchange(s, 'E'+i,400)
    const config: CompactionConfig = { contextWindow: 20000, thresholdRatio: .95, modelPolicies: { 'deepseek/selected': { thresholdRatio: .8, retainTokens: 400 } } }
    const engine = createCompactionHarness({ model: mockModel(checkpointOfLength(600)), config, maxOutputTokens:15500,
      contextMetadata: {version:1,providerId:'deepseek',modelId:'selected',protocol:'fixture',contextWindow:20000,identityCoverage:'partial'} })
    expect((await engine.maybeCompact(s)).shadowedSeqs).toEqual(Array.from({length:16},(_,i)=>[i*3,i*3+1]).flat())
  })

  it("engine: an unlisted model id is NOT under the policy — no fire below 80%", async () => {
    const s = pressureSession()
    const config: CompactionConfig = {
      ...BASE,
      modelPolicies: { "deepseek/deepseek-v4-pro": { thresholdRatio: 0.5 } },
    }
    const engine = createCompactionHarness({
      model: mockModel("x"), config,
      provider: "deepseek", modelId: "deepseek-v4-flash",
    })
    expect((await engine.maybeCompact(s)).compacted).toBe(false)
    expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("fails loud: every modelPolicies key must be exactly 'provider/model'", () => {
    expect(() => resolveCompactSpec(
      { contextWindow: 1000, modelPolicies: { deepseek: { thresholdRatio: 0.5 } } },
      "deepseek", "deepseek-v4-pro",
    )).toThrow(/provider\/model/)
    expect(() => resolveCompactSpec(
      { contextWindow: 1000, modelPolicies: { "a/b/c": { thresholdRatio: 0.5 } } },
      "a", "c",
    )).toThrow(/provider\/model/)
    // validated even when the engine never resolves against that model
    expect(() => resolveCompactSpec({ contextWindow: 1000, modelPolicies: { "x/y/z": {} } })).toThrow(/provider\/model/)
  })

  it("fails loud: invalid policy overrides reuse the global validators", () => {
    expect(() => resolveCompactSpec(
      { contextWindow: 1000, modelPolicies: { "deepseek/deepseek-v4-pro": { thresholdRatio: 0 } } },
      "deepseek", "deepseek-v4-pro",
    )).toThrow(/thresholdRatio/)
    expect(() => resolveCompactSpec(
      { contextWindow: 1000, modelPolicies: { "deepseek/deepseek-v4-pro": { retainTokens: -1 } } },
      "deepseek", "deepseek-v4-pro",
    )).toThrow(/retainTokens/)
    expect(() => resolveCompactSpec(
      { contextWindow: 1000, modelPolicies: { "deepseek/deepseek-v4-pro": { maxTokens: 0 } } },
      "deepseek", "deepseek-v4-pro",
    )).toThrow(/maxTokens/)
  })
})
