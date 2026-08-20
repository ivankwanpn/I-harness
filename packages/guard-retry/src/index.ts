import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import type { ToolExec } from "@i-harness/core-tools"
import { TOOL_TIMEOUT } from "@i-harness/guard-timeout"

export interface RetryConfig {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

interface ResolvedRetryConfig {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1

function resolveConfig(config: RetryConfig | undefined): ResolvedRetryConfig {
  const maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`guard-retry: maxRetries must be a non-negative integer (got ${maxRetries})`)
  }
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error(`guard-retry: initialDelayMs must be a non-negative integer (got ${initialDelayMs})`)
  }
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < 0) {
    throw new Error(`guard-retry: maxDelayMs must be a non-negative integer (got ${maxDelayMs})`)
  }
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (!(jitterRatio >= 0 && jitterRatio < 1)) {
    throw new Error(`guard-retry: jitterRatio must be in [0, 1) (got ${jitterRatio})`)
  }
  return { maxRetries, initialDelayMs, maxDelayMs, jitterRatio }
}

function isToolTimeout(result: unknown): boolean {
  return (result as { code?: string } | null | undefined)?.code === TOOL_TIMEOUT
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Exponential backoff with jitter, capped at maxDelayMs (dsh backoff style).
// resolveConfig is idempotent for an already-resolved config, so a single call
// serves both the public RetryConfig surface and the internal resolved config.
export function backoffDelay(attempt: number, config: RetryConfig | ResolvedRetryConfig): number {
  const c = resolveConfig(config)
  const target = Math.min(c.initialDelayMs * 2 ** attempt, c.maxDelayMs)
  const jitter = 1 - c.jitterRatio + Math.random() * (2 * c.jitterRatio)
  return Math.min(target * jitter, c.maxDelayMs)
}

export function createRetryGuard(_ctx: PluginContext, config?: RetryConfig): Plugin {
  const resolved = resolveConfig(config)
  // Re-entrancy guard: re-invoking ctx.cascade re-runs the WHOLE chain including
  // this handler; without the set the retry frames would nest and multiply the
  // attempts exponentially. A nested frame (context already retrying) delegates.
  const retrying = new WeakSet<object>()
  return {
    name: "guard-retry",
    mount(ctx: PluginContext): void {
      // OUTER to guard-timeout: core-plugin runs cascade handlers in
      // registration order with the FIRST-registered handler OUTERMOST, so
      // this guard must be mounted BEFORE createTimeoutGuard to see the
      // substituted TOOL_TIMEOUT raw value (the registry wraps it in
      // { name, output } only after the cascade returns). On timeout it
      // RE-INVOKES the cascade (next() is one-shot) with a reconstructed final.
      ctx.onCascade("tools/execute", async (dispatch, next) => {
        const d = dispatch as { name: string; args: unknown; exec: ToolExec; tool: { execute(args: unknown, exec: ToolExec): Promise<unknown> } }
        if (retrying.has(d)) return next() // nested re-dispatch frame: delegate, no retry loop
        retrying.add(d)
        try {
          let result = await next()
          let attempt = 0
          while (isToolTimeout(result) && attempt < resolved.maxRetries) {
            await sleep(backoffDelay(attempt, resolved))
            attempt += 1
            // Deliberate seam-bypass: this re-invokes ONLY the cascade
            // handlers — it skips registry.execute's pre-execute hooks, the
            // monotonic guards, and post-execute. Approval was already granted
            // for the original dispatch and only the FINAL (post-retry) result
            // should reach post-execute, so each attempt must not re-run them.
            result = await ctx.cascade("tools/execute", d, () => d.tool.execute(d.args, d.exec))
          }
          return result
        } finally {
          retrying.delete(d)
        }
      })
    },
  }
}
