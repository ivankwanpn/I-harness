import type { PluginContext } from "@i-harness/core-plugin"
import { captureLegacyFact, committedFactSeqs, FactRecoveryRequiredError, stringifyJsonData } from "@i-harness/core-session"
import { isOriginalResultFinalization, isPolicyRefusal, isNativePlanValidationError, isInstructionReplan, instructionReplan, instructionReplanDisposition, registryRequiresInstructionOrigin, bindInstructionInvocation, preflightInstructionInvocations, releaseInstructionCell, retainedToolOutcome, resultExecution, ToolArgsError, type ToolRegistry, type InstructionCellOrigin, type InstructionReplanData } from "@i-harness/core-tools"
import type { CodeModeInvocation, CodeModeMountOptions } from "./types.ts"
import { captureCodeModeTools, codeModeDefinitions } from "./catalog.ts"
import type { Cell, Queued } from './broker/types.ts'
import { createCodeModeRecords, message, fatal } from './broker/records.ts'
import { codeModeFactOwner } from './facts.ts'

/** The broker owns admission/dispatch; real results retain their original slot
 * through a failed join. Only the document's exact receipt marks them recorded. */
export function createCodeModeBroker(ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions, onInstructionReplan?: (cellId: string, detail: InstructionReplanData) => void) {
  const owner = codeModeFactOwner(options), records = createCodeModeRecords(complete, (item, output, execution) => tools.captureSyntheticResult?.({ view: options.session, source: item.source, callId: item.call.invocationId, name: item.call.name }, output, execution), options.session)
  const cells = new Map<string, Cell>(), queue: Queued[] = [], active = new Set<Queued>(), jobs = new Set<Promise<void>>(), unsettled = new Set<Queued>()
  const retiredCells = new Map<string, Cell>()
  const stop = new AbortController(), parallel = Math.min(16, Math.max(1, options.maxParallel ?? 4))
  let pumping = false, disposed = false, closed = false, exclusive = false, closeAttempt: Promise<void> | undefined
  let finalizers: Promise<void> = Promise.resolve()
  const recovery = (cause: unknown) => Object.assign(new FactRecoveryRequiredError(), { cause })
  function replanCell(id: string, detail: InstructionReplanData) {
    const cell = cells.get(id)
    if (!cell || cell.replan) return
    cell.replan = detail
    onInstructionReplan?.(id, detail)
  }
  function complete(item: Queued): Promise<unknown> {
    if (item.completion) return item.completion
    const completion = finalizers.then(async () => {
      if (!item.prepared) throw recovery(item.recoveryCause)
      if (!item.finalized && item.finalization) {
        const settled = await item.finalization.settle()
        if (settled.kind !== 'ready') throw recovery(item.recoveryCause)
        item.finalized = { name: item.call.name, ...(settled.program.kind === 'value' ? { output: settled.program.value } : {}), program: settled.program, envelope: settled.envelope }
      }
      if (!item.finalized) {
        item.finalizing ??= tools.finalize(item.prepared, item.bodyOutput)
        try { item.finalized = await item.finalizing }
        catch (cause) {
          const handle = tools.resultFinalization?.(item.prepared)
          if (isOriginalResultFinalization(item.prepared, handle)) { item.finalization = handle; item.source.holdRecovery() }
          throw cause
        }
        const handle = tools.resultFinalization?.(item.prepared)
        if (isOriginalResultFinalization(item.prepared, handle)) item.finalization = handle
      }
      const result = item.finalized
      await records.record(item, result.output, false, result.envelope)
      if (!item.signal.aborted && !item.postToolStarted) {
        item.postToolStarted = true
        try { await ctx.emit("agent/post-tool", { name: item.call.name, args: item.call.args, ...(result.program?.kind === 'unavailable' ? { program: result.program } : { output: result.output }), session: options.session, signal: item.signal }) }
        catch (error) { throw fatal(`Code Mode post-tool hook failed: ${message(error)}`) }
      }
      if (result.program?.kind === 'unavailable') throw Object.assign(new Error('Code Mode tool result is unavailable for transfer'), { code: 'CODE_MODE_RESULT_UNAVAILABLE', reason: result.program.reason })
      return result.program?.kind === 'value' ? result.program.value : result.output
    })
    item.completion = completion
    void completion.catch(() => { if (item.finalization && !item.result && item.completion === completion) item.completion = undefined })
    finalizers = completion.then(() => {}, () => {})
    return completion
  }
  async function drainCell(id: string) {
    const cell = cells.get(id) ?? retiredCells.get(id)
    if (cell) await Promise.allSettled([...cell.preflights])
    for (const item of [...unsettled].filter(value => value.call.cellId === id)) {
      await item.done.promise
      await item.source.close()
      unsettled.delete(item)
    }
  }
  async function finishCell(id: string) {
    const cell = cells.get(id) ?? retiredCells.get(id)
    if (!cell) return
    return finishOriginalCell(id, cell)
  }
  function finishOriginalCell(id: string, cell: Cell): Promise<void> {
    if (cell.finished) return Promise.resolve()
    if (cell.finishing) return cell.finishing
    const pending = Promise.resolve().then(async () => {
      await cell.ending.promise
      await drainCell(id)
      if (cell.instructionOrigin) await releaseInstructionCell(cell.instructionOrigin)
      cell.finished = true
      if (cells.get(id) === cell) cells.delete(id)
      if (retiredCells.get(id) === cell) retiredCells.delete(id)
    })
    cell.finishing = pending
    void pending.catch(() => { if (cell.finishing === pending) cell.finishing = undefined })
    return pending
  }
  function retireCell(id: string) {
    const cell = cells.get(id)
    if (!cell) return
    cells.delete(id)
    retiredCells.set(id, cell)
    cell.ending.resolve()
    cell.stop.abort()
    void pump()
    return undefined
  }
  async function finishTerminalCell(id: string) {
    const cell = cells.get(id) ?? retiredCells.get(id)
    if (!cell) return
    cell.terminalCommitted = true
    cell.ending.resolve()
    await finishCell(id)
  }
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
      let prepared, preparing = false
      try {
        item.generation ??= item.call.origin.generationLineage?.forInvocation({ view: options.session, cellId: item.call.cellId, action: item.action, eventSeq: item.eventSeq!, callId: item.call.invocationId, name: item.call.name, signal: item.signal,
          current: () => !disposed && !item.signal.aborted && cells.has(item.call.cellId) && active.has(item) && tools.get(item.call.name) === item.tool })
        preparing = true
        prepared = item.capture ? await tools.prepareCaptured(item.capture, item.signal, item.instructionOrigin) : await tools.prepare({ name: item.call.name, args: item.call.args }, item.signal, { sessionId: options.sessionId ?? item.call.origin.sessionId, session: options.session, callId: item.call.invocationId, callEventSeq: item.eventSeq, resultConsumer: "code", settlementSource: item.source, modelGeneration: item.generation?.factories })
      } catch (error) {
        // The nominal type alone cannot prove nondispatch: a real body or
        // finalizer may throw it too. Only this preparation occurrence is soft.
        if (preparing && isNativePlanValidationError(error) && !isPolicyRefusal(error)) {
          try { await records.record(item, error.output, true); records.settle(item, { value: error.output }) }
          catch (cause) { records.settle(item, { error: recovery(cause) }) }
          return
        }
        throw error instanceof ToolArgsError || isInstructionReplan(error) ? error : fatal(error)
      }
      item.action.assertOpen()
      if (item.signal.aborted || !cells.has(item.call.cellId)) throw new Error("Code Mode tool call aborted before dispatch")
      if (cells.get(item.call.cellId)?.replan) throw instructionReplan(cells.get(item.call.cellId)!.replan!)
      if (prepared.tool !== item.tool || tools.get(item.call.name) !== item.tool) throw new Error("Code Mode tool binding changed during admission")
      committedFactSeqs(await item.action.facts.code.dispatch(item.call.cellId, item.call.invocationId, { kind: 'prior', seq: item.eventSeq!, expectedType: 'code/call' }))
      try { await options.flush?.() } catch (error) { throw fatal(`Code Mode checkpoint failed: ${message(error)}`) }
      item.action.assertOpen()
      if (item.signal.aborted || !cells.has(item.call.cellId)) throw new Error("Code Mode tool call aborted before dispatch")
      if (cells.get(item.call.cellId)?.replan) throw instructionReplan(cells.get(item.call.cellId)!.replan!)
      if (prepared.tool !== item.tool || tools.get(item.call.name) !== item.tool) throw new Error("Code Mode tool binding changed during checkpoint")
      item.admitted()
      item.prepared = prepared
      try { item.bodyOutput = await tools.dispatch(prepared); item.hasOutput = true }
      catch (error) {
        const retained = retainedToolOutcome(error, prepared)
        if (retained) { item.retained = retained; item.recoveryCause = error }
        throw error
      }
      const disposition = instructionReplanDisposition(prepared)
      if (disposition) replanCell(item.call.cellId, disposition)
      records.settle(item, { value: await complete(item) })
    } catch (error) {
      if (isInstructionReplan(error) && !isPolicyRefusal(error) && (!item.prepared || resultExecution(item.prepared).dispatch === 'not-dispatched')) {
        replanCell(item.call.cellId, error.data)
        try { await records.record(item, error.data, true); records.settle(item, { error }) }
        catch (cause) { records.settle(item, { error: recovery(cause) }) }
        return
      }
      if (item.retained) {
        records.settle(item, { error: recovery(error) })
        return
      }
      if (isPolicyRefusal(error)) retireCell(item.call.cellId)
      // A real body/finalizer value can never be overwritten with a synthetic
      // storage error. Its retained source is reconciled without execution.
      if (item.hasOutput || item.result) {
        if (!item.result && !item.recorded && !item.finalization) item.source.requireRecovery()
        const failure = item.recorded ? error : !item.result
          ? Object.assign(fatal(`Code Mode finalization failed: ${message(error)}`), { code: 'FACT_RECOVERY_REQUIRED' }) : recovery(error)
        if (isPolicyRefusal(failure)) retireCell(item.call.cellId)
        records.settle(item, { error: failure })
      } else {
        try {
          await records.record(item, { error: message(error), code: isPolicyRefusal(error) ? "POLICY_REFUSAL" : item.signal.aborted ? "TOOL_ABORTED" : "TOOL_FAILED" }, true, undefined,
            item.prepared ? resultExecution(item.prepared) : { outcome: item.signal.aborted ? 'canceled' : 'failed', dispatch: 'not-dispatched' })
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
        const cell = cells.get(item.call.cellId)
        if (cell?.replan) {
          queue.shift()
          const error = instructionReplan(cell.replan)
          try { await records.record(item, error.data, true); records.settle(item, { error }) }
          catch (cause) { records.settle(item, { error: recovery(cause) }) }
          item.admitted(); await release(item); continue
        }
        if (cell && (cell.instructionOrigin || registryRequiresInstructionOrigin(tools)) && !item.capture && !item.captureFailure) {
          const group = queue.filter(value => value.call.cellId === item.call.cellId && !value.capture && !value.captureFailure)
          const entries: import('@i-harness/core-tools').InstructionBatchEntry[] = []
          let failure: unknown, failed = false, missingOriginMutation = false
          for (const pending of group) {
            try {
              pending.generation = pending.call.origin.generationLineage?.forInvocation({ view: options.session, cellId: pending.call.cellId, action: pending.action, eventSeq: pending.eventSeq!, callId: pending.call.invocationId, name: pending.call.name, signal: pending.signal,
                current: () => !disposed && !pending.signal.aborted && cells.has(pending.call.cellId) && active.has(pending) && tools.get(pending.call.name) === pending.tool })
              const capture = tools.capture({ name: pending.call.name, args: pending.call.args }, { sessionId: options.sessionId ?? pending.call.origin.sessionId, session: options.session, callId: pending.call.invocationId, callEventSeq: pending.eventSeq, resultConsumer: 'code', settlementSource: pending.source, modelGeneration: pending.generation?.factories })
              const origin = cell.instructionOrigin ? bindInstructionInvocation(cell.instructionOrigin, pending.call.invocationId, capture) : undefined
              pending.capture = capture; pending.instructionOrigin = origin
              if (origin) entries.push({ registry: tools, capture, origin })
              else if (tools.inspectCapture(capture).native?.targets.some(target => target.mode === 'mutate')) missingOriginMutation = true
            } catch (error) {
              if (isPolicyRefusal(error) || !isNativePlanValidationError(error) && !(error instanceof ToolArgsError)) { failure = error; failed = true; break }
              pending.captureFailure = error
            }
          }
          if (!failed) try {
            if (missingOriginMutation) throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'missing-origin', currentFingerprint: '' })
            if (cell.instructionOrigin) {
              const preflight = preflightInstructionInvocations(cell.instructionOrigin, entries, AbortSignal.any(group.map(value => value.signal)))
              cell.preflights.add(preflight)
              try { await preflight } finally { cell.preflights.delete(preflight) }
            }
          } catch (error) { failure = error; failed = true }
          const stopped = group.some(value => value.signal.aborted)
          if (stopped) { failure = new Error('Code Mode tool call aborted before dispatch'); failed = true }
          if (!stopped && failure && isInstructionReplan(failure) && !isPolicyRefusal(failure)) replanCell(item.call.cellId, failure.data)
          for (const pending of group) {
            const error = pending.captureFailure ?? failure
            if (!pending.captureFailure && !failed) continue
            const at = queue.indexOf(pending); if (at >= 0) queue.splice(at, 1)
            try {
              const output = stopped || pending.signal.aborted ? { error: 'Code Mode tool call aborted before dispatch', code: 'TOOL_ABORTED_BEFORE_DISPATCH' } : isPolicyRefusal(error) ? { error: message(error), code: 'POLICY_REFUSAL' } : isNativePlanValidationError(error) ? error.output : isInstructionReplan(error) ? error.data : { error: message(error), code: 'TOOL_FAILED' }
              await records.record(pending, output, true, undefined, { outcome: stopped || pending.signal.aborted ? 'canceled' : 'failed', dispatch: 'not-dispatched' })
              records.settle(pending, !stopped && !isPolicyRefusal(error) && isNativePlanValidationError(error) ? { value: output } : { error })
            } catch (cause) { records.settle(pending, { error: recovery(cause) }) }
            pending.admitted(); await release(pending)
          }
          if (failed && (!isInstructionReplan(failure) || isPolicyRefusal(failure))) retireCell(item.call.cellId)
          continue
        }
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
    startCell(id: string, instructionOrigin?: InstructionCellOrigin) {
      if (disposed || cells.has(id) || retiredCells.has(id)) throw new Error("Code Mode cell unavailable")
      const cell: Cell = { tools: captureCodeModeTools(tools), stop: new AbortController(), seen: new Set(), preflights: new Set(), instructionOrigin, ending: Promise.withResolvers<void>() }
      cells.set(id, cell)
      return Object.freeze({ settle: () => finishOriginalCell(id, cell) })
    },
    retireCell,
    replanCell,
    drainCell,
    finishReplannedCell: finishTerminalCell,
    finishRetiredCell: finishTerminalCell,
    async invoke(original: CodeModeInvocation): Promise<unknown> {
      const cell = cells.get(original.cellId)
      if (disposed || !cell) throw new Error("Code Mode cell unavailable")
      if (cell.instructionOrigin !== original.origin.instructionOrigin) throw new Error('Code Mode instruction origin mismatch')
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
      for (const [id, cell] of cells) if (!cell.replan) retireCell(id)
      const pending = (async () => {
        await Promise.allSettled([...jobs])
        await Promise.allSettled([...cells.values(), ...retiredCells.values()].flatMap(cell => [...cell.preflights]))
        const errors: unknown[] = []
        for (const item of unsettled) try { await item.source.close(); unsettled.delete(item) } catch (error) { errors.push(error) }
        for (const [id, cell] of retiredCells) {
          if (cell.instructionOrigin && !cell.terminalCommitted) { errors.push(new FactRecoveryRequiredError()); continue }
          if (![...unsettled].some(item => item.call.cellId === id)) try { await finishCell(id) } catch (error) { errors.push(error) }
        }
        if ([...cells.values()].some(cell => cell.replan)) errors.push(new FactRecoveryRequiredError())
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
