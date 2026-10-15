import { vi } from "vitest"
import { systemFetch } from "../../packages/http-transport/src/index.ts"
import { systemFetch as quarantinedSystemFetch } from "../../packages/http-transport/src/system-fetch.ts"
import { createOpenAICompatibleClient } from "../../packages/llm-openai-compatible/src/index.ts"
import { createOpenAIClient } from "../../packages/llm-openai/src/index.ts"
import { createAnthropicClient } from "../../packages/llm-anthropic/src/index.ts"
import { createGeminiClient } from "../../packages/llm-gemini/src/index.ts"
import { createBedrockClient, type BedrockRuntimeFace } from "../../packages/llm-bedrock/src/index.ts"
import type { CorpusRoute } from "./context-corpus.ts"

export type CapturedRequest =
  | { kind: "http-json-body"; raw: string; body: Record<string, any>; endpoint: string }
  | { kind: "sdk-command-estimate"; body: Record<string, any>; commandName: string }

export function installTransport(route: CorpusRoute) {
  // Fail before adapter construction if either exact-source quarantine is absent.
  if (!vi.isMockFunction(systemFetch) || !vi.isMockFunction(quarantinedSystemFetch)) throw new Error("corpus HTTP quarantine is not installed")
  const captures: CapturedRequest[] = []
  let authCount = 0
  const captureHttp = async (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(url)
    const expected = route === "subscription" ? "https://chatgpt.com/backend-api/codex/responses"
      : route === "chat" ? "https://fixture.invalid/v1/chat/completions"
      : route === "responses" ? "https://fixture.invalid/v1/responses"
      : route === "anthropic" ? "https://fixture.invalid/v1/messages"
      : "https://fixture.invalid/v1beta/models/fixture:streamGenerateContent?alt=sse"
    if (route === "bedrock" || endpoint !== expected || init?.method !== "POST" || typeof init.body !== "string") throw new Error(`unexpected HTTP transport: ${endpoint}`)
    captures.push({ kind: "http-json-body", raw: init.body, body: JSON.parse(init.body), endpoint })
    const terminal = route === "chat" ? 'data: [DONE]\n\n'
      : route === "anthropic" ? 'data: {"type":"message_stop"}\n\n'
      : route === "gemini" ? 'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}]}\n\n'
      : 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'
    return new Response(terminal, { status: 200, headers: { "content-type": "text/event-stream" } })
  }
  vi.stubGlobal("fetch", route === "subscription" ? async () => { throw new Error("subscription used global fetch") } : captureHttp)
  vi.mocked(systemFetch).mockImplementation(route === "subscription" ? captureHttp : async () => { throw new Error("unexpected systemFetch route") })
  const runtime = {
    async send(command: { input: Record<string, unknown> }) {
      if (route !== "bedrock") throw new Error("unexpected Bedrock transport")
      // Capture the real SDK command input, preserving Buffer/Uint8Array types.
      captures.push({ kind: "sdk-command-estimate", body: command.input, commandName: command.constructor.name })
      return { stream: [] }
    },
    destroy() {},
  } as unknown as BedrockRuntimeFace
  return {
    captures, runtime, authCalls: () => authCount,
    async auth() { authCount++; return { accessToken: "fixture", accountId: "fixture" } },
  }
}

export function makeClient(route: CorpusRoute, transport: ReturnType<typeof installTransport>, settings: {
  vision?: boolean
  options?: Record<string, unknown>
  auth?: () => Promise<{ accessToken: string; accountId: string }>
} = {}) {
  const common = { apiKey: "fixture", model: "fixture", providerId: "fixture", baseUrl: "https://fixture.invalid", inputModalities: settings.vision ? ["text" as const, "image" as const] : ["text" as const], options: settings.options }
  switch (route) {
    case "chat": return createOpenAICompatibleClient(common)
    case "responses": return createOpenAIClient(common)
    case "subscription": return createOpenAIClient({ ...common, baseUrl: undefined, codexSubscription: true, resolveCodexAuth: settings.auth ?? transport.auth })
    case "anthropic": return createAnthropicClient(common)
    case "gemini": return createGeminiClient(common)
    case "bedrock": return createBedrockClient(common, transport.runtime)
  }
}
