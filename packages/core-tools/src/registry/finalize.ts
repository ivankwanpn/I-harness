import type { PluginContext } from "@i-harness/core-plugin"
import type { PreparedCall, ToolResult, ToolRegistry } from "../types.ts"
import { FactRecoveryRequiredError } from '@i-harness/core-session'
import { bindResultFinalization, resultExecution,capturePrivateFinalizedToolResult, type ResultFinalization, type ToolResultRetention } from './result-finalization.ts'
import { withToolResultProducer } from './result-dependencies.ts'
import {preparedExecutionHooks} from './prepared-body.ts'

export function createFinalizer(ctx: PluginContext, retention?: ToolResultRetention) {
  type HookOutcome = { kind: 'completed' } | { kind: 'failed'; cause: unknown }
  const states = new WeakMap<PreparedCall, { output: unknown; hook: Promise<HookOutcome>; handle?: ResultFinalization; running?: Promise<ToolResult> }>()
  async function finalize(prepared: PreparedCall, output: unknown): Promise<ToolResult> {
    const hooks=preparedExecutionHooks(prepared)
    const post=()=>hooks?hooks.channel.emit('tools/post-execute',{name:prepared.call.name,output},hooks.surface):ctx.emit('tools/post-execute',{name:prepared.call.name,output})
    if (retention) {
      let state = states.get(prepared)
      if (!state) {
        state = { output, hook: withToolResultProducer(prepared.exec, post).then<HookOutcome, HookOutcome>(() => ({ kind: 'completed' }), cause => ({ kind: 'failed', cause })) }
        states.set(prepared, state)
      } else if (!Object.is(state.output, output)) throw new FactRecoveryRequiredError()
      if (state.running) return state.running
      const owned = state
      const running = (async () => {
        const hook = await owned.hook
        owned.handle ??= retention.capture(prepared, output, resultExecution(prepared))
        bindResultFinalization(prepared, owned.handle)
        const result = await owned.handle.settle()
        if (result.kind !== 'ready') throw new FactRecoveryRequiredError()
        // The original completed body remains capturable when an observer
        // fails. Its retained source can commit that fact without repeating
        // this hook or resolving a guest success for the failed operation.
        if (hook.kind === 'failed') throw hook.cause
        return { name: prepared.call.name, ...(result.program.kind === 'value' ? { output: result.program.value } : {}), program: result.program, envelope: result.envelope }
      })()
      owned.running = running
      try { return await running } finally { if (owned.running === running) owned.running = undefined }
    }
    // 5. post-execute waterfall.
    const original=hooks?capturePrivateFinalizedToolResult(prepared,output):undefined
    await post()
    return original??{ name: prepared.call.name, output }
  }

  return { finalize: finalize as ToolRegistry['finalize'], resultFinalization: (prepared: PreparedCall) => states.get(prepared)?.handle }
}
