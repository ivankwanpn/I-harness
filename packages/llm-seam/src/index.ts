import { setTimeout as delay } from "node:timers/promises"
import type { LLMMessage, Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"

export type LLMStreamEvent =
  | { type: "text/chunk"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: { name: string; args: unknown } }
  | { type: "end" }
  | { type: "error"; error: Error }

// LLMMessage is owned by core-session (it is the audit seam for the session
// log); llm-seam re-exports it rather than re-declaring a duplicate type.
export type { LLMMessage, LLMContentPart, ImageInput, ImageMediaType } from "@i-harness/core-session"

export type RetryableErrorCode =
  | "RATE_LIMIT"
  | "SERVER"
  | "TIMEOUT"
  | "TRANSPORT"
  | "EMPTY_RESPONSE"
  | "CONTEXT_WINDOW_EXCEEDED"
  | "QUOTA"

export interface RetryBackoffConfig {
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

export interface NormalRetryPolicyConfig {
  mode: "normal"
  maxRetries?: number
  retryableCodes?: string[]
  backoff?: RetryBackoffConfig
}

export interface AlwaysRetryPolicyConfig {
  mode: "always"
  backoff?: RetryBackoffConfig
}

export type RetryPolicyConfig = NormalRetryPolicyConfig | AlwaysRetryPolicyConfig

export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

export interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: "normal"
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
}

export interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: "always"
}

export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1
const DEFAULT_RETRYABLE_CODES = Object.freeze(["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"])

function resolveBackoff(config: RetryBackoffConfig | undefined, path: string): ResolvedRetryBackoff {
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) throw new Error(`${path}.initialDelayMs must be a positive finite number`)
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) throw new Error(`${path}.maxDelayMs must be a positive finite number`)
  if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be <= maxDelayMs`)
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error(`${path}.jitterRatio must be between 0 and 1`)
  return Object.freeze({ initialDelayMs, maxDelayMs, jitterRatio })
}

export function resolveRetryPolicy(config: RetryPolicyConfig | undefined, path = "retryPolicy"): ResolvedRetryPolicy {
  if (config === undefined) {
    return Object.freeze({ mode: "normal", maxRetries: DEFAULT_MAX_RETRIES, retryableCodes: [...DEFAULT_RETRYABLE_CODES], ...resolveBackoff(undefined, `${path}.backoff`) })
  }
  if (config.mode === "normal") {
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
    const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES]
    if (retryableCodes.length === 0) throw new Error(`${path}.retryableCodes must not be empty`)
    if (new Set(retryableCodes).size !== retryableCodes.length) throw new Error(`${path}.retryableCodes must not contain duplicates`)
    return Object.freeze({ mode: "normal", maxRetries, retryableCodes: Object.freeze([...retryableCodes]), ...resolveBackoff(config.backoff, `${path}.backoff`) })
  }
  if (config.mode === "always") {
    return Object.freeze({ mode: "always", ...resolveBackoff(config.backoff, `${path}.backoff`) })
  }
  throw new Error(`${path}.mode must be "normal" or "always"`)
}

// Error classification: prefer a stable code (err.code / err.cause), then a
// message regex fallback.
const CONTEXT_OVERFLOW_RE = /(?:^|[^a-z0-9])context[\s_-]?(?:length|window)[\s_-]?(?:exceed|overflow)/i
const QUOTA_RE = /(?:quota|balance|credit|budget|usage[\s_-]limit)[\s_-]?(?:exceeded|exhausted|reached|depleted)/i
const RATE_RE = /429|rate[\s_-]limit|too many requests/i
const TIMEOUT_RE = /timeout|timed?\s?out|ETIMEDOUT|ECONNRESET/i
const SERVER_RE = /5\d\d|internal server|bad gateway|service unavailable/i

export function retryErrorCode(err: unknown): string | undefined {
  // Walk the cause chain for a structured code.
  let cur: unknown = err
  for (let i = 0; i < 5 && cur != null; i++) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code
      if (typeof code === "string") return code
    }
    cur = (cur as { cause?: unknown }).cause
  }
  const msg = err instanceof Error ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}` : String(err)
  if (CONTEXT_OVERFLOW_RE.test(msg)) return "CONTEXT_WINDOW_EXCEEDED"
  if (QUOTA_RE.test(msg)) return "QUOTA"
  if (RATE_RE.test(msg)) return "RATE_LIMIT"
  if (TIMEOUT_RE.test(msg)) return "TIMEOUT"
  if (SERVER_RE.test(msg)) return "SERVER"
  return undefined
}

// Exponential backoff with symmetric jitter. attemptNo starts at 1 for the
// wait AFTER the first failed attempt; the delay is capped at maxDelayMs and
// never negative (jitter is ±jitterRatio of the capped base).
export function backoffDelay(policy: ResolvedRetryBackoff, attemptNo: number): number {
  const base = policy.initialDelayMs * 2 ** (attemptNo - 1)
  const capped = Math.min(base, policy.maxDelayMs)
  const jitter = (Math.random() * 2 - 1) * policy.jitterRatio * capped
  return Math.max(0, Math.round(capped + jitter))
}

// Retry wrapper (M20). Two provider failure styles must be handled (controller
// Ruling 3): a THROWN error, or an `{ type: "error", error }` event yielded by
// the stream. Retry happens only when all of: the error is retryable
// (code-classified in normal mode, or always-mode), nothing has been produced
// yet (text/chunk, reasoning or tool_call yielded → a restarted stream would
// duplicate output, so the error surfaces instead), and a retry budget
// remains. Retries are silent: the failed attempt's error event is never
// leaked to the consumer. Budget exhaustion is ALWAYS a hard failure (throw),
// whichever style the provider used. A give-up that is NOT exhaustion
// (non-retryable code, or output already produced) preserves the provider's
// surface style: an error event yields as a terminal event (anything after it
// is not consumed) and ends the stream; a thrown error is rethrown.
export function createRetryingClient(client: ModelClient, policy: ResolvedRetryPolicy): ModelClient {
  async function* wrapped(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    let attemptNo = 0
    while (true) {
      attemptNo++
      let produced = false
      let failure: unknown // set by an error event or a throw
      let failureEvent: { type: "error"; error: Error } | undefined // set only by an error event
      try {
        for await (const ev of client.stream(request)) {
          if (ev.type === "text/chunk" || ev.type === "reasoning" || ev.type === "tool_call") produced = true
          if (ev.type === "error") {
            // Provider signaled failure via an error EVENT. It is a terminal
            // event for the attempt: stop consuming (don't leak events after
            // the error), decide below whether to retry silently or surface.
            failure = ev.error
            failureEvent = ev
            break
          }
          yield ev
          if (ev.type === "end") return // attempt completed normally
        }
        // Fall through: normal completion (no failure) or an error event broke
        // the attempt out of the for-await — both handled below.
      } catch (err) {
        failure = err // provider signaled failure via a THROW
      }
      if (failure === undefined && failureEvent === undefined) return // completed normally
      const code = retryErrorCode(failure ?? failureEvent!.error)
      const retryable = policy.mode === "always" || (policy.mode === "normal" && policy.retryableCodes.includes(code ?? ""))
      const budgetExhausted = policy.mode === "normal" && attemptNo > policy.maxRetries
      if (retryable && !produced && !budgetExhausted) {
        await delay(backoffDelay(policy, attemptNo))
        continue
      }
      if (failureEvent !== undefined && !budgetExhausted) {
        yield failureEvent // preserve the provider's event surface: terminal
        return
      }
      throw failure ?? failureEvent!.error
    }
  }
  return { stream: wrapped }
}

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

export interface LLMRequest {
  messages: LLMMessage[]
  tools: ToolSchema[]
  systemPrompt: string
  model?: string
  /** M32: per-request reasoning effort; undefined → do not send (provider default). */
  reasoningEffort?: ReasoningEffort
}

export interface ModelClient {
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
}

export function assertMessagesFromLog(messages: LLMMessage[], session: Session): void {
  const logged = deriveMessages(session)
  const msgJson = JSON.stringify(messages)
  const logJson = JSON.stringify(logged)
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

export function projectImagesForTextModel(messages: LLMMessage[]): LLMMessage[] {
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
          ? { type: "text" as const, text: `[image omitted: model is text-only; base64:${part.image.dataBase64.slice(0, 8)}]` }
          : part,
      ),
    }
  })
}
