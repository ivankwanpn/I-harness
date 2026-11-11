import type { PluginContext } from "@i-harness/core-plugin"
import type { PreparedCall, Tool, ToolDispatchMetadata, ToolRegistry } from "../types.ts"
import { isPolicyRefusal } from '../types.ts'
import { beginRetainedDispatch } from './retained-outcome.ts'
import { dispatchResultStarted, settleUndeclaredDispatch,recordDispatchedToolResult } from './result-finalization.ts'
import { withToolResultProducer } from './result-dependencies.ts'
import { assertNativeInstructions, isInstructionReplan, runInstructionBody } from '../instructions.ts'
import {preparedExecutionHooks,assertPreparedInvocationCurrent,getPreparedInvocationAdmissionWait,preparePreparedRetry} from './prepared-body.ts'

export function createDispatcher(ctx: PluginContext, getTool: (name: string) => Tool | undefined, getRegistry: () => ToolRegistry, invokePrepared: (prepared: PreparedCall) => Promise<unknown>): ToolRegistry["dispatch"] {
  // M13 dispatch stage — the ONLY overlapping stage: runs the around-seam
  // (`tools/execute` cascade handlers wrap the real tool body). `prepare` and
  // `finalize` run in the ordered lane so the policy layer stays model-ordered.
  function validatePrepared(prepared: PreparedCall): void {
    try {
      if (getTool(prepared.call.name) !== prepared.tool || !prepared.bindingValidation()) throw new Error("prepared tool binding changed: replaced or revoked before dispatch")
      if (prepared.authorityValidation?.() === false) throw new Error("prepared approval authority or policy changed before dispatch")
      if (prepared.approvalValidation?.() === false) throw new Error("prepared approval identity, rule or policy changed before dispatch")
      const guardReason = ctx.checkGuards("tools/execute", { name: prepared.call.name, args: prepared.call.args })
      if (guardReason !== undefined) throw new Error(`guard denied: ${guardReason}`)
      // Synchronous policy/guard callbacks can revoke or replace a registration
      // too. Check again after them without rereading the live execute method.
      if (getTool(prepared.call.name) !== prepared.tool || !prepared.bindingValidation()) throw new Error("prepared tool binding changed: replaced or revoked before dispatch")
    } catch (cause) {
      // These checks also run inside dispatch, after asynchronous hooks. Their
      // site is an authority gate, never a body failure the model can repair.
      throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause), { cause }), { policyRefusal: true as const })
    }
  }

  async function dispatch(prepared: PreparedCall): Promise<unknown> {
    const hooks=preparedExecutionHooks(prepared)
    hooks?.channel.assertCurrent(hooks.surface)
    for(;;){const wait=getPreparedInvocationAdmissionWait(prepared);if(!wait)break;await wait}
    assertPreparedInvocationCurrent(prepared)
    validatePrepared(prepared)
    hooks?.channel.assertCurrent(hooks.surface)
    const retained = beginRetainedDispatch(prepared)
    let dispatchOpen=true
    let retryFlight: Promise<{ kind: 'result'; value: unknown } | { kind: 'unavailable' }> | undefined
    let bodyReturned=false
    let retainedBody=retained?.body
    let bodyFlight: Promise<unknown> | undefined
    try {
    const cascade:PluginContext['cascade']=hooks?(event,input,final)=>hooks.channel.cascade(event as 'tools/execute',input,final,hooks.surface):ctx.cascade.bind(ctx)
    const invokeAttempt = () => {
      const attemptBody = retainedBody
      const running = (async () => {
        // Hooks may await before next(). No await is allowed between this final
        // authority check and invoking the body whose binding was validated.
        for(;;){const wait=getPreparedInvocationAdmissionWait(prepared);if(!wait)break;await wait}
        assertPreparedInvocationCurrent(prepared)
        validatePrepared(prepared)
        hooks?.channel.assertCurrent(hooks.surface)
        try { assertNativeInstructions(prepared.exec) }
        catch (error) {
          if (isInstructionReplan(error)) throw error
          throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { policyRefusal: true as const })
        }
        dispatchResultStarted(prepared.exec)
        const result = await withToolResultProducer(prepared.exec, () => runInstructionBody(prepared.exec, () => invokePrepared(prepared)))
        settleUndeclaredDispatch(prepared.exec, 'succeeded')
        bodyReturned=true
        attemptBody?.observed(); attemptBody?.ready(result)
        return result
      })()
      bodyFlight = running
      return running
    }
    const retryAttempt = (): Promise<{ kind: 'result'; value: unknown } | { kind: 'unavailable' }> => {
      if (!dispatchOpen) return Promise.reject(new Error('Original dispatch is closed'))
      if (retryFlight) return retryFlight
      const flight = Promise.resolve().then(async () => {
        if (!dispatchOpen) throw new Error('Original dispatch is closed')
        const previousBody = bodyFlight
        if (!await preparePreparedRetry(prepared, previousBody, () => {
          // Previous native cleanup and the full dispatcher body have joined.
          // Fresh validation belongs to the next attempt, even if it refuses.
          bodyReturned = false
          retainedBody = retained?.nextBody()
          validatePrepared(prepared)
        })) return { kind: 'unavailable' } as const
        if (!dispatchOpen) throw new Error('Original dispatch is closed')
        return { kind: 'result', value: await cascade('tools/execute', metadata, invokeAttempt) } as const
      })
      retryFlight = flight
      void flight.then(() => { if (retryFlight === flight) retryFlight = undefined }, () => { if (retryFlight === flight) retryFlight = undefined })
      return flight
    }
    const metadata = { name: prepared.call.name, args: prepared.call.args, exec: prepared.exec, tool: prepared.tool,
        retryAttempt, registry: getRegistry(), bindingGeneration: prepared.bindingGeneration, validateBinding: prepared.bindingValidation,
        ...(prepared.commandDialect !== undefined ? { commandDialect: prepared.commandDialect } : {}) } satisfies ToolDispatchMetadata

    const output = await cascade('tools/execute', metadata, invokeAttempt)
    recordDispatchedToolResult(prepared,output)
    retained?.success()
    return output
    } catch (error) {
      // The actual throw site owns failure; payload fields never do.
      if ((!hooks || !bodyReturned) && !isPolicyRefusal(error)) try { settleUndeclaredDispatch(prepared.exec, prepared.exec.abortSignal?.aborted ? 'unknown' : 'failed') } catch { /* Authority gate may precede actual dispatch. */ }
      throw retained?.failure(error) ?? error
    } finally { dispatchOpen=false }
  }

  return dispatch
}


