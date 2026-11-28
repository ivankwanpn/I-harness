import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import { isDeepStrictEqual } from "node:util"
import { committedFactSeqs, feedbackFactsFor, type SessionView as Session, type FeedbackFactSource } from "@i-harness/core-session"

export interface RepeatToolConfig {
  factsFor?: (session: Session) => FeedbackFactSource
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

export function createRepeatToolReminder(config: RepeatToolConfig = {}) {
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

  const counters = new WeakMap<object, { name: string; args: string | undefined; count: number }>()

  return (owner: object, name: string, input: unknown): string | undefined => {
    if (matchesAny(exclude, name) || include.length > 0 && !matchesAny(include, name)) return
    const args = JSON.stringify(input)
    const previous = counters.get(owner)
    // Reordering object keys changes the bytes, but never their total length.
    // Common calls require no parsing or canonical reserialization.
    const repeated = previous?.name === name && (previous.args === args ||
      (args !== undefined && previous.args?.length === args.length &&
        isDeepStrictEqual(JSON.parse(previous.args), JSON.parse(args))))
    const count = repeated ? previous.count + 1 : 1
    counters.set(owner, { name, args, count })
    if (!thresholds.includes(count)) return
    return `Heads-up: tool "${name}" has now been called ${count} consecutive times ` +
      `with the same arguments. If the previous calls did not achieve the intended result, ` +
      `consider changing the approach.\nArgs: ${(args ?? "").slice(0, previewChars)}`
  }
}

export function createRepeatToolGuard(_ctx: PluginContext, config: RepeatToolConfig = {}): Plugin {
  const observe = createRepeatToolReminder(config)
  return {
    name: "guard-repeat-tool",
    mount(ctx: PluginContext): void {
      ctx.on("agent/post-tool", async (payload: unknown) => {
        const p = payload as { name: string; args: unknown; session: Session; signal?: AbortSignal }
        const text = observe(p.session, p.name, p.args)
        if (text) committedFactSeqs(await feedbackFactsFor(p.session, config.factsFor?.(p.session), p.signal).feedback({
          type: "user/message", text, internal: true, source: { kind: "plugin", plugin: "guard-repeat-tool" },
        }))
      })
    },
  }
}
