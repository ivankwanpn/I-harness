import { expect, it } from "vitest"
import { resolveEffectiveModelContextEvidence, type ProviderProfile } from "../src/index.ts"

const profile: ProviderProfile = { name: "test-route", displayName: "test", protocol: "gemini", catalog: "gemini", contextWindow: 500_000,
  modelContexts: { "gemini-2.5-pro": { contextWindow: 600_000, maxContextWindow: 650_000 } } }

it("separates configured generation from catalog limits and preserves scalar fields at the evidence boundary", () => {
  const input = { profile, modelId: "gemini-2.5-pro", userModel: { contextWindow: 700_000, maxTokens: 80_000 } }
  expect(resolveEffectiveModelContextEvidence(input)).toMatchObject({ limits: {
    contextTokens: { value: 700_000, origin: "configured-model-row", sourceId: "settings-model-row-v1" },
    contextCeilingTokens: { value: 650_000, origin: "profile-model" },
    outputTokens: { value: 65_536, origin: "catalog" },
  }, generation: { origin: "configured", outputCap: { value: 80_000, origin: "configured-model-row" } } })
  expect(resolveEffectiveModelContextEvidence(input)).toMatchObject({ contextWindow: 700_000, maxContextWindow: 650_000, maxOutputTokens: 80_000 })
})

it.each([
  { profile, want: 600_000, origin: "profile-model" },
  { profile: { ...profile, modelContexts: undefined }, want: 500_000, origin: "profile" },
  { profile: { ...profile, contextWindow: undefined, modelContexts: undefined }, want: 1_048_576, origin: "catalog" },
])("retains each window tier independently from generation ($origin)", ({ profile, want, origin }) => {
  const resolved = resolveEffectiveModelContextEvidence({ profile, modelId: "gemini-2.5-pro" })
  expect(resolved?.limits.contextTokens).toMatchObject({ value: want, origin })
  expect(resolved?.generation).toMatchObject({ origin: "legacy-catalog-default", outputCap: { value: 65_536 } })
})

it("preserves ceiling-only evidence with absent window/output scalars and accepts unknown models", () => {
  const p = { name: "custom", displayName: "Custom", protocol: "gemini" as const, maxContextWindow: 10_000 }
  expect(resolveEffectiveModelContextEvidence({ profile: p, modelId: "unknown" })).toMatchObject({ contextWindow: undefined, maxContextWindow: 10_000 })
  expect(resolveEffectiveModelContextEvidence({ profile: p, modelId: "unknown" })).toMatchObject({ limits: { contextCeilingTokens: { value: 10_000, origin: "profile" } }, generation: { origin: "unspecified" } })
  expect(resolveEffectiveModelContextEvidence({ profile: { ...p, maxContextWindow: undefined }, modelId: "unknown" })).toBeUndefined()
  expect(resolveEffectiveModelContextEvidence({ profile: p, modelId: "unknown", userModel: { maxTokens: 900 } })).toMatchObject({ generation: { origin: "configured", outputCap: { value: 900 } } })
  expect(resolveEffectiveModelContextEvidence({ profile: p, modelId: "unknown", userModel: { maxTokens: 900 } })).toMatchObject({ contextWindow: undefined, maxContextWindow: 10_000, maxOutputTokens: 900 })
})

it("uses declared catalog aliases with bounded catalog revision evidence", () => {
  const p = { name: "proxy", displayName: "Proxy", protocol: "openai-compatible" as const, catalog: "deepseek" }
  const value = resolveEffectiveModelContextEvidence({ profile: p, modelId: "deepseek-v4-flash" })
  expect(value?.limits.contextTokens).toMatchObject({ value: 1_048_576, origin: "catalog" })
  expect(value?.limits.contextTokens?.sourceId).toMatch(/^catalog:deepseek:\d{4}-\d{2}-\d{2}$/)
  expect(resolveEffectiveModelContextEvidence({ profile: { ...p, catalog: "missing" }, modelId: "deepseek-v4-flash" })).toBeUndefined()
})

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects invalid evidence values %s", value => {
  expect(() => resolveEffectiveModelContextEvidence({ profile, modelId: "gemini-2.5-pro", userModel: { maxTokens: value } })).toThrow(/positive safe integer/)
})
