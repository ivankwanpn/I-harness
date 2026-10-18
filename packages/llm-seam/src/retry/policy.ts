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

// Exponential backoff with symmetric jitter. attemptNo starts at 1 for the
// wait AFTER the first failed attempt; the delay is capped at maxDelayMs and
// never negative (jitter is ±jitterRatio of the capped base).
export function backoffDelay(policy: ResolvedRetryBackoff, attemptNo: number): number {
  const base = policy.initialDelayMs * 2 ** (attemptNo - 1)
  const capped = Math.min(base, policy.maxDelayMs)
  const jitter = (Math.random() * 2 - 1) * policy.jitterRatio * capped
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(capped + jitter)))
}
