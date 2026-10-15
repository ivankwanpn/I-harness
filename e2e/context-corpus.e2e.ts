import { afterEach, describe, expect, it, vi } from "vitest"
import { append, createSession, deriveMessages, fromJSONL, toJSONL } from "../packages/core-session/src/index.ts"
import type { LLMRequest, PreparedModelRequest } from "../packages/llm-seam/src/index.ts"
import { systemFetch as quarantinedSystemFetch } from "../packages/http-transport/src/system-fetch.ts"
import { corpusRoutes, makeCompactedToolRound, makeToolRound, png, type CorpusRoute } from "./fixtures/context-corpus.ts"
import { installTransport, makeClient, type CapturedRequest } from "./fixtures/context-transports.ts"

// The subscription adapter alone uses systemFetch. Never let it resolve real auth/network.
vi.mock("../packages/http-transport/src/index.ts", () => ({ systemFetch: vi.fn(() => { throw new Error("unexpected systemFetch") }) }))
// Second layer: a missed barrel mock cannot initialize proxy discovery or transport.
vi.mock("../packages/http-transport/src/system-fetch.ts", () => ({ systemFetch: vi.fn(() => { throw new Error("corpus physical network quarantined") }) }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks() })

// Wire shapes are deliberately inspected independently of production message mappers.
// `any` here describes heterogeneous physical protocols, never a semantic round-trip.
type Wire = Record<string, any>
const ids = ["read-a", "read-b"]
const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }

function assertGroupedWire(route: CorpusRoute, body: Wire): void {
  if (route === "gemini") expect(body.contents.at(-1)).toEqual({ role: "user", parts: [{ text: "Continue with the current input." }] })
  else if (route === "bedrock") expect(body.messages.at(-1)).toEqual({ role: "user", content: [{ text: "Continue with the current input." }] })
  else expect((route === "responses" || route === "subscription" ? body.input : body.messages).at(-1)).toEqual({ role: "user", content: "Continue with the current input." })
  if (route === "chat") {
    const index = body.messages.findIndex((m: Wire) => m.tool_calls)
    expect(index).toBeGreaterThanOrEqual(0)
    const assistant = body.messages[index]
    expect(assistant.role).toBe("assistant")
    expect(assistant.content).toBe("Checking both files.")
    expect(assistant.tool_calls.map((c: Wire) => c.id)).toEqual(ids)
    expect(assistant.tool_calls.map((c: Wire) => [c.function.name, JSON.parse(c.function.arguments)])).toEqual([["read", { path: "a" }], ["read", { path: "b" }]])
    expect(body.messages.slice(index + 1, index + 3).map((m: Wire) => [m.role, m.tool_call_id, JSON.parse(m.content)])).toEqual([["tool", "read-b", { file: "b", text: "B" }], ["tool", "read-a", { file: "a", text: "A" }]])
    return
  }
  if (route === "responses" || route === "subscription") {
    const calls = body.input.filter((m: Wire) => m.type === "function_call")
    expect(body.input.filter((m: Wire) => m.role === "assistant").map((m: Wire) => m.content)).toEqual(["Checking both files."])
    expect(calls.map((m: Wire) => m.call_id)).toEqual(ids)
    expect(calls.map((m: Wire) => [m.name, JSON.parse(m.arguments)])).toEqual([["read", { path: "a" }], ["read", { path: "b" }]])
    for (const call of calls) expect(call.namespace).toBe(route === "subscription" ? "ih" : undefined)
    const lastCall = body.input.findLastIndex((m: Wire) => m.type === "function_call")
    expect(body.input.slice(lastCall + 1, lastCall + 3).map((m: Wire) => [m.type, m.call_id, JSON.parse(m.output)])).toEqual([["function_call_output", "read-b", { file: "b", text: "B" }], ["function_call_output", "read-a", { file: "a", text: "A" }]])
    return
  }
  if (route === "anthropic") {
    const index = body.messages.findIndex((m: Wire) => Array.isArray(m.content) && m.content.some((p: Wire) => p.type === "tool_use"))
    expect(index).toBeGreaterThanOrEqual(0)
    expect(body.messages[index].role).toBe("assistant")
    expect(body.messages[index].content.filter((p: Wire) => p.type === "text")).toEqual([{ type: "text", text: "Checking both files." }])
    expect(body.messages[index].content.filter((p: Wire) => p.type === "tool_use").map((p: Wire) => [p.id, p.name, p.input])).toEqual([["read-a", "read", { path: "a" }], ["read-b", "read", { path: "b" }]])
    expect(body.messages[index + 1].role).toBe("user")
    expect(body.messages[index + 1].content.map((p: Wire) => [p.type, p.tool_use_id, JSON.parse(p.content)])).toEqual([["tool_result", "read-b", { file: "b", text: "B" }], ["tool_result", "read-a", { file: "a", text: "A" }]])
    return
  }
  if (route === "gemini") {
    const index = body.contents.findIndex((m: Wire) => m.parts.some((p: Wire) => p.functionCall))
    expect(index).toBeGreaterThanOrEqual(0)
    expect(body.contents[index].role).toBe("model")
    expect(body.contents[index].parts.filter((p: Wire) => p.text && !p.thought).map((p: Wire) => p.text)).toEqual(["Checking both files."])
    expect(body.contents[index].parts.filter((p: Wire) => p.functionCall).map((p: Wire) => p.functionCall)).toEqual([{ id: "read-a", name: "read", args: { path: "a" } }, { id: "read-b", name: "read", args: { path: "b" } }])
    expect(body.contents[index + 1]).toEqual({ role: "user", parts: [{ functionResponse: { id: "read-b", name: "read", response: { file: "b", text: "B" } } }, { functionResponse: { id: "read-a", name: "read", response: { file: "a", text: "A" } } }] })
    return
  }
  const index = body.messages.findIndex((m: Wire) => m.content.some((p: Wire) => p.toolUse))
  expect(index).toBeGreaterThanOrEqual(0)
  expect(body.messages[index].role).toBe("assistant")
  expect(body.messages[index].content.filter((p: Wire) => p.text)).toEqual([{ text: "Checking both files." }])
  expect(body.messages[index].content.filter((p: Wire) => p.toolUse).map((p: Wire) => p.toolUse)).toEqual([{ toolUseId: "read-a", name: "read", input: { path: "a" } }, { toolUseId: "read-b", name: "read", input: { path: "b" } }])
  expect(body.messages[index + 1]).toEqual({ role: "user", content: [{ toolResult: { toolUseId: "read-b", content: [{ json: { file: "b", text: "B" } }] } }, { toolResult: { toolUseId: "read-a", content: [{ json: { file: "a", text: "A" } }] } }] })
}

function assertNative(route: CorpusRoute, body: Wire, compatible = true): void {
  if (route === "chat") {
    expect(body.messages.find((m: Wire) => m.tool_calls).reasoning_content).toBe(compatible ? "Synthetic plan." : undefined)
  } else if (route === "responses" || route === "subscription") {
    const reasoning = body.input.filter((p: Wire) => p.type === "reasoning")
    expect(reasoning).toEqual(compatible ? [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "Synthetic plan." }], encrypted_content: "synthetic-encrypted" }] : [])
    if (compatible) expect(body.input.slice(1, 5).map((p: Wire) => p.type ?? p.role)).toEqual(["reasoning", "function_call", "assistant", "function_call"])
  } else if (route === "anthropic") {
    const content = body.messages.find((m: Wire) => m.role === "assistant").content
    expect(content.filter((p: Wire) => p.type === "thinking")).toEqual(compatible ? [{ type: "thinking", thinking: "Synthetic plan.", signature: "synthetic-anthropic-signature" }] : [])
    if (compatible) expect(content.map((p: Wire) => p.type)).toEqual(["thinking", "tool_use", "text", "tool_use"])
  } else if (route === "gemini") {
    const parts = body.contents.find((m: Wire) => m.role === "model").parts
    expect(parts.filter((p: Wire) => p.thought)).toEqual(compatible ? [{ text: "Synthetic plan.", thought: true, thoughtSignature: "synthetic-thought-signature" }] : [])
    expect(parts.filter((p: Wire) => p.functionCall).map((p: Wire) => p.thoughtSignature)).toEqual(compatible ? ["synthetic-call-a", "synthetic-call-b"] : [undefined, undefined])
    if (compatible) {
      expect(parts.map((p: Wire) => p.functionCall ? "call" : p.thought ? "thought" : "text")).toEqual(["thought", "call", "text", "call"])
      expect(parts[2]).toEqual({ text: "Checking both files.", thoughtSignature: "synthetic-text-signature" })
    }
  } else {
    const content = body.messages.find((m: Wire) => m.role === "assistant").content
    const reasoning = content.filter((p: Wire) => p.reasoningContent)
    expect(reasoning).toHaveLength(compatible ? 2 : 0)
    if (compatible) {
      expect(reasoning[0]).toEqual({ reasoningContent: { reasoningText: { text: "Synthetic plan.", signature: "synthetic-bedrock-signature" } } })
      expect(Array.from(reasoning[1].reasoningContent.redactedContent)).toEqual([1, 2, 3])
    }
    if (compatible) expect(content.map((p: Wire) => p.reasoningContent ? "reasoning" : p.toolUse ? "call" : "text")).toEqual(["reasoning", "call", "text", "reasoning", "call"])
  }
}

function assertPolicyToolsCap(route: CorpusRoute, body: Wire): void {
  if (route === "chat") {
    expect(body.messages[0]).toEqual({ role: "system", content: "Inspect the two fixture files." })
    expect(body.tools).toEqual([{ type: "function", function: { name: "read", description: "Read a fixture file.", parameters: schema } }])
    expect(body.max_tokens).toBe(2048)
  } else if (route === "responses" || route === "subscription") {
    expect(body.instructions).toBe("Inspect the two fixture files.")
    const tool = { type: "function", name: "read", description: "Read a fixture file.", parameters: schema }
    expect(body.tools).toEqual(route === "subscription" ? [{ type: "namespace", name: "ih", description: "I-harness local tools", tools: [tool] }] : [tool])
    expect(body.max_output_tokens).toBe(route === "subscription" ? undefined : 2048)
    if (route === "subscription") {
      expect(body).not.toHaveProperty("max_tokens")
      expect(body).not.toHaveProperty("max_completion_tokens")
      expect(body.store).toBe(false)
      expect(body.include).toContain("reasoning.encrypted_content")
      expect(body.parallel_tool_calls).toBe(true)
      expect(body.tool_choice).toBe("auto")
    }
  } else if (route === "anthropic") {
    expect(body.system).toBe("Inspect the two fixture files.")
    expect(body.tools).toEqual([{ name: "read", description: "Read a fixture file.", input_schema: schema }])
    expect(body.max_tokens).toBe(2048)
  } else if (route === "gemini") {
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Inspect the two fixture files." }] })
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: "read", description: "Read a fixture file.", parameters: schema }] }])
    expect(body.generationConfig.maxOutputTokens).toBe(2048)
  } else {
    expect(body.system).toEqual([{ text: "Inspect the two fixture files." }])
    expect(body.toolConfig).toEqual({ tools: [{ toolSpec: { name: "read", description: "Read a fixture file.", inputSchema: { json: schema } } }] })
    expect(body.inferenceConfig.maxTokens).toBe(2048)
  }
}

async function send(prepared: PreparedModelRequest, capture: CapturedRequest[]): Promise<Wire> {
  const before = capture.length
  const events = []
  for await (const event of prepared.stream()) events.push(event)
  expect(events.filter(event => event.type === "error")).toEqual([])
  expect(capture).toHaveLength(before + 1)
  const sent = capture[before]
  if (sent.kind === "http-json-body") {
    expect(prepared.measurement.packet.sizeKind).toBe("http-json-body")
    expect(prepared.measurement.packet.bodyBytes).toBe(Buffer.byteLength(sent.raw, "utf8"))
    expect(prepared.measurement.packet.sdkCommandBytesEstimate).toBeUndefined()
  } else {
    expect(sent.commandName).toBe("ConverseStreamCommand")
    expect(prepared.measurement.packet.sizeKind).toBe("sdk-command-estimate")
    expect(prepared.measurement.packet.bodyBytes).toBeUndefined()
    expect(prepared.measurement.packet.sdkCommandBytesEstimate).toBe(Buffer.byteLength(JSON.stringify(sent.body), "utf8"))
  }
  return sent.body
}

function damageResult(route: CorpusRoute, body: Wire, missing: boolean): void {
  if (route === "chat") {
    const i = body.messages.findIndex((m: Wire) => m.role === "tool")
    if (missing) body.messages.splice(i, 1); else body.messages[i].tool_call_id = "wrong-id"
  } else if (route === "responses" || route === "subscription") {
    const i = body.input.findIndex((m: Wire) => m.type === "function_call_output")
    if (missing) body.input.splice(i, 1); else body.input[i].call_id = "wrong-id"
  } else if (route === "gemini") {
    const parts = body.contents.find((m: Wire) => m.parts.some((p: Wire) => p.functionResponse)).parts
    if (missing) parts.pop(); else parts[0].functionResponse.id = "wrong-id"
  } else {
    const blocks = body.messages.find((m: Wire) => Array.isArray(m.content) && m.content.some((p: Wire) => route === "anthropic" ? p.type === "tool_result" : p.toolResult)).content
    if (missing) blocks.pop(); else if (route === "anthropic") blocks[0].tool_use_id = "wrong-id"; else blocks[0].toolResult.toolUseId = "wrong-id"
  }
}

function loseNative(route: CorpusRoute, body: Wire): void {
  if (route === "chat") delete body.messages.find((m: Wire) => m.tool_calls).reasoning_content
  else if (route === "responses" || route === "subscription") delete body.input.find((p: Wire) => p.type === "reasoning").encrypted_content
  else if (route === "anthropic") delete body.messages.find((m: Wire) => m.role === "assistant").content.find((p: Wire) => p.type === "thinking").signature
  else if (route === "gemini") delete body.contents.find((m: Wire) => m.role === "model").parts[0].thoughtSignature
  else delete body.messages.find((m: Wire) => m.role === "assistant").content[0].reasoningContent.reasoningText.signature
}

describe.each(corpusRoutes)("real prepared adapter: %s", route => {
  // Rejects serializer loss of authority/schema/call pairings and mutable caller aliases.
  it("physically sends frozen inputs and native order through an output-cap derivative", async () => {
    const transport = installTransport(route)
    const options = { text: { verbosity: "low" } }
    const client = makeClient(route, transport, { options })
    const { session, request } = makeToolRound(route)
    const source = toJSONL(session)
    const prepared = await client.prepare!(request)
    expect(transport.captures).toHaveLength(0)
    expect(transport.authCalls()).toBe(0)
    const capped = prepared.withOutputCap(2048)
    expect(capped.measurement.input).toEqual(prepared.measurement.input)
    expect(prepared.measurement.output.effectiveCap).toBe(route === "subscription" ? undefined : 1024)
    expect(capped.measurement.output.effectiveCap).toBe(route === "subscription" ? undefined : 2048)
    if (route === "subscription") expect(capped.measurement.output.capSupport).toBe("unsupported")
    request.systemPrompt = "MUTATED"
    const assistant = request.messages.find(m => m.role === "assistant")!
    if (assistant.role !== "assistant") throw new Error("fixture missing assistant")
    ;(assistant.toolCalls![0].args as { path: string }).path = "MUTATED"
    if (assistant.providerContinuation) assistant.providerContinuation.model = "MUTATED"
    ;((request.tools[0].inputSchema as Wire).properties.path as Wire).type = "MUTATED"
    request.messages.length = 0
    request.tools[0].inputSchema = { MUTATED: true }
    request.tools.length = 0
    options.text.verbosity = "MUTATED"
    const body = await send(capped, transport.captures)
    assertPolicyToolsCap(route, body)
    assertGroupedWire(route, body)
    assertNative(route, body)
    expect(route === "bedrock" ? body.additionalModelRequestFields.text : body.text).toEqual({ verbosity: "low" })
    expect(JSON.stringify(body)).not.toContain("MUTATED")
    expect(JSON.stringify(body)).toContain("Continue with the current input.")
    expect(toJSONL(session)).toBe(source)
    expect(transport.authCalls()).toBe(route === "subscription" ? 1 : 0)
  })

  // Rejects replaying native blocks against a different model's provenance.
  it("uses the route's foreign-model fallback while retaining legal tool pairs", async () => {
    const transport = installTransport(route)
    const { request } = makeToolRound(route)
    const assistant = request.messages.find(m => m.role === "assistant")!
    if (assistant.role !== "assistant" || !assistant.providerContinuation) throw new Error("fixture missing native data")
    assistant.providerContinuation.model = "foreign-model"
    const body = await send(await makeClient(route, transport).prepare!(request), transport.captures)
    assertGroupedWire(route, body)
    assertNative(route, body, false)
  })

  // Rejects the repaired regression: shadowed step/start detaches a later committed block.
  it.each([false, true])("keeps the committed compacted block and raw events intact (JSONL reload=%s)", async reload => {
    const transport = installTransport(route)
    const { session, request } = makeCompactedToolRound(route)
    const source = toJSONL(session)
    const live = deriveMessages(session)
    const restored = fromJSONL(source)
    expect(deriveMessages(restored)).toEqual(live)
    expect(live[0]).toEqual({ role: "user", content: "The original task is retained by this controlled checkpoint." })
    expect(live.filter(m => m.role === "assistant")).toHaveLength(1)
    expect(live.filter(m => m.role === "tool").map(m => m.toolCallId)).toEqual(["read-b", "read-a"])
    const body = await send(await makeClient(route, transport).prepare!({ ...request, messages: deriveMessages(reload ? restored : session) }), transport.captures)
    assertGroupedWire(route, body)
    assertNative(route, body)
    expect(toJSONL(session)).toBe(source)
    expect(toJSONL(restored)).toBe(source)
    expect(JSON.stringify(body)).toContain("Tool reminder.")
    expect(JSON.stringify(body)).toContain("Continue with the current input.")
  })

  // Rejects physical sends from invalidated prepared input or an already-aborted owner.
  it.each(["stale", "aborted"] as const)("prevents %s input from reaching transport", async reason => {
    const transport = installTransport(route)
    const prepared = (await makeClient(route, transport).prepare!(makeToolRound(route).request)).withOutputCap(2048)
    expect(transport.captures).toHaveLength(0)
    expect(transport.authCalls()).toBe(0)
    const abort = new AbortController()
    if (reason === "aborted") abort.abort(new Error("corpus aborted"))
    const execute = async () => {
      for await (const _event of prepared.stream({ signal: abort.signal, validateBeforeTransport: () => { throw new Error("corpus stale") } })) { /* drain */ }
    }
    await expect(execute()).rejects.toThrow(reason === "stale" ? "corpus stale" : "corpus aborted")
    expect(transport.captures).toHaveLength(0)
  })

  // Rejects image-as-text leakage or destructive text-only source sanitization.
  it.each([false, true])("projects typed image bytes only for image-capable input (vision=%s)", async vision => {
    const transport = installTransport(route)
    const session = createSession()
    append(session, { type: "user/message", text: "Inspect this pixel.", images: [{ mediaType: "image/png", dataBase64: png }] })
    const source = toJSONL(session)
    const request: LLMRequest = { systemPrompt: "Image projection.", tools: [], messages: deriveMessages(session) }
    const prepared = await makeClient(route, transport, { vision }).prepare!(request)
    const body = await send(prepared, transport.captures)
    expect(prepared.measurement.input.components.images.imageCount).toBe(vision ? 1 : 0)
    expect(prepared.measurement.packet.inlineBinaryBytes).toBe(vision ? 70 : 0)
    if (!vision) expect(JSON.stringify(body)).not.toContain(png)
    else {
      expect(prepared.measurement.input.uncertainties).toContain("image-token-cost")
      if (route === "chat") expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } })
      else if (route === "responses" || route === "subscription") expect(body.input[0].content[1]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${png}` })
      else if (route === "anthropic") expect(body.messages[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: png } })
      else if (route === "gemini") expect(body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: png } })
      else expect(body.messages[0].content[1]).toEqual({ image: { format: "png", source: { bytes: Buffer.from(png, "base64") } } })
      // Base64 is allowed only inside typed image fields, never visible text.
      const textValues: string[] = []
      const visit = (value: any): void => {
        if (Array.isArray(value)) { value.forEach(visit); return }
        if (!value || typeof value !== "object" || value instanceof Uint8Array) return
        for (const [key, item] of Object.entries(value)) { if ((key === "text" || key === "content") && typeof item === "string") textValues.push(item); else visit(item) }
      }
      visit(body)
      expect(textValues.join("\n")).not.toContain(png)
    }
    expect(toJSONL(session)).toBe(source)
    expect(deriveMessages(fromJSONL(source))).toEqual(request.messages)
  })
})

// Harness control: even a missed barrel mock has no fallback to proxy discovery/HTTP.
it("quarantines unexpected global fetch and the underlying systemFetch implementation", async () => {
  const transport = installTransport("subscription")
  expect(vi.isMockFunction(quarantinedSystemFetch)).toBe(true)
  await expect((async () => quarantinedSystemFetch("https://unexpected.invalid"))()).rejects.toThrow("corpus physical network quarantined")
  await expect(globalThis.fetch("https://unexpected.invalid")).rejects.toThrow("subscription used global fetch")
  expect(transport.captures).toHaveLength(0)
})

// Rejects validation placed before an execution-time auth await, allowing stale sends.
it("subscription revalidates a cap derivative after held auth and before systemFetch", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const transport = installTransport("subscription")
  const client = makeClient("subscription", transport, { auth: async () => { entered.resolve(); await release.promise; return { accessToken: "fixture", accountId: "fixture" } } })
  const prepared = await client.prepare!(makeToolRound("subscription").request)
  expect(transport.captures).toHaveLength(0)
  let current = true, checks = 0
  const run = (async () => { for await (const _event of prepared.withOutputCap(2048).stream({ validateBeforeTransport: () => { checks++; if (!current) throw new Error("stale after held auth") } })) { /* drain */ } })()
  await entered.promise
  expect(checks).toBe(0)
  current = false
  release.resolve()
  await expect(run).rejects.toThrow("stale after held auth")
  expect(checks).toBe(1)
  expect(transport.captures).toHaveLength(0)
})

// Rejects treating archived raw history bytes as active input or leaking shadowed results.
it("prices the actual bounded six-route projection of a >100MiB JSONL-equivalent archive", async () => {
  const session = createSession()
  const archived = "archived tool content ".repeat(100_000)
  for (let index = 0; index < 60; index++) {
    append(session, { type: "step/start" })
    append(session, { type: "tool/call", callId: `archived-${index}`, name: "read", args: {} })
    append(session, { type: "assistant/message", text: "Earlier read." })
    append(session, { type: "tool/result", callId: `archived-${index}`, name: "read", output: archived })
    append(session, { type: "step/end" })
  }
  const eventCount = session.events.length
  append(session, { type: "compaction/summary", text: "Sixty prior reads are archived. Continue the authorized task.", shadowedSeqs: Array.from({ length: eventCount }, (_, i) => i) })
  append(session, { type: "user/message", text: "Continue with the current input." })
  // Count JSONL header/newline/event bytes without constructing or persisting a huge log.
  const rawBytes = Buffer.byteLength(JSON.stringify({ formatVersion: session.formatVersion })) + 1 + session.events.reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)) + 1, 0)
  expect(rawBytes).toBeGreaterThan(100 * 1024 * 1024)
  const messages = deriveMessages(session)
  expect(messages).toEqual([{ role: "user", content: "Sixty prior reads are archived. Continue the authorized task." }, { role: "user", content: "Continue with the current input." }])
  const metrics = []
  for (const route of corpusRoutes) {
    const transport = installTransport(route)
    const prepared = await makeClient(route, transport).prepare!({ systemPrompt: "Controlled archive projection.", tools: [], messages })
    const body = await send(prepared, transport.captures)
    const packet = prepared.measurement.packet
    expect(packet.bodyBytes ?? packet.sdkCommandBytesEstimate).toBeLessThan(2048)
    const projectedTokens = Object.values(prepared.measurement.input.components).reduce((n, c) => n + c.heuristicTokens, 0)
    expect(projectedTokens).toBeGreaterThan(0)
    expect(projectedTokens).toBeLessThan(512)
    expect(JSON.stringify(body)).not.toContain("archived tool content")
    metrics.push({ route, sizeKind: packet.sizeKind, bytes: packet.bodyBytes ?? packet.sdkCommandBytesEstimate, projectedHeuristicTokens: projectedTokens })
  }
  expect(session.events).toHaveLength(302)
  expect(session.events[3]).toMatchObject({ type: "tool/result", output: archived })
  console.info("context-corpus archive projection", JSON.stringify({ rawJsonlEquivalentBytes: rawBytes, events: session.events.length, activeMessages: messages.length, routes: metrics }))
})

describe.each(corpusRoutes)("oracle controls on captured copies: %s", route => {
  // These are intentionally test-oracle controls, not claims of adapter validation.
  it("rejects a missing result, wrong result ID, and lost native signature/data", async () => {
    const transport = installTransport(route)
    const body = await send(await makeClient(route, transport).prepare!(makeToolRound(route).request), transport.captures)
    assertGroupedWire(route, body)
    assertNative(route, body)
    // Establish that a harmless copy still passes before introducing each defect.
    assertGroupedWire(route, structuredClone(body))
    assertNative(route, structuredClone(body))
    for (const missing of [true, false]) {
      const malformed = structuredClone(body)
      damageResult(route, malformed, missing)
      expect(() => assertGroupedWire(route, malformed)).toThrow()
    }
    const unsigned = structuredClone(body)
    loseNative(route, unsigned)
    expect(() => assertNative(route, unsigned)).toThrow()
  })
})
