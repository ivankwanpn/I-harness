import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { CodeModeOrigin, CodeModeRuntime, CodeModeRuntimeOptions, CodeModeRuntimeEvent } from '../types.js'
import type { Cell, CellState } from './cell-state.js'
import type { RuntimeLimits } from './limits.js'
import type { Retirement } from './retirement.js'
import type { Output } from './output.js'
import type { createWorkerEvents } from './worker-events.js'
import { diagnostic, json, limit } from './limits.js'

/** Admission reservation/start-hook fence before registration and observation. */
export function createAdmission(
  options: CodeModeRuntimeOptions,
  config: RuntimeLimits,
  errorCap: number,
  state: Pick<CellState, 'currentStore' | 'track' | 'values' | 'installStore' | 'prune' | 'register'>,
  retirement: Pick<Retirement, 'isDisposed' | 'isCancelling' | 'epoch'>,
  output: Pick<Output, 'observe'>,
  workers: ReturnType<typeof createWorkerEvents>,
  event: (event: CodeModeRuntimeEvent) => void | Promise<void>,
) {
  let admissions = 0
  const { currentStore, track } = state
  const { observe } = output
  const exec: CodeModeRuntime['exec'] = async (input,providedOrigin = {},observation) => {
    // Cell authority belongs to the metadata admitted here, even if a caller
    // reuses or later mutates its own origin object. Only the signal is shared.
    const origin: CodeModeOrigin = Object.freeze({
      sessionId: providedOrigin.sessionId,
      callId: providedOrigin.callId,
      callEventSeq: providedOrigin.callEventSeq,
      abortSignal: providedOrigin.abortSignal,
    })
    if (retirement.isDisposed()) throw new Error('Code Mode runtime is disposed')
    if (retirement.isCancelling()) throw new Error('Code Mode runtime is cancelling active cells')
    if (!input || typeof input.code !== 'string') throw new Error('Code source must be a string')
    if (Buffer.byteLength(input.code) > config.maxSourceBytes) throw new Error('Code source limit exceeded')
    if (origin.abortSignal?.aborted) throw new Error('Cell owner already aborted')
    if (admissions + [...state.values()].filter(cell => cell.status === 'running').length >= config.maxActiveCells) throw new Error('Active cell limit exceeded')
    let duration = input.yield_time_ms, tokens = input.max_output_tokens
    const pragma = /^\/\/ @exec:\s*(\{[^\r\n]*\})\s*(?:\r?\n|$)/.exec(input.code)
    if (pragma) {
      const values = JSON.parse(pragma[1]) as {yield_time_ms?:number; max_output_tokens?:number}
      duration ??= values.yield_time_ms; tokens ??= values.max_output_tokens
    }
    const yieldMs = limit(duration,config.defaultYieldTimeMs,0,60_000,'yield_time_ms')
    const maxTokens = limit(tokens,config.defaultOutputTokens,0,4096,'max_output_tokens')
    const restored = currentStore(origin)
    const initialStoreJson = JSON.stringify([...restored])
    state.installStore(restored)
    const definitions = options.tools()
    const aliases = new Set<string>()
    const names = new Set<string>()
    const catalog = definitions.map(definition => {
      if (!definition || typeof definition.name !== 'string' || !definition.name) throw new Error('Invalid tool name')
      let alias = definition.name.replace(/[^a-zA-Z0-9_]/g,'_')
      if (/^[0-9]/.test(alias)) alias = `_${alias}`
      if (aliases.has(alias) || names.has(definition.name)) throw new Error(`Tool alias collision: ${alias}`)
      aliases.add(alias); names.add(definition.name)
      return {...definition,alias}
    })
    const catalogJson = json(catalog,config.maxResultBytes,'Tool catalog')
    // Completed cells that were never observed cannot grow session memory
    // indefinitely. Their IDs subsequently report the same truthful retirement.
    state.prune(config.maxActiveCells * 4)
    const id = randomUUID()
    const epoch = retirement.epoch()
    admissions++
    try {
      const started = event({type:'started',cellId:id,source:input.code,origin})
      if (started) {
        const pending = Promise.resolve(started)
        track(pending.catch(() => {}))
        await pending
      }
      if (retirement.isDisposed() || epoch !== retirement.epoch() || origin.abortSignal?.aborted) throw new Error('Cell admission stopped by its owner')
    }
    catch (error) {
      const bounded = diagnostic(error,errorCap)
      throw Object.assign(new Error(bounded.text),{truncated:bounded.truncated})
    }
    finally { admissions-- }
    const worker = new Worker(new URL('../worker.mjs',import.meta.url),{workerData:{code:input.code,cellId:id,catalog:catalogJson,store:initialStoreJson,config},execArgv:[]})
    const cell: Cell = {id,worker,origin,status:'running',items:[],bytes:0,textBytes:0,truncated:false,observer:false,yielded:false,calls:new Map(),producers:new Set(),knownTools:names,finishing:false,commitStop:new AbortController(),retentionStop:new AbortController(),textIncomplete:false,admission:Promise.resolve(),pendingBytes:0,pendingItems:0}
    state.register(cell)
    workers.attach(cell)
    return observe(cell,yieldMs,maxTokens,undefined,false,observation)
  }
  return exec
}
