import { expect, it } from "vitest"
import * as seam from "../src/index.ts"

const facts = seam.modelFailureFacts

it.each([
  { error: { type: "invalid_request_error", message: "context_length_exceeded" } },
  { error: { code: "CONTEXT_TOO_LONG", message: "private prompt" } },
  { error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum", input_tokens: 210000, context_limit: 200000 } },
])("recognizes precise context errors ahead of generic validation: %j", async body => {
  const error = await seam.describeHttpError("anthropic", new Response(JSON.stringify(body), { status: 400, headers: { "request-id": "req-safe-123" } }))
  expect(seam.retryErrorCode(error)).toBe("CONTEXT_WINDOW_EXCEEDED")
  expect(facts(error)).toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", httpStatus: 400, requestId: "req-safe-123", reason: "context-limit" })
  expect(JSON.stringify(facts(error))).not.toContain("private prompt")
})

it("classifies structured SDK validation without losing safe metadata through causes", () => {
  const sdk = Object.assign(new Error("The input length exceeds the maximum context length. private prompt"), { name: "ValidationException", $metadata: { httpStatusCode: 400, requestId: "aws-123" } })
  const error = new Error("wrapped", { cause: sdk })
  expect(seam.retryErrorCode(error)).toBe("CONTEXT_WINDOW_EXCEEDED")
  expect(facts(error)).toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", providerType: "ValidationException", httpStatus: 400, requestId: "aws-123" })
  expect(JSON.stringify(facts(error))).not.toContain("private prompt")
})

it.each([
  [401, { error: { code: "context_length_exceeded", message: "context_length_exceeded" } }, "AUTH"],
  [402, { error: { message: "context_length_exceeded" } }, "QUOTA"],
  [400, { error: { code: "insufficient_quota", message: "context_length_exceeded" } }, "QUOTA"],
  [400, { error: { type: "invalid_request_error", message: 'Invalid tool arguments: "context_length_exceeded" private prompt' } }, "INVALID_ARGUMENT"],
  [400, { error: { type: "invalid_request_error", message: "Invalid schema: context_length_exceeded" } }, "INVALID_ARGUMENT"],
  [413, { error: { message: "private prompt" } }, "INVALID_ARGUMENT"],
  [400, { secret: "sk-private-key", prompt: "private prompt" }, "INVALID_ARGUMENT"],
] as const)("keeps controls at %s: %j", async (status, body, code) => {
  const error = await seam.describeHttpError("test", new Response(JSON.stringify(body), { status }))
  expect(seam.retryErrorCode(error)).toBe(code)
  const safe = facts(error)
  expect(safe).toMatchObject({ code, httpStatus: status })
  expect(JSON.stringify(safe)).not.toMatch(/private prompt|sk-private-key/)
})

it("bounds the error body and cancels the remaining stream", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(100_000))) }, cancel() { cancelled = true } })
  const result = seam.describeHttpError("test", new Response(body, { status: 400 }))
  const winner = await Promise.race([result, new Promise<undefined>(resolve => setTimeout(resolve, 100))])
  expect(winner).toBeInstanceOf(Error)
  expect(cancelled).toBe(true)
})

it("context overflow escapes always retry after one physical request", async () => {
  let calls = 0
  const client: seam.ModelClient = { async *stream() {
    calls++
    yield { type: "error", error: Object.assign(new Error("The input length exceeds the maximum context length"), { name: "ValidationException" }) }
    if (calls > 1) yield { type: "end" }
  } }
  const output = []
  for await (const event of seam.createRetryingClient(client, seam.resolveRetryPolicy({ mode: "always", backoff: { initialDelayMs: 1, maxDelayMs: 1 } })).stream({ messages: [], tools: [], systemPrompt: "" })) output.push(event)
  expect(calls).toBe(1)
  expect(output.filter(event => event.type === "retry")).toHaveLength(0)
})

it.each([
  ["The input token count (210000) exceeds the maximum number of tokens allowed (200000).", 210000, 200000],
  ["input length and max_tokens exceed context limit: 210000 + 4096 > 200000", 210000, 200000],
  ["Too many input tokens. Max input tokens: 200000", undefined, 200000],
] as const)("recognizes validated provider limit formats: %s", async (message, inputTokens, contextLimit) => {
  const error = await seam.describeHttpError("test", new Response(JSON.stringify({ error: { type: "invalid_request_error", message } }), { status: 400 }))
  expect(seam.retryErrorCode(error)).toBe("CONTEXT_WINDOW_EXCEEDED")
  expect(facts(error)?.contextLimit).toBe(contextLimit)
  expect(facts(error)?.inputTokens).toBe(inputTokens)
})

it.each([
  ["max_tokens exceeds the output limit", "output-limit"],
  ["Invalid schema: quoted context_length_exceeded private prompt", "schema"],
  ["Invalid message order: tool result before tool use", "message-order"],
  ["Unsupported parameter: private prompt", "unsupported-parameter"],
] as const)("keeps a distinct safe validation reason: %s", async (message, reason) => {
  const error = await seam.describeHttpError("test", new Response(JSON.stringify({ error: { type: "invalid_request_error", message, param: "private prompt", request_id: "sk-private-key" } }), { status: 400 }))
  expect(seam.retryErrorCode(error)).toBe("INVALID_ARGUMENT")
  expect(facts(error)).toMatchObject({ reason })
  expect(JSON.stringify(facts(error))).not.toMatch(/private prompt|sk-private-key/)
})

it("uses validated body request IDs and rejects forged reason text and scalars", async () => {
  const error = await seam.describeHttpError("test", new Response(JSON.stringify({ request_id: "req-body-123", error: { code: "context_length_exceeded", message: "private prompt", input_tokens: -1, context_limit: "200000", output_limit: Infinity } }), { status: 400 }))
  expect(facts(error)).toMatchObject({ requestId: "req-body-123" })
  expect(facts(error)).not.toHaveProperty("inputTokens")
  expect(facts(error)).not.toHaveProperty("contextLimit")
  const safe = seam.safeModelFailureFacts({ code: "INVALID_ARGUMENT", reason: "context-limit", message: "private prompt", providerCode: "sk-private-key", providerType: "private prompt", parameter: "private prompt", requestId: "sk-private-key", contextLimit: NaN, rawBody: "private prompt" })
  expect(safe).toEqual({ code: "INVALID_ARGUMENT", reason: "unknown", message: "Model request failed." })
})

it.each(["ABORTED", "AUTH", "QUOTA", "TLS"])("explicit %s identity retains authority over conflicting attached context facts", code => {
  const error = Object.assign(new Error("context_length_exceeded"), { code, ...(code === "ABORTED" ? { name: "AbortError" } : {}), modelFailure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "private prompt", reason: "context-limit" } })
  expect(seam.retryErrorCode(error)).toBe(code)
  expect(facts(error)).toMatchObject({ code, reason: "unknown" })
  expect(facts(error)?.message).not.toContain("context window")
})
