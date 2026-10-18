import type { PluginContext } from "@i-harness/core-plugin"
import { captureLegacyFact, committedFactSeqs, FactRecoveryRequiredError, stringifyJsonData } from "@i-harness/core-session"
import { isPolicyRefusal, retainedToolOutcome, ToolArgsError, type ToolRegistry } from "@i-harness/core-tools"
import type { CodeModeInvocation, CodeModeMountOptions } from "./types.ts"
import { captureCodeModeTools, codeModeDefinitions } from "./catalog.ts"
import type { Cell, Queued } from './broker/types.ts'
import { createCodeModeRecords, message, fatal } from './broker/records.ts'
import { codeModeFactOwner } from './facts.ts'

/** The broker owns admission/dispatch; real results retain their original slot
 * through a failed join. Only the document's exact receipt marks them recorded. */
export function createCodeModeBroker(ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions) {
  const owner = codeModeFactOwner(options), records = createCodeModeRecords(complete)
  const cells = new Map<string, Cell>(), queue: Queued[] = [], active = new Set<Queued>(), jobs = new Set<Promise<void>>(), unsettled = new Set<Queued>()
  const stop = new AbortController(), parallel = Math.min(16, Math.max(1, options.maxParallel ?? 4))
  let pumping = false, disposed = false, closed = false, exclusive = false, closeAttempt: Promise<void> | undefined
  let finalizers: Promise<void> = Promise.resolve()
  const recovery = (cause: unknown) => Object.assign(new FactRecoveryRequiredError(), { cause })
  function complete(item: Queued): Promise<unknown> {
    if (item.completion) return item.completion
    const completion = finalizers.then(async () => {
      if (!item.prepared) throw recovery(item.recoveryCause)
      item.finalizing ??= tools.finalize(item.prepared, item.bodyOutput)
      const result = await item.finalizing
      await records.record(item, result.output)
      if (!item.signal.aborted) {
        try { await ctx.emit("agent/post-tool", { name: item.call.name, args: item.call.args, output: result.output, session: options.session, signal: item.signal }) }
        catch (error) { throw fatal(`Code Mode post-tool hook failed: ${message(error)}`) }
      }
      return result.output
    })
    item.completion = completion
    finalizers = completion.then(() => {}, () => {})
    return completion
  }
  function retireCell(id: string) { const cell = cells.get(id); cells.delete(id); cell?.stop.abort(); void pump() }
  const track = (job: Promise<void>) => { jobs.add(job); void job.then(() => { jobs.delete(job); void pump() }, () => { jobs.delete(job); void pump() }) }
  async function release(item: Queued) {
    try { await item.generation?.close() }
    catch (error) { item.source.requireRecovery(); item.recoveryCause = error }
    item.done.resolve(); item.action.finish()
    try { await item.source.close(); unsettled.delete(item) }
    catch (cause) { if (!item.finished) records.settle(item, { error: recovery(cause) }) }
  }
  async function run(item: Queued) {
    try {
      item.action.assertOpen()
      if (item.signal.aborted || !cells.has(item.call.cellId)) throw new Error("Code Mode tool call aborted before dispatch")
      if (tools.get(item.call.name) !== item.tool) throw new Error("Code Mode tool binding changed")
      let prepared
      try {
        item.generation = item.call.origin.generationLineage?.forInvocation({ view: options.session, cellId: item.call.cellId, action: item.action, eventSeq: item.eventSeq!, callId: item.call.invocationId, name: item.call.name, signal: item.signal,
          current: () => !disposed && !item.signal.aborted && cells.has(item.call.cellId) && active.has(item) && tools.get(item.call.name) === item.tool })
        prepared = await tools.prepare({ name: item.call.name, args: item.call.args }, item.signal, { sessionId: options.sessionId ?? item.call.origin.sessionId, session: options.session, callId: item.call.invocationId, callEventSeq: item.eventSeq, resultConsumer: "code", settlementSource: item.source, modelGeneration: item.generation?.factories })
      } catch (error) { throw error instanceof ToolArgsError ? error : fatal(error) }
      item.action.assertOpen()
      if (item.signal.aborted || !cells.has(item.call.cellId)) throw new Error("Code Mode tool call aborted before dispatch")
      if (prepared.tool !== item.tool || tools.get(item.call.name) !== item.tool) throw new Error("Code Mode tool binding changed during admission")
      committedFactSeqs(await item.action.facts.code.dispatch(item.call.cellId, item.call.invocationId, { kind: 'prior', seq: item.eventSeq!, expectedType: 'code/call' }))
      try { await options.flush?.() } catch (error) { throw fatal(`Code Mode checkpoint failed: ${message(error)}`) }
      item.action.assertOpen()
      if (item.signal.aborted || !cells.has(item.call.cellId)) throw new Error("Code Mode tool call aborted before dispatch")
      if (prepared.tool !== item.tool || tools.get(item.call.name) !== item.tool) throw new Error("Code Mode tool binding changed during checkpoint")
      item.admitted()
      item.prepared = prepared
      try { item.bodyOutput = await tools.dispatch(prepared); item.hasOutput = true }
      catch (error) {
        const retained = retainedToolOutcome(error, prepared)
        if (retained) { item.retained = retained; item.recoveryCause = error }
        throw error
      }
      records.settle(item, { value: await complete(item) })
    } catch (error) {
      if (item.retained) {
        records.settle(item, { error: recovery(error) })
        return
      }
      if (isPolicyRefusal(error)) retireCell(item.call.cellId)
      // A real body/finalizer value can never be overwritten with a synthetic
      // storage error. Its retained source is reconciled without execution.
      if (item.hasOutput || item.result) {
        if (!item.result && !item.recorded) item.source.requireRecovery()
        const failure = item.recorded ? error : !item.result
          ? Object.assign(fatal(`Code Mode finalization failed: ${message(error)}`), { code: 'FACT_RECOVERY_REQUIRED' }) : recovery(error)
        if (isPolicyRefusal(failure)) retireCell(item.call.cellId)
        records.settle(item, { error: failure })
      } else {
        try {
          await records.record(item, { error: message(error), code: isPolicyRefusal(error) ? "POLICY_REFUSAL" : item.signal.aborted ? "TOOL_ABORTED" : "TOOL_FAILED" }, true)
          records.settle(item, { error })
        } catch (cause) { records.settle(item, { error: recovery(cause) }) }
      }
    } finally {
      item.admitted(); active.delete(item)
      if (!item.tool.isConcurrencySafe) exclusive = false
      await release(item); void pump()
    }
  }
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length && active.size < parallel && !exclusive) {
        const item = queue[0]!
        if (!item.tool.isConcurrencySafe && active.size) break
        queue.shift(); if (item.finished) continue
        active.add(item); if (!item.tool.isConcurrencySafe) exclusive = true
        const admission = new Promise<void>(resolve => { item.admitted = resolve })
        track(run(item)); await admission
      }
    } finally { pumping = false }
  }
  return {
    definitions() { return codeModeDefinitions(captureCodeModeTools(tools)) },
    startCell(id: string) {
      if (disposed || cells.has(id)) throw new Error("Code Mode cell unavailable")
      cells.set(id, { tools: captureCodeModeTools(tools), stop: new AbortController(), seen: new Set() })
    },
    retireCell,
    async invoke(original: CodeModeInvocation): Promise<unknown> {
      const cell = cells.get(original.cellId)
      if (disposed || !cell) throw new Error("Code Mode cell unavailable")
      if (options.sessionId && original.origin.sessionId && options.sessionId !== original.origin.sessionId) throw fatal("Code Mode session owner mismatch")
      if (cell.seen.has(original.invocationId)) throw new Error("Duplicate Code Mode invocation")
      cell.seen.add(original.invocationId)
      const tool = cell.tools.get(original.name)
      if (!tool || tool !== tools.get(original.name)) throw new Error("Code Mode tool unavailable or binding changed")
      const captured = captureLegacyFact(original.args)
      if (captured.kind !== 'captured') throw Object.assign(new Error('Code Mode arguments cannot be captured'), { code: captured.code })
      if (Buffer.byteLength(stringifyJsonData(captured.value) ?? 'null') > (options.config?.maxResultBytes ?? 4 * 1024 * 1024)) throw new Error("Code Mode tool arguments exceed transfer limit")
      const call = { ...original, args: captured.value }, signal = AbortSignal.any([call.signal, stop.signal, cell.stop.signal]), action = owner.beginAction(signal)
      let item!: Queued
      const source = action.registerSettlementSource(async () => { await item.done.promise; await records.drain(item) })
      const waiting = Promise.withResolvers<unknown>()
      item = { call, tool, signal, action, source, done: Promise.withResolvers<void>(), hasOutput: false, ...waiting, unsubscribe: () => {}, admitted: () => {}, finished: false, recorded: false }
      unsettled.add(item)
      try {
        item.eventSeq = committedFactSeqs(await action.facts.code.record({ type: 'code/call', cellId: call.cellId, ...(call.origin.callId ? { parentCallId: call.origin.callId } : {}), callId: call.invocationId, name: call.name, args: call.args }))[0]!
        const abort = () => {
          if (active.has(item) || item.finished) return
          track((async () => {
            try { await records.record(item, { error: 'Code Mode tool call aborted before dispatch', code: 'TOOL_ABORTED_BEFORE_DISPATCH' }, true); records.settle(item, { error: new Error('Code Mode tool call aborted') }) }
            catch (cause) { records.settle(item, { error: recovery(cause) }) }
            finally { await release(item) }
          })())
        }
        signal.addEventListener('abort', abort, { once: true }); item.unsubscribe = () => signal.removeEventListener('abort', abort)
        queue.push(item); if (signal.aborted) abort(); void pump()
      } catch (error) { await release(item); throw error }
      return waiting.promise
    },
    async dispose() {
      if (closed) return
      if (closeAttempt) return closeAttempt
      disposed = true; stop.abort()
      for (const id of cells.keys()) retireCell(id)
      const pending = (async () => {
        await Promise.allSettled([...jobs])
        const errors: unknown[] = []
        for (const item of unsettled) try { await item.source.close(); unsettled.delete(item) } catch (error) { errors.push(error) }
        try { await options.flush?.() } catch (error) { errors.push(error) }
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw Object.assign(new AggregateError(errors, 'Code Mode settlement requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
        closed = true
      })()
      closeAttempt = pending
      void pending.catch(() => { if (closeAttempt === pending) closeAttempt = undefined })
      return pending
    },
  }
}
