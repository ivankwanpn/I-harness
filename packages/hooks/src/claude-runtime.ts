import type { PluginContext } from "@i-harness/core-plugin"
import type { ClaudeHookSession } from "./types.ts"

export interface ClaudeStopInput {
  session: ClaudeHookSession
  sessionId?: string
  finalText: string
  turns: number
  stopHookActive: boolean
  signal?: AbortSignal
  agentType?: string
}

/** Trusted adapter callbacks; return values carry feedback, never authority. */
export interface ClaudeRuntimeService {
  registerStop(handler: (input: ClaudeStopInput) => Promise<string | undefined>): () => void
  beforeStop(input: ClaudeStopInput): Promise<{ reason: string } | undefined>
  queueContext(session: ClaudeHookSession, text: string, valid: () => boolean): void
  drainContext(session: ClaudeHookSession): string[]
}

export function claudeRuntimeService(ctx: PluginContext): ClaudeRuntimeService {
  try { return ctx.services.get<ClaudeRuntimeService>("hooks/claude-runtime") } catch { /* first mounted registry */ }
  const stops = new Set<(input: ClaudeStopInput) => Promise<string | undefined>>()
  const pending = new WeakMap<ClaudeHookSession, Array<{ text: string; valid: () => boolean }>>()
  const service: ClaudeRuntimeService = {
    registerStop(handler) { stops.add(handler); return () => { stops.delete(handler) } },
    async beforeStop(input) {
      const reasons: string[] = []
      for (const handler of [...stops]) {
        if (input.signal?.aborted) throw new Error("agent aborted")
        const reason = await handler(input)
        if (reason) reasons.push(reason)
      }
      const reason = Buffer.from(reasons.join("\n\n")).subarray(0, 64 * 1024).toString("utf8")
      return reason ? { reason } : undefined
    },
    queueContext(session, text, valid) { if (text) pending.set(session, [...(pending.get(session) ?? []).slice(-31), { text, valid }]) },
    drainContext(session) {
      const rows = pending.get(session) ?? []; pending.delete(session)
      const text = Buffer.from(rows.filter(row => row.valid()).map(row => row.text).join("\n\n")).subarray(0, 64 * 1024).toString("utf8")
      return text ? [text] : []
    },
  }
  ctx.services.register("hooks/claude-runtime", service)
  return service
}
