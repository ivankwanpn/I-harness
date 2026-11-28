import { once } from "node:events"
import { createServer } from "node:http"
import { createAnthropicClient } from "@i-harness/llm-anthropic"
import { createGeminiClient } from "@i-harness/llm-gemini"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import { describe, expect, it, vi } from "vitest"

const protocols = [
  { name: "Responses", create: createOpenAIClient,
    delta: { type: "response.output_text.delta", delta: "partial" },
    failure: { type: "response.failed", response: { error: { code: "server_error", message: "fixture" } } } },
  { name: "Chat", create: createOpenAICompatibleClient,
    delta: { choices: [{ delta: { content: "partial" } }] },
    failure: { error: { code: "server_error", message: "fixture" } } },
  { name: "Messages", create: createAnthropicClient,
    delta: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    failure: { type: "error", error: { type: "overloaded_error", message: "fixture" } } },
  { name: "Gemini", create: createGeminiClient,
    delta: { candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] },
    failure: { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] } },
]

describe.each(protocols)("$name SSE response lifetime", ({ create, delta, failure }) => {
  it.each(["consumer return", "terminal error"])("closes the transport on %s", async mode => {
    let disconnected = false
    const server = createServer((_request, response) => {
      response.once("close", () => { disconnected = true })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("data: " + JSON.stringify(mode === "consumer return" ? delta : failure) + "\n\n")
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No loopback port")
    const client = create({ apiKey: "fixture", model: "fixture", baseUrl: `http://127.0.0.1:${address.port}` })
    const iterator = client.stream({
      systemPrompt: "", tools: [], messages: [{ role: "user", content: "fixture" }],
      signal: AbortSignal.timeout(5_000),
    })[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      expect(first.value).toMatchObject(mode === "consumer return" ? { type: "text/chunk", text: "partial" } : { type: "error" })
      if (mode === "consumer return") await iterator.return?.()
      // A consumer handling a terminal failure may never request another event.
      await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 1500 })
    } finally {
      server.closeAllConnections()
      await iterator.return?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

it.each(["completed", "failed"])("closes a %s Responses exchange before delivering its final usage", async status => {
  let disconnected = false
  const server = createServer((_request, response) => {
    response.once("close", () => { disconnected = true })
    response.writeHead(200, { "content-type": "text/event-stream" })
    const terminal = { type: "response." + status, response: { status, usage: { output_tokens: 7 },
      ...(status === "completed" ? { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }] }
        : { error: { code: "server_error", message: "fixture" } }) } }
    response.write("data: " + JSON.stringify(terminal) + "\n\n")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No loopback port")
  const client = createOpenAIClient({ apiKey: "fixture", model: "fixture", baseUrl: `http://127.0.0.1:${address.port}` })
  const it = client.stream({ systemPrompt: "", tools: [], messages: [], signal: AbortSignal.timeout(5_000) })[Symbol.asyncIterator]()
  try {
    expect((await it.next()).value).toMatchObject({ type: "usage", usage: { outputTokens: 7 } })
    await vi.waitFor(() => expect(disconnected).toBe(true), { timeout: 1500 })
    if (status === "completed") expect((await it.next()).value).toEqual({ type: "text/chunk", text: "answer" })
    expect((await it.next()).value.type).toBe(status === "completed" ? "end" : "error")
  } finally {
    server.closeAllConnections()
    await it.return?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
