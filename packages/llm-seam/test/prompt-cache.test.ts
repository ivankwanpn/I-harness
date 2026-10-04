import { describe, expect, expectTypeOf, it } from "vitest"
import { resolvePromptCacheMode, type LLMRequest, type PromptCacheConfig } from "../src/index.ts"

describe("neutral prompt cache metadata", () => {
  it("keeps request intent distinct from route capability and retention", () => {
    expectTypeOf<NonNullable<LLMRequest["promptCache"]>>().toEqualTypeOf<{ mode?: "off" | "default"; key?: string }>()
    expectTypeOf<PromptCacheConfig>().toEqualTypeOf<{ mode: "off" | "automatic"; retention?: "5m" | "1h" }>()
  })

  it.each([
    { route: undefined, intent: undefined, want: undefined },
    { route: undefined, intent: { mode: "default", key: "opaque" }, want: undefined },
    { route: { mode: "automatic" }, intent: undefined, want: "automatic" },
    { route: { mode: "automatic" }, intent: { mode: "default" }, want: "automatic" },
    { route: { mode: "automatic" }, intent: { mode: "off" }, want: "off" },
    { route: { mode: "off" }, intent: { mode: "default" }, want: "off" },
    { route: undefined, intent: { mode: "off" }, want: "off" },
  ] as const)("resolves $route with request $intent to $want", ({ route, intent, want }) => {
    expect(resolvePromptCacheMode(route, intent)).toBe(want)
  })
})
