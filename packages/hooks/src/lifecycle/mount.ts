import { isCascadeRedispatch, type PluginContext } from "@i-harness/core-plugin"
import type { ToolCall } from "@i-harness/core-tools"
import type { ClaudeHookSession, HookContext } from "../types.ts"
import { HookOwnerAbortError } from "../types.ts"
import type { InternalRegistry, HookRuntimeInput } from "../registry-types.ts"
import type { claudeRuntimeService } from "../claude-runtime.ts"
import { runHandlers } from "../execution/handlers.ts"
import { permissionDecision } from "../execution/permissions.ts"

export function registerRuntimeStop(
  registry: InternalRegistry,
  runtimeService: ReturnType<typeof claudeRuntimeService>,
  isDisposed: () => boolean,
): () => void {
  return runtimeService.registerStop(async (input) => {
    if (isDisposed()) return undefined
    const header = (input.session as ClaudeHookSession & { header?: { origin?: string } }).header
    const event = header?.origin === "subagent" ? "subagent/stop" : "stop"
    const context: HookContext = event === "stop" ? { event, sessionId: input.sessionId ?? "", finalText: input.finalText, turns: input.turns }
      : { event, sessionId: input.sessionId ?? "" }
    const outputs = await runHandlers(registry, event, context, undefined, false, {
      ...input, claudeOnly: true, agentId: input.sessionId, matchValue: input.agentType === "explore" ? "Explore" : input.agentType,
      agentType: input.agentType === "explore" ? "Explore" : input.agentType,
    })
    if (input.signal?.aborted) throw new Error("agent aborted")
    return outputs.filter(output => output.continue !== false).map(output => output.continuation).filter(Boolean).join("\n\n") || undefined
  })

}

/** Preserve mount/listener order and one pre/post pair per logical tool call. */
export function mountHookListeners(ctx: PluginContext, registry: InternalRegistry, mountName: string): void {
  ctx.mount({ name: mountName, mount() {
    // 1+2. pre-tool / post-tool around the real tool body (tools/execute cascade).
    ctx.onCascade("tools/execute", async (input, next) => {
      const call = input as { name: string; args: unknown; commandDialect?: HookRuntimeInput["dialect"]; exec?: { session?: ClaudeHookSession; sessionId?: string; callId?: string; abortSignal?: AbortSignal } }
      const runtime: HookRuntimeInput = { session: call.exec?.session, sessionId: call.exec?.sessionId, callId: call.exec?.callId, signal: call.exec?.abortSignal, dialect: call.commandDialect }
      // M51 B1: a guard-retry RE-DISPATCH frame already had its pre-tool run
      // (approval/args are unchanged) and the frame that ran the pair owns the
      // single post-tool — skip this frame's pair so one logical call sees
      // exactly one pre-tool and one post-tool regardless of retry count and
      // mount order. The re-dispatch still enters the cascade (timeout re-arms).
      if (isCascadeRedispatch(input)) return next()
      await runHandlers(
        registry,
        "pre-tool",
        { event: "pre-tool", tool: { name: call.name, args: call.args } },
        call.name,
        true,
        runtime,
      )
      const output = await next()
      if (runtime.signal?.aborted) return output
      try {
        await runHandlers(
          registry, "post-tool", { event: "post-tool", tool: { name: call.name, args: call.args } },
          call.name, true, { ...runtime, toolOutput: output },
        )
      } catch (error) {
        // The actual body already completed. Owner cancellation of its post
        // observation must not replace that result; genuine vetoes stay loud.
        if (!(error instanceof HookOwnerAbortError) || !runtime.signal?.aborted) throw error
      }
      return output
    })

    // 3. permission: seed the pre-execute chain with a ToolDecision.
    ctx.on("tools/pre-execute", async (payload) => {
      return permissionDecision(registry, payload as ToolCall)
    })

    // 4. prompt/submit: waterfall on agent/pre-step (block ⇔ throw).
    ctx.waterfall("agent/pre-step", async (payload, next) => {
      const resolved = await next(payload)
      const p = resolved as { task?: string; session?: ClaudeHookSession; sessionId?: string; promptSubmission?: boolean; signal?: AbortSignal }
      await runHandlers(
        registry,
        "prompt/submit",
        { event: "prompt/submit", prompt: typeof p.task === "string" ? p.task : "" },
        undefined,
        true,
        { session: p.session, sessionId: p.sessionId, signal: p.signal, promptSubmission: p.promptSubmission },
      )
      return resolved
    })

    // 5. stop: plain listener on agent/stop (block ⇔ throw).
    ctx.on("agent/stop", async (payload) => {
      const p = payload as { sessionId?: string; finalText?: string; turns?: number }
      await runHandlers(
        registry,
        "stop",
        {
          event: "stop",
          sessionId: typeof p.sessionId === "string" ? p.sessionId : "",
          finalText: typeof p.finalText === "string" ? p.finalText : "",
          turns: typeof p.turns === "number" ? p.turns : 0,
        },
        undefined,
        true,
        { nativeOnly: true },
      )
    })

  } })
}
