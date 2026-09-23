import { setTimeout as delay } from "node:timers/promises"
import type { LLMMessage, Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"

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
 * `tool_call` across five wire protocols. Note also that nothing is ever summed
 * into a total — the protocols disagree about whether `input` already includes
 * cache (Anthropic's `input_tokens` does not), so a total would be a wrong
 * number rather than a convenient one.
 */
export interface LLMUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export type LLMStreamEvent =
  | { type: "text/chunk"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: { name: string; args: unknown } }
  | { type: "usage"; usage: LLMUsage }
  | { type: "end"; truncated?: true }
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
      // M5 T2: a usage report describes a COMPLETED round-trip, so it is held
      // until the attempt proves it finished. This wrapper's retry is silent —
      // core-agent cannot tell two attempts from one round-trip — so releasing
      // a dead attempt's report would merge it with the successful attempt's
      // and inflate every number with no trace. Holding costs one array; the
      // alternative is a wrong number that reads as a measurement. Fresh per
      // attempt, so a retry never inherits the previous one's.
      const pendingUsage: LLMStreamEvent[] = []
      try {
        for await (const ev of client.stream(request)) {
          if (ev.type === "text/chunk" || ev.type === "reasoning" || ev.type === "tool_call") produced = true
          if (ev.type === "usage") {
            pendingUsage.push(ev)
            continue
          }
          if (ev.type === "error") {
            // Provider signaled failure via an error EVENT. It is a terminal
            // event for the attempt: stop consuming (don't leak events after
            // the error), decide below whether to retry silently or surface.
            failure = ev.error
            failureEvent = ev
            break
          }
          if (ev.type === "end") {
            yield* pendingUsage // the attempt completed → its report is real
            yield ev
            return
          }
          yield ev
        }
        // Fall through: normal completion (no failure) or an error event broke
        // the attempt out of the for-await — both handled below.
      } catch (err) {
        failure = err // provider signaled failure via a THROW
      }
      if (failure === undefined && failureEvent === undefined) {
        yield* pendingUsage // completed normally without an explicit `end`
        return
      }
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
  if (aborted) return new Error(`${label} request aborted by the caller`)

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
  return err
}

/**
 * M72 Ⅰ: a stream body that was not valid SSE/JSON. Thrown by an adapter's
 * `parseSSE` so the READING LOOP can decide — a corrupt chunk is a provider
 * failure like any other and belongs on the seam's `error` channel, not out of
 * the generator as an exception while the same adapter reports HTTP failures as
 * events. The message carries a truncated copy of the offending text: without
 * it a 4000-chunk stream gives no way to tell WHAT was malformed.
 */
export class SSEParseError extends Error {
  constructor(text: string) {
    super(`malformed SSE chunk: ${text.slice(0, 80)}`)
    this.name = "SSEParseError"
  }
}

/**
 * M72 Ⅱ: the margin `clampOutputCap` keeps between the input we estimate and
 * the window. Sampled from Pi's `clampMaxTokensToContext` (`context − estimated
 * input − 4096`): the request-level clamp exists so that sending a model's full
 * output ceiling cannot turn a request that would have run into a 400 —
 * Anthropic treats `input + max_tokens > context` as a validation error.
 *
 * NOT exported on purpose: this file is its only consumer, and the reachability
 * instrument reads a single-file export as an unconsumed one (one new row = a
 * red gate). The number is documented here and asserted by this package's tests.
 */
const OUTPUT_CAP_SAFETY_MARGIN = 4096

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

/**
 * M72 Ⅱ: `min(value, room left in the window)`. Pure so every caller clamps the
 * same way; the host supplies the estimate because only the host knows how it
 * prices a message (this package deliberately owns no tokenizer).
 *
 * Three arms. No window known ⇒ the value is returned untouched. The estimated
 * input alone fills the window ⇒ ALSO untouched: the request cannot run at that
 * size whichever cap it carries, and clamping to 1 token would turn a context
 * overflow into a silent truncation. A non-finite estimate ⇒ ALSO untouched:
 * `NaN` would make every comparison false and `Math.min(value, NaN)` is `NaN`,
 * so a positive test on the room is what keeps a degenerate estimate from
 * turning into a `max_tokens: NaN` on the wire. Otherwise the value is clamped
 * into the hard room, preferring `hardRoom − margin` and falling back to the
 * hard room itself when the margin does not fit — the margin is insurance
 * against our estimate being low, never a licence to exceed the provider's rule.
 */
export function clampOutputCap(value: number, contextWindow: number | undefined, estimatedInputTokens: number): number {
  if (contextWindow === undefined) return value
  // The provider's OWN rule is `input + max_tokens <= context` — the safety
  // margin is insurance against our estimate being low, NOT a licence to exceed
  // that rule. So the hard room is computed first and always honoured; the
  // margin only decides how much of it we are willing to promise.
  // A POSITIVE test (`hardRoom >= 1`), not `hardRoom < 1`: a non-finite
  // estimate makes the room NaN, and `NaN < 1` is false — the negated form
  // would let NaN fall through to `Math.min(value, NaN)`.
  const hardRoom = contextWindow - estimatedInputTokens
  if (!(hardRoom >= 1)) return value
  const room = hardRoom - OUTPUT_CAP_SAFETY_MARGIN
  return Math.min(value, room >= 1 ? room : hardRoom)
}
