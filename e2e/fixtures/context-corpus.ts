import { append, createSession, deriveMessages, type ProviderContinuation, type Session } from "../../packages/core-session/src/index.ts"
import type { LLMRequest } from "../../packages/llm-seam/src/index.ts"

export type CorpusRoute = "chat" | "responses" | "subscription" | "anthropic" | "gemini" | "bedrock"
export const corpusRoutes: readonly CorpusRoute[] = Object.freeze(["chat", "responses", "subscription", "anthropic", "gemini", "bedrock"])
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

function nativeContinuation(route: CorpusRoute): ProviderContinuation {
  const provenance = { model: "fixture", providerId: "fixture" }
  const order = [{ kind: "reasoning" as const, index: 0 }, { kind: "tool" as const, index: 0 }, { kind: "text" as const, text: "Checking both files." }, { kind: "tool" as const, index: 1 }]
  switch (route) {
    case "chat": return { ...provenance, kind: "openai-compatible", reasoningContent: "Synthetic plan." }
    case "responses":
    case "subscription": return { ...provenance, kind: "openai-responses", reasoningItems: [{ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "Synthetic plan." }], encrypted_content: "synthetic-encrypted" }], outputOrder: order }
    // A legacy native envelope without prefixFingerprint is intentional: this fixture
    // protects replay/grouping across compaction, not newly issued prefix binding.
    case "anthropic": return { ...provenance, kind: "anthropic", contentOrder: order }
    case "gemini": return {
      ...provenance, kind: "gemini", callSignatures: ["synthetic-call-a", "synthetic-call-b"],
      thoughtParts: [{ text: "Synthetic plan.", thoughtSignature: "synthetic-thought-signature" }],
      callBindings: [{ id: "read-a", name: "read", argsJson: '{"path":"a"}' }, { id: "read-b", name: "read", argsJson: '{"path":"b"}' }],
      partOrder: order.map(entry => entry.kind === "text" ? { ...entry, thoughtSignature: "synthetic-text-signature" } : entry),
    }
    case "bedrock": return {
      ...provenance, kind: "bedrock",
      reasoningBlocks: [{ reasoningText: { text: "Synthetic plan.", signature: "synthetic-bedrock-signature" } }, { redactedContentBase64: "AQID" }],
      contentOrder: [...order.slice(0, 3), { kind: "reasoning", index: 1 }, order[3]],
    }
  }
}

function buildToolRound(route: CorpusRoute, compacted: boolean): { session: Session; request: LLMRequest } {
  const session = createSession()
  append(session, { type: "user/message", text: "Read files a and b." })
  append(session, { type: "step/start" })
  if (compacted) append(session, { type: "compaction/summary", text: "The original task is retained by this controlled checkpoint.", shadowedSeqs: [0, 1] })
  append(session, { type: "tool/call", callId: "read-a", name: "read", args: { path: "a" } })
  append(session, { type: "tool/call", callId: "read-b", name: "read", args: { path: "b" } })
  append(session, {
    type: "assistant/message", text: "Checking both files.", providerContinuation: nativeContinuation(route),
    ...(route === "anthropic" ? { thinkingBlocks: [{ type: "thinking" as const, thinking: "Synthetic plan.", signature: "synthetic-anthropic-signature" }] } : {}),
  })
  append(session, { type: "tool/result", callId: "read-b", name: "read", output: { file: "b", text: "B" } })
  if (compacted) append(session, { type: "user/message", text: "Tool reminder." })
  append(session, { type: "tool/result", callId: "read-a", name: "read", output: { file: "a", text: "A" } })
  append(session, { type: "step/end" })
  append(session, { type: "user/message", text: "Continue with the current input." })
  return {
    session,
    request: {
      systemPrompt: "Inspect the two fixture files.",
      // Owned request objects permit hostile caller mutation without editing source events.
      messages: structuredClone(deriveMessages(session)), maxOutputTokens: 1024,
      tools: [{ name: "read", description: "Read a fixture file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }],
    },
  }
}

export function makeToolRound(route: CorpusRoute): { session: Session; request: LLMRequest } { return buildToolRound(route, false) }
export function makeCompactedToolRound(route: CorpusRoute): { session: Session; request: LLMRequest } { return buildToolRound(route, true) }
