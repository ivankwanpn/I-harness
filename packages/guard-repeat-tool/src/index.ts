import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import { append, type Session } from "@i-harness/core-session"

export interface RepeatToolConfig {
  thresholds?: number[]            // default [3, 5, 8]
  include?: string[]               // *-wildcard patterns; empty = track everything
  exclude?: string[]               // *-wildcard patterns; transparent (no count, no reset)
  argumentsPreviewChars?: number   // default 500
}

const DEFAULT_THRESHOLDS = [3, 5, 8]
const DEFAULT_PREVIEW_CHARS = 500

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// *-wildcard pattern → anchored regex. `foo*` matches any tool name starting
// with `foo`; `*` alone matches everything.
function patternToRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join(".*")
  return new RegExp(`^${source}$`)
}

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((p) => patternToRegExp(p).test(name))
}

export function createRepeatToolGuard(_ctx: PluginContext, config: RepeatToolConfig = {}): Plugin {
  const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS
  if (
    !Array.isArray(thresholds) ||
    thresholds.length === 0 ||
    !thresholds.every((t) => Number.isInteger(t) && t >= 2)
  ) {
    throw new Error(
      `guard-repeat-tool: thresholds must be a non-empty array of integers >= 2 (got ${JSON.stringify(thresholds)})`,
    )
  }
  const include = config.include ?? []
  const exclude = config.exclude ?? []
  const previewChars = config.argumentsPreviewChars ?? DEFAULT_PREVIEW_CHARS

  // Per-session consecutive-repeat counter keyed by the SESSION OBJECT (a
  // Session has no durable id in-memory; this works for the main session and
  // every M8 child). WeakMap ⇒ entries are GC'd with their session.
  const counters = new WeakMap<Session, { key: string; count: number }>()

  return {
    name: "guard-repeat-tool",
    mount(ctx: PluginContext): void {
      ctx.on("agent/post-tool", (payload: unknown) => {
        const p = payload as { name: string; args: unknown; session: Session }
        // exclude is transparent: no count, no reset.
        if (matchesAny(exclude, p.name)) return
        // include gating: empty include = track everything.
        if (include.length > 0 && !matchesAny(include, p.name)) return

        const key = `${p.name}${JSON.stringify(p.args)}`
        const state = counters.get(p.session) ?? { key: "", count: 0 }
        state.count = key === state.key ? state.count + 1 : 1
        state.key = key
        counters.set(p.session, state)

        if (thresholds.includes(state.count)) {
          const preview = JSON.stringify(p.args).slice(0, previewChars)
          const text =
            `Heads-up: tool "${p.name}" has now been called ${state.count} consecutive times ` +
            `with the same arguments. If the previous calls did not achieve the intended result, ` +
            `consider changing the approach.\nArgs: ${preview}`
          append(p.session, {
            type: "user/message",
            text,
            source: { kind: "plugin", plugin: "guard-repeat-tool" },
          })
        }
      })
    },
  }
}
