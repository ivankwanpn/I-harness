import type { PluginContext } from "@i-harness/core-plugin"
import { append, type Session } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { BatchCall, BatchSlot, ExecuteToolCallsOptions } from "./types.ts"
import type { BatchCancellation } from "./cancel.ts"

export function createBatchRecords(ctx: PluginContext, session: Session, tools: ToolRegistry, batch: BatchCall[], opts: ExecuteToolCallsOptions, cancellation: () => Pick<BatchCancellation, "observeAbort" | "aborted">) {
  const slots: (BatchSlot | undefined)[] = batch.map(() => undefined)
  let committed = 0
  let startedUpTo = 0
  async function commitReady(): Promise<void> {
    const control = cancellation()
    control.observeAbort()
    while (committed < batch.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = batch[committed]!
      if ("synthetic" in slot) {
        // M51 B3: an abort fill whose outcome is already decided — retain/project
        // through the owned output seam before append, without executing again,
        // so the head-of-line cursor advances in model order without running
        // finalize (tools/post-execute) or agent/post-tool.
        const output = await ctx.cascade("tools/project-synthetic-result", { name: slot.name, output: slot.output }, async () => slot.output)
        append(session, { type: "tool/result", callId: slot.callId, name: slot.name, output, isError: true })
        committed += 1
        continue
      }
      // finalize runs in the ordered commit lane (post-execute + wrap) — the
      // parallel path must not skip the staged post-execute seam.
      const finalized = await tools.finalize(slot.prepared, slot.output)
      // Filesystem, terminal and timeout tools return expected failures as a
      // typed {error, code} value so the model can retry without aborting the
      // turn. Preserve that disposition for protocols with an error flag.
      const outcome = finalized.output as { error?: unknown; code?: unknown } | null
      const isError = outcome !== null && typeof outcome === "object" && !Array.isArray(outcome)
        && typeof outcome.error === "string" && typeof outcome.code === "string"
      append(session, { type: "tool/result", callId: slot.callId, name: slot.name, output: finalized.output, ...(isError ? { isError: true } : {}) })
      // The durable answer already exists. A throwing observation must not
      // cause the abort drain to append this same call's answer a second time.
      committed += 1
      // finalize can await hooks while the owner presses Stop. Keep the real
      // completed answer, but do not start post-tool effects after that abort.
      control.observeAbort()
      // M25: tool/end beside the tool/result commit (model-order lane).
      opts.telemetry?.emit({ type: "tool/end", ts: Date.now(), data: { tool: slot.name, callId: slot.callId } })
      // M10a ordering ruling: post-tool only for completed dispatches and only
      // when not aborted (the abort check precedes the observation).
      if (!control.aborted) {
        await ctx.emit("agent/post-tool", { name: call.name, args: call.args, output: finalized.output, session })
      }
    }
  }


  return {
    commitReady,
    get committed() { return committed },
    get startedUpTo() { return startedUpTo },
    markStarted(index: number) { startedUpTo = index + 1 },
    getSlot(index: number) { return slots[index] },
    setSlot(index: number, slot: BatchSlot) { slots[index] = slot },
  }
}
export type BatchRecords = ReturnType<typeof createBatchRecords>
