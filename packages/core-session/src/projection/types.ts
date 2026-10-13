import type { ImageInput } from "../images.ts"

/** Signed provider blocks are retained for a tool continuation. They are
 * opaque protocol data; the UI and search index use assistant text instead. */
export type ProviderThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }

/** Opaque state needed when a provider continues an assistant tool turn. */
export type ProviderBlockOrderEntry =
  | { kind: "reasoning"; index: number }
  | { kind: "tool"; index: number }
  | { kind: "text"; text: string; phase?: string | null; thoughtSignature?: string }

export type ProviderContinuation =
  | { kind: "anthropic"; model: string; providerId?: string; contentOrder?: ProviderBlockOrderEntry[]; prefixFingerprint?: string; toolBindings?: { id?: string; name: string; inputJson: string }[] }
  | { kind: "openai-compatible"; reasoningContent: string; model?: string; providerId?: string }
  | { kind: "openai-responses"; reasoningItems: Record<string, unknown>[]; model?: string; providerId?: string; outputOrder?: ProviderBlockOrderEntry[] }
  | { kind: "gemini"; callSignatures: (string | null)[]; model?: string; providerId?: string; thoughtParts?: { text: string; thoughtSignature?: string }[]; textSignature?: string; emptyTextSignatures?: string[]; partOrder?: ProviderBlockOrderEntry[]; callBindings?: { id?: string; name: string; argsJson: string }[] }
  | { kind: "bedrock"; reasoningBlocks: ({ reasoningText: { text: string; signature: string } } | { redactedContentBase64: string })[]; model?: string; providerId?: string; contentOrder?: ProviderBlockOrderEntry[] }

export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageInput }

export type LLMMessage =
  | { role: "user"; content: string | LLMContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: { id: string; name: string; args: unknown }[]; thinkingBlocks?: ProviderThinkingBlock[]; providerContinuation?: ProviderContinuation }
  | { role: "tool"; toolCallId: string; content: string | LLMContentPart[]; isError?: true }
