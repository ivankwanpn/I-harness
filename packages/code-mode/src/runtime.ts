import type { CodeModeRuntime, CodeModeRuntimeOptions } from './types.js'
import { limits, limit } from './runtime/limits.js'
import { createCellState } from './runtime/cell-state.js'
import { createRetirement } from './runtime/retirement.js'
import { createOutput } from './runtime/output.js'
import { createWorkerEvents } from './runtime/worker-events.js'
import { createAdmission } from './runtime/admission.js'
import { instructionReplan } from '@i-harness/core-tools'
import { FactRecoveryRequiredError } from '@i-harness/core-session'
import { createCellFinalizations, type OriginalCellFinalization } from './finalization.ts'

type WorkerAcquisition = 'unknown' | 'not-acquired' | 'acquired'
const workerAcquisitions = new WeakMap<OriginalCellFinalization, () => WorkerAcquisition>()
interface OriginalOutputLifetime { accepted:number;truncated:boolean;policyRefusal?:true;instructionReplan?:true }
const outputLifetimes = new WeakMap<OriginalCellFinalization, () => Readonly<OriginalOutputLifetime>>()
export function readOriginalOutputLifetime(handle:OriginalCellFinalization):Readonly<OriginalOutputLifetime> {
  const read=outputLifetimes.get(handle)
  if(!read)throw new Error('Original runtime output lifetime unavailable')
  return read()
}
export function readOriginalWorkerAcquisition(handle: OriginalCellFinalization): WorkerAcquisition {
  const read=workerAcquisitions.get(handle)
  if(!read)throw new Error('Original runtime worker acquisition unavailable')
  return read()
}

/** Each admission owns a fresh WASM worker. Only JSON crosses its boundary. */
export function createCodeModeRuntime(options: CodeModeRuntimeOptions): CodeModeRuntime {
  const config = limits(options.config)
  const errorCap = Math.min(4096,config.maxResultBytes)
  const state = createCellState(options,config)
  const finalizations = createCellFinalizations('runtime-retirement')
  const endings = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  function event(event: Parameters<NonNullable<CodeModeRuntimeOptions['onEvent']>>[0]) {
    // Runtime component proves only original executable/producer retirement.
    // Assembly separately joins the actual terminal/store receipt owner.
    if (event.type === 'closed') endings.get(event.cellId)?.resolve()
    return options.onEvent?.(event)
  }
  const retirement = createRetirement(options,errorCap,state,event,reason => runtime.cancel(reason))
  const output = createOutput(options,config,state,retirement,event)
  const workers = createWorkerEvents(options,config,errorCap,state,retirement,output)
  const exec = createAdmission(options,config,errorCap,state,retirement,output,workers,event, (id, original) => {
    const end = Promise.withResolvers<void>()
    let acquisition: 'unknown' | 'not-acquired' | 'acquired' = 'unknown'
    endings.set(id, end)
    const handle = finalizations.reserve(id, async () => {
      await end.promise
      const cell = original()
      if (cell) {
        if (!cell.stop) throw new FactRecoveryRequiredError()
        await cell.stop
        const joined = await Promise.allSettled([...cell.invocations])
        const failures = joined.filter((value): value is PromiseRejectedResult => value.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map(value => value.reason), 'Original Code invocations incomplete')
      }
      endings.delete(id)
    }, handle=>{
      workerAcquisitions.set(handle,()=>acquisition)
      outputLifetimes.set(handle,()=>Object.freeze({ accepted: original()?.lifetimeOutput?.accepted ?? 0, truncated: original()?.lifetimeOutput?.truncated ?? false,policyRefusal:original()?.policyRefusal,...original()?.instructionReplan?{instructionReplan:true as const}:{} }))
    })
    void end.promise.then(() => handle.settle()).catch(() => {})
    return { abandon() { acquisition = 'not-acquired'; end.resolve() }, acquired() { acquisition = 'acquired' } }
  })
  const { observe } = output
  const { close } = retirement
  const runtime: CodeModeRuntime = {
    exec,
    async wait(input,signal,options) {
      const cell = state.get(input.cell_id)
      if (!cell) throw new Error('Cell unavailable: unknown, retired, or interrupted by runtime restart')
      const observation = await observe(cell,limit(input.yield_time_ms,config.defaultYieldTimeMs,0,60_000,'yield_time_ms'),limit(input.max_tokens,config.defaultOutputTokens,0,4096,'max_tokens'),signal,input.terminate === true,options)
      // The cancelling observer owns this cell's tool cleanup. An observer
      // of a separate human stop remains independent of that owner's drain.
      if (input.terminate === true || signal?.aborted) await Promise.allSettled([cell.stop, ...cell.producers])
      return observation
    },
    async terminate(cellId, reason = 'Cell stopped by its owner') {
      const cell = state.get(cellId)
      if (!cell || cell.status !== 'running') throw new Error('Cell unavailable: unknown, retired, or interrupted by runtime restart')
      // Keep the cell object even if the observer retires its map entry while
      // the nested producer drains. Cancellation owns no output cursor.
      close(cell,'terminated',reason)
      await Promise.allSettled([cell.stop, ...cell.producers])
    },
    cancel: retirement.cancel,
    async dispose() { await retirement.dispose(); await finalizations.drain() },
    replan(cellId, detail) { const cell = state.get(cellId); if (cell) retirement.replan(cell, instructionReplan(detail)) },
    async drainRetainedObservations() {
      for (const cell of state.values()) {
        await cell.pendingProjection?.settle()
        if (cell.instructionReplan && cell.recoveryRequired && !cell.replanTerminalStarted) {
          cell.recoveryRequired = false; cell.resumeCompletion?.(); await cell.replanDrain
          if (cell.recoveryRequired) throw new FactRecoveryRequiredError()
        }
      }
    },
  }
  finalizations.bind(runtime)
  return runtime
}
