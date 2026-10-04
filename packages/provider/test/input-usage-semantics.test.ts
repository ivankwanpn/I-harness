import { afterEach, describe, expect, it, vi } from "vitest"
import { createAnthropicClient } from "@i-harness/llm-anthropic"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import { createGeminiClient } from "@i-harness/llm-gemini"
import { createBedrockClient, type BedrockRuntimeFace } from "@i-harness/llm-bedrock"
import type { LLMUsage, ModelClient } from "@i-harness/llm-seam"

afterEach(() => vi.unstubAllGlobals())

const factories = [
  { name: "Anthropic", semantics: "excludes-cache", input: "input_tokens", output: "output_tokens", frame: (usage: object) => ({ type: "message_start", message: { usage } }), create: createAnthropicClient },
  { name: "Responses", semantics: "includes-cache", input: "input_tokens", output: "output_tokens", frame: (usage: object) => ({ type: "response.completed", response: { usage } }), create: createOpenAIClient },
  { name: "Chat", semantics: "includes-cache", input: "prompt_tokens", output: "completion_tokens", frame: (usage: object) => ({ choices: [], usage }), create: createOpenAICompatibleClient },
  { name: "Gemini", semantics: "includes-cache", input: "promptTokenCount", output: "candidatesTokenCount", frame: (usage: object) => ({ candidates: [], usageMetadata: usage }), create: createGeminiClient },
] as const

async function reports(client: ModelClient): Promise<LLMUsage[]> {
  const result: LLMUsage[] = []
  for await (const event of client.stream({ systemPrompt: "", messages: [], tools: [] })) {
    if (event.type === "usage") result.push(event.usage)
  }
  return result
}

describe.each(factories)("$name input accounting metadata", ({ semantics, input, output, frame, create }) => {
  it.each([0, 17])("labels reported input %i without fabricating cache measurements", async (count) => {
    vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify(frame({ [input]: count }))}\n\n`))
    expect(await reports(create({ model: "fixture-model", apiKey: "fixture-key" }))).toEqual([{ inputTokens: count, inputTokenSemantics: semantics }])
  })

  it("keeps output-only measurements free of input semantics", async () => {
    vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify(frame({ [output]: 3 }))}\n\n`))
    expect(await reports(create({ model: "fixture-model", apiKey: "fixture-key" }))).toEqual([{ outputTokens: 3 }])
  })

  it.each([-1, 1.5])("preserves invalid raw input %s without declaring accounting", async (count) => {
    vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify(frame({ [input]: count }))}\n\n`))
    expect(await reports(create({ model: "fixture-model", apiKey: "fixture-key" }))).toEqual([{ inputTokens: count }])
  })
})

describe("Bedrock input accounting metadata", () => {
  it.each([0, 17])("labels input %i as exclusive without manufacturing cache counts", async (inputTokens) => {
    const runtime = { send: async () => ({ stream: [{ metadata: { usage: { inputTokens } } }] }), destroy() {} } as unknown as BedrockRuntimeFace
    expect(await reports(createBedrockClient({ model: "fixture-model" }, runtime))).toEqual([{ inputTokens, inputTokenSemantics: "excludes-cache" }])
  })

  it("keeps output-only measurements free of input semantics", async () => {
    const runtime = { send: async () => ({ stream: [{ metadata: { usage: { outputTokens: 3 } } }] }), destroy() {} } as unknown as BedrockRuntimeFace
    expect(await reports(createBedrockClient({ model: "fixture-model" }, runtime))).toEqual([{ outputTokens: 3 }])
  })
})

describe("Chat cached prompt details", () => {
  it.each([0, 7])("reports documented nested cached_tokens %i", async (cached_tokens) => {
    vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, prompt_tokens_details: { cached_tokens } } })}\n\n`))
    expect(await reports(createOpenAICompatibleClient({ model: "fixture-model", apiKey: "fixture-key" }))).toEqual([{ inputTokens: 9, cacheReadTokens: cached_tokens, inputTokenSemantics: "includes-cache" }])
  })

  it("retains the existing gateway cache report when both spellings are present", async () => {
    vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, prompt_cache_hit_tokens: 6, prompt_tokens_details: { cached_tokens: 7 } } })}\n\n`))
    expect(await reports(createOpenAICompatibleClient({ model: "fixture-model", apiKey: "fixture-key" }))).toEqual([{ inputTokens: 9, cacheReadTokens: 6, inputTokenSemantics: "includes-cache" }])
  })
})
