import type { CodeModeRuntime, CodeModeRuntimeOptions } from './types.js'
import { limits, limit } from './runtime/limits.js'
import { createCellState } from './runtime/cell-state.js'
import { createRetirement } from './runtime/retirement.js'
import { createOutput } from './runtime/output.js'
import { createWorkerEvents } from './runtime/worker-events.js'
import { createAdmission } from './runtime/admission.js'

/** Each admission owns a fresh WASM worker. Only JSON crosses its boundary. */
export function createCodeModeRuntime(options: CodeModeRuntimeOptions): CodeModeRuntime {
  const config = limits(options.config)
  const errorCap = Math.min(4096,config.maxResultBytes)
  const state = createCellState(options,config)
  function event(event: Parameters<NonNullable<CodeModeRuntimeOptions['onEvent']>>[0]) { return options.onEvent?.(event) }
  const retirement = createRetirement(options,errorCap,state,event,reason => runtime.cancel(reason))
  const output = createOutput(options,config,errorCap,state,retirement,event)
  const workers = createWorkerEvents(options,config,errorCap,state,retirement,output)
  const exec = createAdmission(options,config,errorCap,state,retirement,output,workers,event)
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
    dispose: retirement.dispose,
  }
  return runtime
}
