import type { Plugin, PluginContext } from "@i-harness/core-plugin"

export const TOOL_TIMEOUT = "TOOL_TIMEOUT"

export interface TimeoutGuardConfig {
  // Reserved for future policy knobs; the current policy reads tool.timeoutMs
  // directly (no hardcoded tunables: nothing here is hardcoded either).
}

export function createTimeoutGuard(_ctx: PluginContext): Plugin {
  return {
    name: "guard-timeout",
    mount(ctx: PluginContext): void {
      ctx.onCascade("tools/execute", async (dispatch, next) => {
        const d = dispatch as {
          name: string
          args: unknown
          exec: { abortSignal?: AbortSignal }
          tool: { timeoutMs?: number }
        }
        const timeoutMs = d.tool.timeoutMs
        if (timeoutMs === undefined) return next()

        const upstream = d.exec.abortSignal
        const controller = new AbortController()
        // Link: an upstream abort also cancels the derived signal (a parent
        // cancel is NOT our timeout). The listener is named so it can be
        // removed in `finally` (leak hygiene, mirroring exec's doneFn).
        const onUpstreamAbort = (): void => controller.abort()
        if (upstream?.aborted) controller.abort()
        else if (upstream) upstream.addEventListener("abort", onUpstreamAbort, { once: true })

        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        d.exec.abortSignal = controller.signal // swap: the tool honors this
        try {
          // `next()` resolves to the RAW tool output (unknown); treat it as a
          // plain object so the spread below preserves its fields unchanged
          // (type-only cast, no runtime effect).
          const result = (await next()) as Record<string, unknown>
          // OUR timer fired (not an upstream cancel) → the tool saw the abort
          // and reached quiescence; replace whatever it returned.
          if (timedOut) {
            // Ruling (controller, M10a execution): error/code go at the TOP
            // level of the substituted raw value, preserving the tool's other
            // fields via spread. The registry wraps the cascade value in
            // { name, output }, so the marker reads at tool/result.output.code
            // (NOT .output.output.code — the spec's initial `output:` nesting
            // would bury it one level deeper). Only spread when the raw output
            // is an object; a non-object output is replaced as-is.
            const base = result && typeof result === "object" ? result : {}
            return {
              ...base,
              error: `tool call timed out after ${timeoutMs}ms`,
              code: TOOL_TIMEOUT,
            }
          }
          return result
        } catch (err) {
          // A deadline tool that honors the abort by REJECTING must still
          // surface a structured TOOL_TIMEOUT when OUR timer fired; otherwise
          // the rejection aborts the whole agent run with no marker.
          if (timedOut) {
            return { error: `tool call timed out after ${timeoutMs}ms`, code: TOOL_TIMEOUT }
          }
          throw err
        } finally {
          clearTimeout(timer)
          upstream?.removeEventListener("abort", onUpstreamAbort)
          d.exec.abortSignal = upstream // restore for outer handlers / post-execute
        }
      })
    },
  }
}
