import { expect, it } from "vitest"
import { append, createSession, renderConversation } from "@i-harness/core-session"
import { captureContextSnapshot } from "../src/index.ts"
import type { ModelBudgetBinding } from "@i-harness/llm-seam"

it("owns nested model evidence and changes the surface digest when only provenance changes", () => {
  const budgetBinding: ModelBudgetBinding = { version: 1, metadata: { version: 1, modelId: "m", protocol: "gemini", identityCoverage: "partial" },
    limits: { contextTokens: { value: 1000, origin: "profile", sourceId: "profile-v1" } }, generation: { origin: "unspecified" },
    capability: { version: 1, route: "gemini", evidenceId: "adapter-budget-v1:gemini", outputParameter: "optional", packetKind: "http-json-body" } }
  const session = createSession(), surface = { systemPrompt: "p", tools: [], budgetBinding }
  const first = captureContextSnapshot(session, { ownerSessionId: "owner", surface })
  if (first.kind !== "captured") throw new Error("capture required")
  ;(budgetBinding.limits.contextTokens as { sourceId: string }).sourceId = "profile-revised-v1"
  const second = captureContextSnapshot(session, { ownerSessionId: "owner", surface })
  if (second.kind !== "captured") throw new Error("capture required")
  expect(first.snapshot.surface.budgetBinding?.limits.contextTokens).toEqual({ value: 1000, origin: "profile", sourceId: "profile-v1" })
  expect(Object.isFrozen(first.snapshot.surface.budgetBinding?.limits.contextTokens)).toBe(true)
  expect(Object.isFrozen(budgetBinding.limits.contextTokens)).toBe(false)
  expect(second.snapshot.surfaceRevision).not.toBe(first.snapshot.surfaceRevision)
})

it("publishes a detached recursively immutable request and fresh renderer copies", () => {
  const session = createSession()
  const args = { nested: { x: [1, 2] } }
  const thinking = [{ type: "thinking" as const, thinking: "reason", signature: "signature" }]
  const native = { kind: "anthropic" as const, model: "m", contentOrder: [{ kind: "text" as const, text: "answer" }] }
  const image = { mediaType: "image/png" as const, dataBase64: "aGVsbG8=" }
  append(session, { type: "user/message", text: "task", images: [image] })
  append(session, { type: "tool/call", callId: "c", name: "probe", args })
  append(session, { type: "assistant/message", text: "answer", thinkingBlocks: thinking, providerContinuation: native })
  append(session, { type: "tool/result", callId: "c", name: "probe", output: { ok: true } })
  const schema = { name: "probe", description: "probe", inputSchema: { nested: { value: 1 } } }
  const result = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [schema] } })
  expect(result.kind).toBe("captured")
  if (result.kind !== "captured") throw new Error("capture required")
  const snapshot = result.snapshot
  const before = JSON.stringify(snapshot)
  args.nested.x.push(3); thinking[0]!.signature = "changed"; native.contentOrder[0]!.text = "changed"; image.dataBase64 = "changed"; schema.inputSchema.nested.value = 2
  const rendered = renderConversation(snapshot.conversation)
  const assistant = rendered.find(message => message.role === "assistant" && message.toolCalls?.length)
  if (assistant?.role === "assistant") {
    (assistant.toolCalls![0]!.args as { nested: { x: number[] } }).nested.x.push(9)
    if (assistant.thinkingBlocks?.[0]?.type === "thinking") assistant.thinkingBlocks[0].signature = "adapter signature"
  }
  rendered[0]!.content = "adapter changed"
  expect(JSON.stringify(snapshot)).toBe(before)
  expect(Object.isFrozen(snapshot.surface.tools[0]!.inputSchema)).toBe(true)
  expect(Object.isFrozen(args)).toBe(false)
  expect(Object.isFrozen(session.events)).toBe(false)
})

it.each(["args", "output", "native", "images", "outcome"])("rejects an accessor in visible %s without invoking it", field => {
  const session = createSession()
  let reads = 0
  const value = Object.defineProperty({}, field === "outcome" ? "code" : "secret", { enumerable: true, get() { reads++; return "private" } })
  append(session, { type: "tool/call", callId: "c", name: "probe", args: field === "args" ? value : {} })
  append(session, { type: "assistant/message", text: "answer", ...(field === "native" ? { providerContinuation: value as never } : {}) })
  session.events.push({ seq: session.events.length, type: "tool/result", callId: "c", name: "probe", ...(field === "outcome" ? { isError: true } : {}), output: field === "output" || field === "outcome" ? value : field === "images" ? { images: value } : "ok" })
  const result = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [] } })
  expect(result).toMatchObject({ kind: "unsupported", code: "CONTEXT_SNAPSHOT_UNSUPPORTED", component: "conversation" })
  expect(reads).toBe(0)
  expect(JSON.stringify(result)).not.toMatch(/secret|private/)
})

it("does not inspect suppressed failed payloads or pruned raw output", () => {
  const session = createSession()
  let reads = 0
  const raw = Object.defineProperty({}, "private", { enumerable: true, get() { reads++; throw Error("executed") } })
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "failed", name: "probe", args: raw }); append(session, { type: "step/failed" })
  append(session, { type: "tool/call", callId: "pruned", name: "probe", args: {} })
  append(session, { type: "tool/result", callId: "pruned", name: "probe", output: raw })
  append(session, { type: "compaction/prune", version: 1, pruned: [{ callId: "pruned", head: "head", tail: "tail", removedBytes: 20 }] })
  expect(captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [] } }).kind).toBe("captured")
  expect(reads).toBe(0)
})

it("captures and renders deeply nested JSON args without a recursive walk overflow", () => {
  const session = createSession()
  let args: unknown = { leaf: "retained" }
  for (let i = 0; i < 6000; i++) args = { child: args }
  append(session, { type: "tool/call", callId: "deep", name: "probe", args })
  append(session, { type: "tool/result", callId: "deep", name: "probe", output: "ok" })
  const result = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "s", tools: [] } })
  expect(result.kind).toBe("captured")
  if (result.kind !== "captured") throw Error("capture required")
  const rendered = renderConversation(result.snapshot.conversation)
  expect(rendered[0]?.role).toBe("assistant")
})
