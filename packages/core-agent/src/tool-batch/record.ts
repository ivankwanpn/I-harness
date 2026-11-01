import type { PluginContext } from "@i-harness/core-plugin"
import { committedFactSeqs, FactRecoveryRequiredError } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import { isOriginalResultFinalization, isOriginalSyntheticResultFinalization, resultExecution } from '@i-harness/core-tools'
import type { BatchCall, BatchSlot, ExecuteToolCallsOptions } from "./types.ts"
import type { BatchCancellation } from "./cancel.ts"
import {isManagedBatchSource,type BatchSource} from './managed-source.ts'

export function createBatchRecords(ctx: PluginContext, session: BatchSource, tools: ToolRegistry, batch: BatchCall[], opts: ExecuteToolCallsOptions, cancellation: () => Pick<BatchCancellation, "observeAbort" | "aborted" | "disqualify">) {
  const slots: (BatchSlot | undefined)[] = batch.map(() => undefined)
  let committed = 0, startedUpTo = 0, serial = Promise.resolve(), unknownEffects = false
  const synthetic=(index:number)=>isManagedBatchSource(session)?session.synthetic(index,opts.settlementSource! as import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').FactOutcome>):{view:session,source:opts.settlementSource!,callId:batch[index]!.callId,name:batch[index]!.name}
  const holdOriginal = (slot: BatchSlot,index:number) => {
    if ('synthetic' in slot) {
      if (isOriginalSyntheticResultFinalization(synthetic(index), slot.finalization)) opts.holdFactRecovery?.()
    } else {
      const handle = slot.finalization ?? tools.resultFinalization?.(slot.prepared)
      if (isOriginalResultFinalization(slot.prepared, handle)) { slot.finalization = handle; opts.holdFactRecovery?.() }
    }
  }
  async function commitSlot(index: number, reconcile=false): Promise<void> {
    const slot = slots[index]
    if (!slot || slot.recorded) return
    const control = cancellation(), call = batch[index]!
    control.observeAbort()
    if (!slot.fact) {
      if ('synthetic' in slot) {
        slot.projected ??= { output: await ctx.cascade('tools/project-synthetic-result', { name: slot.name, output: slot.output }, async () => slot.output) }
        const context=synthetic(index)
        slot.finalization ??= 'domain'in context?tools.captureManagedSyntheticResult?.(context,slot.projected.output,slot.execution??{outcome:'unknown',dispatch:'unknown'}):tools.captureSyntheticResult?.(context, slot.projected.output, slot.execution ?? { outcome: 'unknown', dispatch: 'unknown' })
        const retained = await slot.finalization?.settle()
        if (retained && retained.kind !== 'ready') { holdOriginal(slot,index); throw new FactRecoveryRequiredError() }
        slot.fact = opts.sourceFacts!.captureResult({ type: 'tool/result', callId: slot.callId, name: slot.name, ...(retained?.kind === 'ready' ? { envelope: retained.envelope } : { output: slot.projected.output, isError: true }) })
      } else {
        if ('retained' in slot && !slot.resolved) {
          const result = await slot.retained.take()
          if (result.kind !== 'ready') throw Object.assign(new FactRecoveryRequiredError(), { cause: slot.recoveryCause })
          slot.resolved = { output: result.output }
        }
        if (!slot.finalized && slot.finalization) {
          const result = await slot.finalization.settle()
          if (result.kind !== 'ready') throw new FactRecoveryRequiredError()
          slot.finalized = { name: slot.name, ...(result.program.kind === 'value' ? { output: result.program.value } : {}), program: result.program, envelope: result.envelope }
        }
        if (!slot.finalized) {
          slot.finalizing ??= tools.finalize(slot.prepared, 'retained' in slot ? slot.resolved!.output : slot.output)
          try { slot.finalized = await slot.finalizing }
          catch (error) {
            const handle = tools.resultFinalization?.(slot.prepared)
            if (isOriginalResultFinalization(slot.prepared, handle)) { slot.finalization = handle; opts.holdFactRecovery?.() }
            else opts.requireFactRecovery?.()
            throw error
          }
        }
        const outcome = slot.finalized.output as { error?: unknown; code?: unknown } | null
        const isError = outcome !== null && typeof outcome === 'object' && !Array.isArray(outcome)
          && typeof outcome.error === 'string' && typeof outcome.code === 'string'
        slot.fact = opts.sourceFacts!.captureResult({ type: 'tool/result', callId: slot.callId, name: slot.name, ...(slot.finalized.envelope ? { envelope: slot.finalized.envelope } : { output: slot.finalized.output, ...(isError ? { isError: true } : {}) }) })
      }
    }
    try { committedFactSeqs(await (reconcile?slot.fact.reconcile():slot.fact.admit())) }
    catch (error) { holdOriginal(slot,index); throw error }
    slot.recorded = true
    while (slots[committed]?.recorded) committed++
    if ('synthetic' in slot) return
    control.observeAbort()
    opts.telemetry?.emit({ type: 'tool/end', ts: Date.now(), data: { tool: slot.name, callId: slot.callId } })
    if (!control.aborted) {const payload={name: call.name, args: call.args, ...(slot.finalized!.program?.kind === 'unavailable' ? { program: slot.finalized!.program } : { output: slot.finalized!.output }),signal:opts.signal};if(isManagedBatchSource(session))await session.postTool(payload);else await ctx.emit('agent/post-tool',{...payload,session})}
  }
  const schedule = (work: () => Promise<void>) => { const next = serial.then(work).catch(error => { cancellation().disqualify(); throw error }); serial = next.catch(() => {}); return next }
  return {
    commitReady() { return schedule(async () => { while (slots[committed]) await commitSlot(committed) }) },
    drainSettled() { return schedule(async () => {
      const errors: unknown[] = []
      for (let index = 0; index < slots.length; index++) {
        const slot = slots[index]
        if (!slot) continue
        if (!slot.recorded) try { await commitSlot(index,true) } catch (error) { cancellation().disqualify(); if (!slot.recorded) errors.push(error) }
        if ('retained' in slot) try { await slot.retained.drainReferences() } catch (error) { cancellation().disqualify(); errors.push(error) }
      }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Real tool settlement requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    }) },
    get committed() { return committed }, get startedUpTo() { return startedUpTo },
    get liveComplete() { return !unknownEffects && committed === batch.length && slots.length === batch.length && slots.every(slot => !!slot && slot.recorded === true && ('synthetic' in slot ? slot.execution?.outcome !== 'unknown' && slot.execution?.dispatch !== 'unknown' : !!slot.finalized && (!('retained' in slot) || !!slot.resolved))) },
    markStarted(index: number) { startedUpTo = index + 1 },
    getSlot(index: number) { return slots[index] },
    setSlot(index: number, slot: BatchSlot) {
      if (slots[index]) return
      slots[index] = slot
      if (!('synthetic' in slot)) {
        try { const execution = resultExecution(slot.prepared); if (execution.outcome === 'unknown' || execution.dispatch === 'unknown') unknownEffects = true }
        catch { unknownEffects = true }
      }
    },
  }
}
export type BatchRecords = ReturnType<typeof createBatchRecords>
