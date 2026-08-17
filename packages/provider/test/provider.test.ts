import { describe, expect, it } from "vitest"
import { createProviderRegistry, buildModelClient } from "../src/index.ts"

describe("provider registry", () => {
  it("registers, lists, and removes providers", () => {
    const reg = createProviderRegistry()
    reg.register({ name: "my-deepseek", displayName: "My DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "k", models: ["deepseek-chat"] })
    expect(reg.get("my-deepseek")?.protocol).toBe("openai-compatible")
    expect(reg.list()).toHaveLength(1)
    reg.remove("my-deepseek")
    expect(reg.get("my-deepseek")).toBeUndefined()
  })

  it("throws on duplicate provider name", () => {
    const reg = createProviderRegistry()
    reg.register({ name: "x", displayName: "X", protocol: "openai-responses" })
    expect(() => reg.register({ name: "x", displayName: "X2", protocol: "anthropic-messages" })).toThrow(/duplicate/i)
  })

  it("buildModelClient returns a ModelClient for each protocol", () => {
    const clients = [
      buildModelClient({ name: "o", displayName: "O", protocol: "openai-responses", apiKey: "k" }, "gpt-4o"),
      buildModelClient({ name: "c", displayName: "C", protocol: "openai-compatible", apiKey: "k" }, "deepseek-chat"),
      buildModelClient({ name: "a", displayName: "A", protocol: "anthropic-messages", apiKey: "k" }, "claude-x"),
    ]
    for (const c of clients) expect(typeof c.stream).toBe("function")
  })

  it("buildModelClient throws on unknown protocol", () => {
    expect(() => buildModelClient({ name: "x", displayName: "X", protocol: "bogus" as never }, "m")).toThrow(/protocol/i)
  })
})
