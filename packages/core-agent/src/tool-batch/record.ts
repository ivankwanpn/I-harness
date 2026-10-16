import type { PluginContext } from "@i-harness/core-plugin"
import { committedFactSeqs, FactRecoveryRequiredError, type SessionView as Session } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { BatchCall, BatchSlot, ExecuteToolCallsOptions } from "./types.ts"
import type { BatchCancellation } from "./cancel.ts"

export function createBatchRecords(ctx: PluginContext, session: Session, tools: ToolRegistry, batch: BatchCall[], opts: ExecuteToolCallsOptions, cancellation: () => Pick<BatchCancellation, "observeAbort" | "aborted">) {
  const slots: (BatchSlot | undefined)[] = batch.map(() => undefined)
  let committed = 0, startedUpTo = 0, serial = Promise.resolve()
  async function commitSlot(index: number, reconcile=false): Promise<void> {
    const slot = slots[index]
    if (!slot || slot.recorded) return
    const control = cancellation(), call = batch[index]!
    control.observeAbort()
    if (!slot.fact) {
      if ('synthetic' in slot) {
        slot.projected ??= { output: await ctx.cascade('tools/project-synthetic-result', { name: slot.name, output: slot.output }, async () => slot.output) }
        slot.fact = opts.sourceFacts!.captureResult({ type: 'tool/result', callId: slot.callId, name: slot.name, output: slot.projected.output, isError: true })
      } else {
        if ('retained' in slot && !slot.resolved) {
          const result = await slot.retained.take()
          if (result.kind !== 'ready') throw Object.assign(new FactRecoveryRequiredError(), { cause: slot.recoveryCause })
          slot.resolved = { output: result.output }
        }
        slot.finalizing ??= tools.finalize(slot.prepared, 'retained' in slot ? slot.resolved!.output : slot.output)
        try { slot.finalized ??= await slot.finalizing }
        catch (error) { opts.requireFactRecovery?.(); throw error }
        const outcome = slot.finalized.output as { error?: unknown; code?: unknown } | null
        const isError = outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome)
          && typeof outcome.error === 'string' && typeof outcome.code === 'string'
        slot.fact = opts.sourceFacts!.captureResult({ type: 'tool/result', callId: slot.callId, name: slot.name, output: slot.finalized.output, ...(isError ? { isError: true } : {}) })
      }
    }
    committedFactSeqs(await (reconcile?slot.fact.reconcile():slot.fact.admit()))
    slot.recorded = true
    while (slots[committed]?.recorded) committed++
    if ('synthetic' in slot) return
    control.observeAbort()
    opts.telemetry?.emit({ type: 'tool/end', ts: Date.now(), data: { tool: slot.name, callId: slot.callId } })
    if (!control.aborted) await ctx.emit('agent/post-tool', { name: call.name, args: call.args, output: slot.finalized!.output, session, signal: opts.signal })
  }
  const schedule = (work: () => Promise<void>) => { const next = serial.then(work); serial = next.catch(() => {}); return next }
  return {
    commitReady() { return schedule(async () => { while (slots[committed]) await commitSlot(committed) }) },
    drainSettled() { return schedule(async () => {
      const errors: unknown[] = []
      for (let index = 0; index < slots.length; index++) {
        const slot = slots[index]
        if (!slot) continue
        if (!slot.recorded) try { await commitSlot(index,true) } catch (error) { if (!slot.recorded) errors.push(error) }
        if ('retained' in slot) try { await slot.retained.drainReferences() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Real tool settlement requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    }) },
    get committed() { return committed }, get startedUpTo() { return startedUpTo },
    markStarted(index: number) { startedUpTo = index + 1 },
    getSlot(index: number) { return slots[index] },
    setSlot(index: number, slot: BatchSlot) { if (!slots[index]) slots[index] = slot },
  }
}
export type BatchRecords = ReturnType<typeof createBatchRecords>
