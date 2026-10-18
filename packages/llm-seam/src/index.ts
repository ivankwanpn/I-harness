import type { LLMMessage, LLMContentPart, ModelRetryInfo, ProviderContinuation, ProviderThinkingBlock, Session } from "@i-harness/core-session"
import { deriveMessages, renderConversation, stringifyJsonData } from "@i-harness/core-session"
import { createHash } from 'node:crypto'
import { InvalidImageError, validateImage } from '@i-harness/image-validation'

/**
 * M5 T2: the provider's OWN usage report for one round-trip.
 *
 * Every field is optional, and **absent stays distinguishable from zero** — a
 * provider that never mentions the cache must not produce `cacheReadTokens: 0`,
 * because that reads as a measurement. Adapters report what the wire said, when
 * it said it; a single request may report twice (Anthropic's `message_start`
 * carries the input side and `message_delta` the output side), and the CONSUMER
 * merges. Adapters therefore hold no buffering state of their own.
 *
 * These are native field NAMES normalized once, not a semantic model of the
 * cache: the roadmap's Q3 forbids inventing a unified "epoch", and nothing here
 * derives one. This is the same job the seam already does for `text/chunk` and
 * `tool_call` across five wire protocols. Raw counters are never summed here.
 * Adapters declare inputTokenSemantics when known, allowing the token meter to
 * derive a separate full input total without double-counting cache-inclusive
 * protocols. Unknown accounting stays uncalibrated.
 */
export interface LLMUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** Adapter-declared accounting; unknown routes leave it absent. Raw input
   * counts stay raw, while consumers may derive a separate full input total. */
  inputTokenSemantics?: "includes-cache" | "excludes-cache"
}

/**
 * M77: a provider REFUSAL gets a bit here, deliberately the same shape as
 * M72 Ⅱ's `truncated` on the same member. The five adapters all report a
 * refusal as HTTP 200 with no content — openai's and openai-compatible's
 * `content_filter`, gemini's `SAFETY` / `RECITATION`, anthropic's
 * `stop_reason: "refusal"`, bedrock's `guardrail_intervened` — so without this
 * bit the seam reports an empty SUCCESS: core-agent logs an empty assistant
 * message, the turn ends normally and the CLI prints nothing. Three properties
 * are the design, not decoration:
 *
 * 1. SEMANTIC, not wire vocabulary: those literals stay in the five adapters
 *    and never enter this union — M72 Ⅱ's explicit constraint
 *    (`docs/superpowers/plans/2026-09-23-provider-boundary-phase-2.md:22`).
 *    The seam learns "the provider refused", never which filter said so.
 * 2. A FIELD on the existing `end` member, NOT a new union member: neither
 *    consumer of this union is exhaustive, and neither would READ a new member
 *    as an ending. core-agent's model-stream `switch` drops it in silence — no
 *    `default`, no exhaustiveness assert, its own words in the `case "usage"`
 *    arm's comment (`packages/core-agent/src/index.ts`; cited by SYMBOL, not by
 *    line: this unit's own edits moved those lines once already) — so the
 *    ending is never learned, which is the exact failure this bit exists to
 *    remove. The retry wrapper (`createRetryingClient`) does not DROP a new
 *    member but does not recognize it either: only
 *    `text/chunk`/`reasoning`/`tool_call` count as output, `usage` is held
 *    aside, `end` is its one explicit return, and everything unmatched is
 *    forwarded by its trailing `yield ev` — so an attempt whose ending was a new
 *    member would reach the consumer undecided and be settled as a completion
 *    with no `end`. A field, by contrast, leaves every existing `=== true`
 *    reader working: core-agent's `if (ev.truncated === true)` in the same
 *    `case "end"` arm reads the new bit without being touched.
 * 3. ABSENT STAYS ABSENT: only `true` is ever written, never `false` — the rule
 *    core-agent states for `truncated` in that `case "end"` arm's comment ("a
 *    clean ending writes no field at all"). `refused` and `truncated` are
 *    INDEPENDENT — a response can be both — so neither bit may be produced as
 *    the other's `else`.
 */
export type LLMStreamEvent =
  | { type: "activity"; activity: import("@i-harness/core-session").ModelActivityInfo }
  | { type: "retry"; retry: ModelRetryInfo }
  | { type: "text/chunk"; text: string }
  | { type: "reasoning"; text: string; blockId?: string }
  | { type: "tool_call"; call: { id?: string; name: string; args: unknown } }
  | { type: "usage"; usage: LLMUsage }
  | { type: "end"; truncated?: true; refused?: true; thinkingBlocks?: ProviderThinkingBlock[]; providerContinuation?: ProviderContinuation }
  | { type: "error"; error: Error }

// LLMMessage is owned by core-session (it is the audit seam for the session
// log); llm-seam re-exports it rather than re-declaring a duplicate type.
export type { LLMMessage, LLMContentPart, ModelRetryInfo, ModelActivityInfo, ImageInput, ImageMediaType, ProviderThinkingBlock, ProviderContinuation, ProviderBlockOrderEntry } from "@i-harness/core-session"

/** Native replay metadata belongs to the route that produced it. Older logs
 * without provenance remain readable; new records reject a different model or
 * provider profile before protocol serialization. */
export function canReplayContinuation(
  source: { model?: string; providerId?: string },
  target: { model: string; providerId?: string },
): boolean {
  return (source.model === undefined || source.model === target.model)
    && (source.providerId === undefined || source.providerId === target.providerId)
}

/** Rebuild a provider's assistant block order without trusting stale metadata.
 * The neutral message remains authoritative for text and tool arguments; an
 * invalid or rewritten order returns undefined for the adapter's legacy path. */
export function replayBlockOrder<T>(
  order: readonly import("@i-harness/core-session").ProviderBlockOrderEntry[] | undefined,
  content: string,
  reasoning: readonly T[],
  tools: readonly T[],
  textBlock: (text: string, phase?: string | null, thoughtSignature?: string) => T,
): T[] | undefined {
  if (!order) return undefined
  const result: T[] = []
  const seenReasoning = new Set<number>()
  const seenTools = new Set<number>()
  let visibleText = ""
  for (const entry of order) {
    if (entry.kind === "text") {
      visibleText += entry.text
      result.push(textBlock(entry.text, entry.phase, entry.thoughtSignature))
    } else if (entry.kind === "reasoning") {
      if (!Number.isSafeInteger(entry.index) || entry.index < 0 || seenReasoning.has(entry.index) || reasoning[entry.index] === undefined) return undefined
      seenReasoning.add(entry.index)
      result.push(reasoning[entry.index]!)
    } else {
      if (!Number.isSafeInteger(entry.index) || entry.index < 0 || seenTools.has(entry.index) || tools[entry.index] === undefined) return undefined
      seenTools.add(entry.index)
      result.push(tools[entry.index]!)
    }
  }
  return visibleText === content && seenReasoning.size === reasoning.length && seenTools.size === tools.length ? result : undefined
}

export { resolveRetryPolicy, backoffDelay } from './retry/policy.ts'
export type { RetryableErrorCode, RetryBackoffConfig, NormalRetryPolicyConfig, AlwaysRetryPolicyConfig, RetryPolicyConfig, ResolvedRetryBackoff, ResolvedNormalRetryPolicy, ResolvedAlwaysRetryPolicy, ResolvedRetryPolicy } from './retry/policy.ts'

// Provider failure classification and payload-free facts share one public facade.
export { retryErrorCode } from "./provider-error/classify.ts"
export { describeHttpError } from "./provider-error/http.ts"
export { modelFailureFacts, safeModelFailureFacts } from "./provider-error/facts.ts"
export type { ModelFailureFacts } from "./provider-error/types.ts"
import { retryErrorCode } from "./provider-error/classify.ts"
import { modelFailureFacts } from "./provider-error/facts.ts"

export interface ToolSchema {
  name: string
  description: string
  inputSchema: unknown
}

/**
 * M32 six-level reasoning-effort vocabulary (uniform, adapter-agnostic):
 * "off" | "low" | "medium" | "high" | "xhigh" | "max".
 * The DEFAULT is "don't send" (`undefined` → each adapter emits NO effort
 * field; the provider-side default applies — the "don't default any
 * provider" stance). "fail-loud" rule: a value the model does not support is
 * passed through verbatim so the provider's 400 surfaces — adapters never
 * guess, clamp or special-case.
 */
export type ReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max"

/** Route opt-in for explicit prompt-cache metadata. Absence leaves the wire
 * unchanged. Retention controls Anthropic marker TTL only; other protocols
 * must not invent a mapping to their different retention policies. */
export interface PromptCacheConfig {
  mode: "off" | "automatic"
  retention?: "5m" | "1h"
}

export function validatePromptCacheConfig(value: unknown, path = "promptCache"): asserts value is PromptCacheConfig | undefined {
  if (value === undefined) return
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`)
  const config = value as Record<string, unknown>
  if (config.mode !== "off" && config.mode !== "automatic") throw new Error(`${path}.mode must be "off" or "automatic"`)
  if (config.retention !== undefined && config.retention !== "5m" && config.retention !== "1h") throw new Error(`${path}.retention must be "5m" or "1h"`)
  if (Object.keys(config).some((key) => key !== "mode" && key !== "retention")) throw new Error(`${path} contains an unknown field`)
}

/** Host-only identity for one user turn. Reuse the SAME immutable object across
 * steps and retries; create a fresh object for each new turn or independent call.
 * Adapters may weakly attach ephemeral routing state. Never persist that state. */
export interface LLMRequestScope {
  readonly sessionId: string
  readonly turnId: string
  readonly isSubagent?: boolean
}

export interface LLMRequest {
  generation?: import('./prepared/generation.ts').GenerationControl
  onTransportIssue?: () => void
  confirmExecution?: (confirmation: import("./prepared/execution.ts").ExecutionConfirmation) => void
  /** Internal owner guard; wrappers forward it to each physical transport boundary. */
  validateBeforeTransport?: () => void
  /** Host-only conversation scope; never serialize into a provider body. */
  requestScope?: LLMRequestScope
  /** Host-only fallback for an error body that outlives a guard deadline. */
  onTerminalResponse?: (hint: import("./waiting-guard.ts").TerminalResponseHint) => void
  /** Host-only transport milestones; never serialize into protocol input. */
  onStreamActivity?: (kind: import("./waiting-guard.ts").StreamActivity) => void
  /** Host-only: the consumer can discard an uncommitted failed attempt. */
  retryOutput?: "discard"
  /** Host-only usage attribution. Protocol adapters never serialize this field. */
  sessionId?: string
  messages: LLMMessage[]
  tools: ToolSchema[]
  systemPrompt: string
  model?: string
  /** M32: per-request reasoning effort; undefined → do not send (provider default). */
  reasoningEffort?: ReasoningEffort
  /** Per-request intent and opaque session affinity. "off" removes applicable
   * explicit cache metadata; it cannot disable upstream automatic caching.
   * "default" follows the declared route capability, never a URL guess. */
  promptCache?: { mode?: "off" | "default"; key?: string }
  /** M61: the turn's abort signal — adapters hand it to their transport
   * (fetch/`abortSignal`) so CANCEL actually kills a parked request. Without
   * it a provider that never yields could not be interrupted: the agent loop
   * only checks `aborted` AFTER an event arrives, so a hung request left the
   * turn spinning until the socket died. Undefined → no signal (unchanged). */
  signal?: AbortSignal
  /** M72 Ⅱ: this request's output cap — already resolved through the host's
   * chain (a user-written `--max-tokens` wins over the model card) and already
   * clamped against the room this request has left. `undefined` → send NOTHING:
   * four of the five wires treat an absent cap as the provider's own default,
   * and inventing a number here would make every request a statement we cannot
   * back. Anthropic is the one exception and owns its own fallback (its
   * Messages API REJECTS a request without `max_tokens`). */
  maxOutputTokens?: number
}

/** Explicit off wins over either an automatic route or manual wire options. */
export function resolvePromptCacheMode(config: PromptCacheConfig | undefined, intent: LLMRequest["promptCache"]): PromptCacheConfig["mode"] | undefined {
  return intent?.mode === "off" || config?.mode === "off" ? "off" : config?.mode
}

export interface ModelClient {
  readonly executionIdentity?: import("./prepared/execution.ts").LiveExecutionIdentity
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
  prepare?(request: LLMRequest): Promise<import("./prepared/types.ts").PreparedModelRequest>
}

export { createWaitingGuard, reportStreamActivity, type ModelWaitPolicy, type StreamActivity, type TerminalResponseHint } from "./waiting-guard.ts"

export function assertMessagesFromLog(messages: LLMMessage[], source: Session | Parameters<typeof renderConversation>[0]): void {
  // A captured projection is a source-owned view of the log. Revalidating its
  // renderer must not fold a newer live archive into this request in place.
  const logged = "events" in source ? deriveMessages(source) : renderConversation(source)
  const msgJson = stringifyJsonData(messages)
  const logJson = stringifyJsonData(logged)
  if (msgJson !== logJson) throw new Error("model-visible messages must derive from the session log (audit F01-3)")
}

// M14/M15 negative capability: part-level image parts are replaced with a
// deterministic text placeholder (the base64 prefix is a stable correlation
// hint, not the bytes). M15 I3 close: canonical `"dataBase64":"<base64>"`
// occurrences inside tool-role STRING content (≥8-char values) are masked so
// raw base64 bytes from tool results (JSON.stringify(output) can carry
// output.images → dataBase64 fields) don't reach a text-only model — the regex
// matches canonical single-encoded occurrences only, not arbitrary encodings.
// User/assistant string content is untouched — the projection never embeds
// images there.
function maskToolBase64(content: string): string {
  return content.replace(/\"dataBase64\":\"([A-Za-z0-9+/]{8})[A-Za-z0-9+/=]*\"/g, '\"dataBase64\":\"[image omitted: base64:$1]\"')
}

function projectImagesForTextModel(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      if (m.role === "tool") return { ...m, content: maskToolBase64(m.content) }
      return m
    }
    // assistant content is always string, so after the check only user/tool
    // parts messages remain; TS cannot prove it from the typeof guard alone
    // (non-literal property), so narrow explicitly on the role discriminant.
    if (m.role === "assistant") return m
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === "image"
          ? { type: "text" as const, text: `[image omitted: model is text-only; base64:${typeof part.image?.dataBase64 === 'string' ? part.image.dataBase64.slice(0, 8) : 'invalid'}]` }
          : part,
      ),
    }
  })
}

/** Transport-only quarantine. Original events and deriveMessages remain immutable evidence. */
export async function projectImagesForProvider(messages: LLMMessage[], vision: boolean, signal?: AbortSignal): Promise<LLMMessage[]> {
  if (!vision) return projectImagesForTextModel(messages)
  const result: LLMMessage[] = []
  let count = 0, bytes = 0
  for (const message of messages) {
    if (typeof message.content === 'string' || message.role === 'assistant') { result.push(message); continue }
    const content: LLMContentPart[] = []
    for (const part of message.content) {
      if (part.type !== 'image') { content.push(part); continue }
      signal?.throwIfAborted()
      try {
        count++
        bytes += typeof part.image?.dataBase64 === 'string' ? Math.ceil(part.image.dataBase64.length * .75) : 0
        if (count > 200 || bytes > 200 * 1024 * 1024) throw new InvalidImageError('request image count or byte limit exceeded')
        await validateImage(part.image, { signal })
        content.push(part)
      } catch (error) {
        if (!(error instanceof InvalidImageError)) throw error
        const data = typeof part.image?.dataBase64 === 'string' ? part.image.dataBase64 : ''
        const hash = createHash('sha256').update(data).digest('hex').slice(0, 16)
        content.push({ type: 'text', text: `[Image unavailable: ${error.message}; reference ${hash}. Original attachment is preserved in session history. Re-read or regenerate the image.]` })
      }
    }
    result.push({ ...message, content })
  }
  return result
}

/**
 * Turn a rejected `fetch()` into a message that says WHY.
 *
 * Node collapses every pre-response failure — DNS, TCP refused, TLS/cert,
 * proxy — into the identical `TypeError: fetch failed`, keeping the real
 * reason only in `err.cause`. Measured here:
 *
 *   DNS      -> "fetch failed" / cause ENOTFOUND "getaddrinfo ENOTFOUND host"
 *   bad port -> "fetch failed" / cause "bad port"
 *   TLS      -> "fetch failed" / cause DEPTH_ZERO_SELF_SIGNED_CERT
 *
 * So an adapter that reports `err.message` alone tells the operator nothing
 * actionable: a corporate proxy or a TLS-inspecting gateway is INDISTINGUISHABLE
 * from a typo'd baseURL or an offline machine. That exact ambiguity is the
 * complaint behind DSH discussion #175 ("any model fails to connect"), where the
 * fix was an environment variable (Node's fetch does not read the proxy env
 * unless started with NODE_USE_ENV_PROXY / --use-env-proxy) that the error text
 * gave no hint of.
 *
 * This walks the `cause` chain, keeps each link's `code` and message, and
 * appends the same remediation hint the community converged on. It never
 * includes headers or the API key — only the URL and the error text.
 *
 * M72 Ⅰ: that remediation tail is FETCH-specific — it describes Node's fetch
 * proxy/CA behaviour — and it used to be unconditional, so a bedrock
 * `AccessDeniedException` (an AWS SDK auth failure, where neither variable is
 * read) shipped with "unless the process is started with NODE_USE_ENV_PROXY=1".
 * `options.remediation: "none"` opts out: it drops the transport framing and the
 * whole fetch tail, leaving `${label} request failed (${locator}): <chain>`.
 * The DEFAULT is `"fetch"` so the fetch callers' message stays byte-identical.
 */
export async function describeTransportError(
  label: string,
  url: string,
  error: unknown,
  options?: { remediation?: "fetch" | "none" },
): Promise<Error> {
  // A caller-initiated abort is NOT a transport fault; naming it as one sends
  // the operator hunting a network problem that does not exist.
  const aborted = error instanceof Error && error.name === "AbortError"
  if (aborted) return Object.assign(new Error(`${label} request aborted by the caller`, { cause: error }), { name: "AbortError", code: "ABORTED" })

  const chain: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
    if (!(current instanceof Error)) { chain.push(String(current)); break }
    const code = (current as NodeJS.ErrnoException).code
    const detail = current.message
    chain.push(code !== undefined ? `${detail} (${code})` : detail)
    current = current.cause
  }

  let parsed: URL | undefined
  try { parsed = new URL(url) } catch { /* keep the raw text below */ }

  const host = parsed?.host ?? url
  // Return a real Error, not a string: core-agent reads `ev.error.message`, so
  // a bare string would degrade to "undefined".
  const err = new Error(
    (options?.remediation ?? "fetch") === "none"
      ? `${label} request failed${host === "" ? "" : ` (${host})`}: ${chain.join(" <- ")}`
      : `${label} transport failure reaching ${host}: ${chain.join(" <- ")}` +
        " — if this machine reaches the internet through a proxy, Node's fetch ignores" +
        " HTTP(S)_PROXY unless the process is started with NODE_USE_ENV_PROXY=1" +
        " (--use-env-proxy); behind a TLS-inspecting gateway, also set" +
        " NODE_EXTRA_CA_CERTS to the approved CA bundle. Both are read at process start.",
  )
  err.cause = error
  const code = retryErrorCode(error)
  if (code !== undefined) Object.assign(err, { code })
  const modelFailure = modelFailureFacts(error)
  if (modelFailure) Object.assign(err, { modelFailure })
  return err
}

/**
 * M72 Ⅰ: a stream body that was not valid SSE/JSON. Thrown by an adapter's
 * `parseSSE` so the READING LOOP can decide — a corrupt chunk is a provider
 * failure like any other and belongs on the seam's `error` channel, not out of
 * the generator as an exception while the same adapter reports HTTP failures as
 * events. Payload text is deliberately excluded from diagnostics.
 */
export class SSEParseError extends Error {
  constructor(_text: string) {
    super("malformed SSE chunk")
    this.name = "SSEParseError"
  }
}

/**
 * M72 Ⅱ: what Anthropic gets when the chain resolves NOTHING. Its Messages API
 * lists `max_tokens` as required — today every such request is a 400 — so this
 * is the one adapter that must always send a number. The value is Anthropic's
 * documented per-model output ceilings, as consulted 2026-09-23 through a
 * vendor-doc search (secondary source, not a byte-verified fetch — the spec's
 * §6 records why): current-generation Opus/Sonnet-class models document
 * 128,000; Haiku-class 64,000; older generations 8,192 and 4,096. 128,000 is
 * also the value commonly used as the unlisted-model default, i.e. "no
 * practical ceiling", NOT a guess at a reasonable answer. Recorded residual:
 * an older model whose real ceiling is lower will 400 here — which is what it
 * does TODAY as well (no `max_tokens` is also a 400), so this is a strict
 * improvement even before the card arm fires.
 */
export const ANTHROPIC_MAX_TOKENS_FALLBACK = 128_000


export type { PreparedModelRequest, PreparedStreamControl } from "./prepared/types.ts"
export type { PreparedRequestMeasurement, ProjectedInputFacts } from "@i-harness/token-meter"
export { prepareModelRequest } from "./prepared/fallback.ts"
export { wrapPreparedRequest, withPreparedRequests, mapModelRequest, snapshotModelData, preparedControls, freezePreparedFacts, invalidPreparedRequest, validateOutputCap } from "./prepared/wrappers.ts"
export { createPreparedPayload } from "./prepared/payload.ts"
export { createPreparedHttpPayload } from './prepared/http-terminal.ts'
export { assertOwnedPreparedTerminal } from './prepared/owned-terminal.ts'
export type { PreparedValidation, FinalValidator, FinalRejectionReason } from './prepared/validation.ts'
export { assertNativeProducerWitnesses } from './prepared/native-witness.ts'
export { stringifyJsonData } from '@i-harness/core-session'
export { validationCollector, readPreparedValidation } from './prepared/validation.ts'
export { assertPreparedValidation, preparedBindingError } from './prepared/rejection.ts'
export { preparedModelClient } from "./prepared/wrappers.ts"

export { createRetryingClient } from './retry/execution.ts'
export { describeRouteBudgetCapability, type ModelBudgetBinding } from "./binding.ts"

export type { LiveExecutionIdentity, ExecutionConfirmation, ExecutionReceipt, PreparedExecutionContext } from "./prepared/execution.ts"
export { sameExecutionIdentity, validExecutionIdentity, isExecutionControlError } from "./prepared/execution.ts"
export { readPreparedTextOutput, type PreparedTextOutput } from './prepared/text-output.ts'
export { withPreparedSignal, observeModelClient } from './prepared/owned-wrappers.ts'
export { modelExecutionSource } from './prepared/client-source.ts'
export { createStableModelClient } from './prepared/wrappers.ts'
export { createGenerationControl, isGenerationControl, generationError, isGenerationError, generationCandidate, freezeGenerationRetry, NO_GENERATION_RETRY } from './prepared/generation.ts'
export type { GenerationControl, GenerationReservation, GenerationIssue } from './prepared/generation.ts'
export type { AuxiliaryGenerationAction, ApprovalGenerationAction, TitleGenerationFactory, MediaGenerationAction, ToolModelGeneration, ApprovalGenerationFactory, CodeGenerationLineage, CodeGenerationScope } from './prepared/auxiliary.ts'

export { preparedExecutionSource } from './prepared/owned-terminal.ts'
