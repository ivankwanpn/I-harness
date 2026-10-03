import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { CodeModeConfig, CodeModeItem, CodeModeObservation, CodeModeOrigin, CodeModeRuntime, CodeModeRuntimeOptions, CodeModeStatus } from './types.js'

const TEXT_CAP = 16 * 1024
const ITEM_CAP = 256
function limit(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`)
  return Math.min(max, Math.max(min, Math.floor(value)))
}
function limits(config: CodeModeConfig = {}) {
  return {
    memoryLimitMb: limit(config.memoryLimitMb, 64, 8, 256, 'memoryLimitMb'),
    cpuTimeMs: limit(config.cpuTimeMs, 1000, 10, 10_000, 'cpuTimeMs'),
    maxActiveCells: limit(config.maxActiveCells, 4, 1, 16, 'maxActiveCells'),
    maxPendingCalls: limit(config.maxPendingCalls, 64, 1, 256, 'maxPendingCalls'),
    maxSourceBytes: limit(config.maxSourceBytes, 128 * 1024, 1, 1024 * 1024, 'maxSourceBytes'),
    maxResultBytes: limit(config.maxResultBytes, 4 * 1024 * 1024, 1, 16 * 1024 * 1024, 'maxResultBytes'),
    maxStoreBytes: limit(config.maxStoreBytes, 1024 * 1024, 1, 4 * 1024 * 1024, 'maxStoreBytes'),
    defaultYieldTimeMs: limit(config.defaultYieldTimeMs, 1000, 0, 60_000, 'defaultYieldTimeMs'),
    defaultOutputTokens: limit(config.defaultOutputTokens, 4096, 0, 4096, 'defaultOutputTokens'),
  }
}
function json(value: unknown, bytes: number, label: string): string {
  let consumed = 0
  let root = true
  const counts = new WeakMap<object, number>()
  const overflow = () => { throw new Error(`${label} transfer limit exceeded`) }
  const stringBytes = (text: string) => {
    if (Buffer.byteLength(text) > bytes) return overflow()
    return Buffer.byteLength(JSON.stringify(text))
  }
  // The replacer sees each leaf before JSON.stringify materializes it into the
  // result. In particular, a huge string refuses before later getters run.
  const encoded = JSON.stringify(value === undefined ? null : value,function(key,current: unknown) {
    const array = Array.isArray(this)
    const omitted = current === undefined || typeof current === 'function' || typeof current === 'symbol'
    let size = 0
    if (root) root = false
    else if (!omitted || array) {
      const count = counts.get(this) ?? 0
      counts.set(this,count + 1)
      size += count ? 1 : 0
      if (!array) size += stringBytes(key) + 1
    }
    if (typeof current === 'string') size += stringBytes(current)
    else if (current === null || (omitted && array)) size += 4
    else if (typeof current === 'boolean') size += current ? 4 : 5
    else if (typeof current === 'number') size += Number.isFinite(current) ? String(current).length : 4
    else if (typeof current === 'object') {
      if (Array.isArray(current) && current.length > bytes) overflow()
      size += 2
    }
    consumed += size
    if (consumed > bytes) overflow()
    return current
  })
  if (encoded === undefined || Buffer.byteLength(encoded) > bytes) throw new Error(`${label} transfer limit exceeded`)
  return encoded
}
function message(error: unknown): string {
  try { return typeof error === 'object' && error !== null ? 'message' in error && typeof error.message === 'string' ? error.message : 'Host error' : String(error) }
  catch { return 'Host error message unavailable' }
}
function diagnostic(error: unknown, bytes: number): {text:string; truncated:boolean} {
  const raw = message(error)
  // Slice before encoding to avoid allocating a copy of an oversized message.
  const text = textSlice(raw.slice(0,bytes),bytes)
  return {text,truncated:text !== raw}
}
function textSlice(value: string, bytes: number): string {
  let result = Buffer.from(value).subarray(0, bytes).toString('utf8')
  while (Buffer.byteLength(result) > bytes) result = result.slice(0, -1)
  return result
}
interface Cell {
  id: string
  worker: Worker
  origin: CodeModeOrigin
  status: CodeModeStatus
  error?: string
  policyRefusal?: true
  items: CodeModeItem[]
  bytes: number
  textBytes: number
  truncated: boolean
  observer: boolean
  yielded: boolean
  wake?: () => void
  watchdog?: ReturnType<typeof setTimeout>
  removeOwner?: () => void
  calls: Map<string, AbortController>
  producers: Set<Promise<void>>
  stop?: Promise<number>
  knownTools: Set<string>
}

/** Each admission owns a fresh WASM worker. Only JSON crosses its boundary. */
export function createCodeModeRuntime(options: CodeModeRuntimeOptions): CodeModeRuntime {
  const config = limits(options.config)
  const errorCap = Math.min(4096,config.maxResultBytes)
  const cells = new Map<string, Cell>()
  const store = new Map<string, unknown>()
  const producers = new Set<Promise<void>>()
  const stopping = new Set<Promise<number>>()
  let disposed = false
  let disposing: Promise<void> | undefined
  let cancelling: Promise<void> | undefined

  function event(event: Parameters<NonNullable<CodeModeRuntimeOptions['onEvent']>>[0]) { options.onEvent?.(event) }
  function stop(cell: Cell) {
    if (cell.stop) return cell.stop
    const pending = cell.worker.terminate()
    cell.stop = pending
    stopping.add(pending)
    void pending.finally(() => stopping.delete(pending))
    return pending
  }
  function close(cell: Cell, status: Exclude<CodeModeStatus, 'running'>, error?: string, policyRefusal?: true) {
    if (cell.status !== 'running') return
    const bounded = error === undefined ? undefined : diagnostic(error,errorCap)
    cell.status = status
    cell.error = bounded?.text
    cell.truncated ||= bounded?.truncated ?? false
    cell.policyRefusal = policyRefusal
    clearTimeout(cell.watchdog)
    cell.removeOwner?.()
    for (const controller of cell.calls.values()) controller.abort(cell.error ?? 'Cell completed')
    cell.calls.clear()
    void stop(cell)
    try { event({type:'closed',cellId:cell.id,status,error:cell.error,policyRefusal,origin:cell.origin}) }
    catch (failure) {
      if (cell.status !== 'terminated') cell.status = 'failed'
      const failed = diagnostic(failure,errorCap)
      const combined = diagnostic(cell.error ? `${cell.error}; ${failed.text}` : failed.text,errorCap)
      cell.error = combined.text
      cell.truncated ||= failed.truncated || combined.truncated
    }
    finally { cell.wake?.() }
  }
  function output(cell: Cell, encoded: string) {
    if (cell.status !== 'running') return
    const item = JSON.parse(encoded) as CodeModeItem
    const bytes = Buffer.byteLength(encoded)
    if (cell.items.length >= ITEM_CAP || cell.bytes + bytes > config.maxResultBytes ||
        (item.type === 'text' && cell.textBytes + Buffer.byteLength(item.text) > TEXT_CAP)) {
      cell.truncated = true
      return
    }
    cell.items.push(item)
    cell.bytes += bytes
    if (item.type === 'text') cell.textBytes += Buffer.byteLength(item.text)
    event({type:'output',cellId:cell.id,item,origin:cell.origin})
  }
  function call(cell: Cell, id: string, name: string, encoded: string) {
    if (cell.status !== 'running') return
    if (!cell.knownTools.has(name) || cell.calls.has(id)) { close(cell,'failed','Invalid tool request'); return }
    if (cell.calls.size >= config.maxPendingCalls) {
      cell.worker.postMessage({type:'result',id,error:'Pending tool call limit exceeded'})
      return
    }
    if (Buffer.byteLength(encoded) > config.maxResultBytes) {
      cell.worker.postMessage({type:'result',id,error:'Tool argument transfer limit exceeded'})
      return
    }
    const controller = new AbortController()
    function reject(error: unknown) {
      const bounded = diagnostic(error,errorCap)
      cell.truncated ||= bounded.truncated
      cell.worker.postMessage({type:'result',id,error:bounded.text,truncated:bounded.truncated})
    }
    cell.calls.set(id,controller)
    let invocation: Promise<unknown>
    try { invocation = Promise.resolve(options.invoke({cellId:cell.id,invocationId:id,name,args:JSON.parse(encoded),origin:cell.origin,signal:controller.signal})) }
    catch (error) { invocation = Promise.reject(error) }
    const producer = invocation.then(value => {
      if (cell.status !== 'running' || controller.signal.aborted) return
      try { cell.worker.postMessage({type:'result',id,json:json(value,config.maxResultBytes,'Tool result')}) }
      catch (error) { reject(error) }
    }, error => {
      if (cell.status !== 'running') return
      if (typeof error === 'object' && error !== null && 'policyRefusal' in error && error.policyRefusal === true) {
        close(cell,'terminated',message(error),true)
      } else if (!controller.signal.aborted) reject(error)
    }).finally(() => { cell.calls.delete(id); producers.delete(producer); cell.producers.delete(producer) })
    producers.add(producer)
    cell.producers.add(producer)
  }
  function receive(cell: Cell, data: {type:string; [key:string]: unknown}) {
    if (cell.status !== 'running') return
    try {
      switch (data.type) {
        case 'busy':
          clearTimeout(cell.watchdog)
          cell.watchdog = setTimeout(() => close(cell,'failed','CPU work limit exceeded (worker hard stop)'),config.cpuTimeMs + 250)
          break
        case 'idle': clearTimeout(cell.watchdog); break
        case 'output': output(cell,data.json as string); break
        case 'truncated': cell.truncated = true; break
        case 'yield': cell.yielded = true; cell.wake?.(); break
        case 'call': call(cell,data.id as string,data.name as string,data.json as string); break
        case 'closed': {
          cell.truncated ||= data.truncated === true
          if (data.status === 'completed') {
            const writes = JSON.parse(data.writes as string) as [string,unknown][]
            const merged = new Map(store)
            for (const [key,value] of writes) merged.set(key,value)
            json([...merged],config.maxStoreBytes,'Session store')
            store.clear()
            for (const [key,value] of merged) store.set(key,value)
            close(cell,'completed')
          } else close(cell,'failed',message(data.error ?? 'Guest failed'))
          break
        }
      }
    } catch (error) { close(cell,'failed',message(error)) }
  }
  async function observe(cell: Cell, duration: number, tokens: number, signal?: AbortSignal, terminate = false): Promise<CodeModeObservation> {
    if (cell.observer) throw new Error('Cell already has an active observer')
    cell.observer = true
    let removeAbort: (() => void) | undefined
    try {
      if (terminate && cell.status === 'running') close(cell,'terminated','Cell terminated by observer')
      if (signal?.aborted) close(cell,'terminated',message(signal.reason ?? 'Observer aborted'))
      if (cell.status === 'running' && !cell.yielded) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(done,duration)
          function done() { clearTimeout(timer); cell.wake = undefined; resolve() }
          cell.wake = done
          if (signal) {
            const abort = () => close(cell,'terminated',message(signal.reason ?? 'Observer aborted'))
            signal.addEventListener('abort',abort,{once:true})
            removeAbort = () => signal.removeEventListener('abort',abort)
          }
        })
      }
      const items: CodeModeItem[] = []
      let remaining = Math.min(TEXT_CAP,tokens * 4)
      let truncated = cell.truncated
      const error = cell.error === undefined ? undefined : textSlice(cell.error,remaining)
      if (error !== undefined) {
        truncated ||= error !== cell.error
        remaining -= Buffer.byteLength(error)
      }
      let textCount = 0
      for (const item of cell.items) {
        if (item.type !== 'text') { items.push(item); continue }
        const separator = textCount ? 1 : 0
        const value = textSlice(item.text,Math.max(0,remaining - separator))
        if (value !== item.text) truncated = true
        if (value || (!item.text && remaining >= separator)) { items.push({type:'text',text:value}); remaining -= Buffer.byteLength(value) + separator; textCount++ }
        else if (!item.text) truncated = true
      }
      const out: CodeModeObservation = {cellId:cell.id,status:cell.status,items,text:items.filter((item): item is Extract<CodeModeItem,{type:'text'}> => item.type === 'text').map(item=>item.text).join('\n'),truncated,
        ...(error === undefined ? {} : {error}), ...(cell.policyRefusal ? {policyRefusal:true} : {})}
      cell.items = []; cell.bytes = 0; cell.textBytes = 0; cell.truncated = false; cell.yielded = false
      if (cell.status !== 'running') cells.delete(cell.id)
      else cell.worker.postMessage({type:'observed'})
      return out
    } finally { removeAbort?.(); cell.observer = false }
  }
  const runtime: CodeModeRuntime = {
    async exec(input,providedOrigin = {}) {
      // Cell authority belongs to the metadata admitted here, even if a caller
      // reuses or later mutates its own origin object. Only the signal is shared.
      const origin: CodeModeOrigin = Object.freeze({
        sessionId: providedOrigin.sessionId,
        callId: providedOrigin.callId,
        callEventSeq: providedOrigin.callEventSeq,
        abortSignal: providedOrigin.abortSignal,
      })
      if (disposed) throw new Error('Code Mode runtime is disposed')
      if (cancelling) throw new Error('Code Mode runtime is cancelling active cells')
      if (!input || typeof input.code !== 'string') throw new Error('Code source must be a string')
      if (Buffer.byteLength(input.code) > config.maxSourceBytes) throw new Error('Code source limit exceeded')
      if (origin.abortSignal?.aborted) throw new Error('Cell owner already aborted')
      if ([...cells.values()].filter(cell => cell.status === 'running').length >= config.maxActiveCells) throw new Error('Active cell limit exceeded')
      let duration = input.yield_time_ms, tokens = input.max_output_tokens
      const pragma = /^\/\/ @exec:\s*(\{[^\r\n]*\})\s*(?:\r?\n|$)/.exec(input.code)
      if (pragma) {
        const values = JSON.parse(pragma[1]) as {yield_time_ms?:number; max_output_tokens?:number}
        duration ??= values.yield_time_ms; tokens ??= values.max_output_tokens
      }
      const yieldMs = limit(duration,config.defaultYieldTimeMs,0,60_000,'yield_time_ms')
      const maxTokens = limit(tokens,config.defaultOutputTokens,0,4096,'max_output_tokens')
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
      const retention = config.maxActiveCells * 4
      for (const [cellId,cell] of cells) {
        if (cells.size < retention) break
        if (cell.status !== 'running' && !cell.observer) cells.delete(cellId)
      }
      const id = randomUUID()
      try { event({type:'started',cellId:id,source:input.code,origin}) }
      catch (error) {
        const bounded = diagnostic(error,errorCap)
        throw Object.assign(new Error(bounded.text),{truncated:bounded.truncated})
      }
      const worker = new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{code:input.code,cellId:id,catalog:catalogJson,store:JSON.stringify([...store]),config},execArgv:[]})
      const cell: Cell = {id,worker,origin,status:'running',items:[],bytes:0,textBytes:0,truncated:false,observer:false,yielded:false,calls:new Map(),producers:new Set(),knownTools:names}
      cells.set(id,cell)
      worker.on('message',data => receive(cell,data))
      worker.on('error',error => close(cell,'failed',message(error)))
      worker.on('exit',code => { if (cell.status === 'running') close(cell,'failed',`Worker exited unexpectedly (${code})`) })
      cell.watchdog = setTimeout(()=>close(cell,'failed','Worker initialization deadline exceeded'),30_000)
      if (origin.abortSignal) {
        const abort = () => close(cell,'terminated',message(origin.abortSignal?.reason ?? 'Cell owner aborted'))
        origin.abortSignal.addEventListener('abort',abort,{once:true})
        cell.removeOwner = () => origin.abortSignal?.removeEventListener('abort',abort)
        if (origin.abortSignal.aborted) abort()
      }
      return observe(cell,yieldMs,maxTokens)
    },
    async wait(input,signal) {
      const cell = cells.get(input.cell_id)
      if (!cell) throw new Error('Cell unavailable: unknown, retired, or interrupted by runtime restart')
      const observation = await observe(cell,limit(input.yield_time_ms,config.defaultYieldTimeMs,0,60_000,'yield_time_ms'),limit(input.max_tokens,config.defaultOutputTokens,0,4096,'max_tokens'),signal,input.terminate === true)
      // The cancelling observer owns this cell's tool cleanup. An observer
      // of a separate human stop remains independent of that owner's drain.
      if (input.terminate === true || signal?.aborted) await Promise.allSettled([cell.stop, ...cell.producers])
      return observation
    },
    async terminate(cellId, reason = 'Cell stopped by its owner') {
      const cell = cells.get(cellId)
      if (!cell || cell.status !== 'running') throw new Error('Cell unavailable: unknown, retired, or interrupted by runtime restart')
      // Keep the cell object even if the observer retires its map entry while
      // the nested producer drains. Cancellation owns no output cursor.
      close(cell,'terminated',reason)
      await Promise.allSettled([cell.stop, ...cell.producers])
    },
    async cancel(reason = 'Code Mode cancelled') {
      if (cancelling) return cancelling
      // Start the admission barrier before calling any event/abort listeners.
      let finish!: () => void
      const barrier = new Promise<void>(resolve => { finish = resolve })
      cancelling = barrier
      for (const cell of cells.values()) close(cell,'terminated',reason)
      try {
        await Promise.allSettled([...stopping])
        await Promise.allSettled([...producers])
      } finally { cancelling = undefined; finish() }
    },
    async dispose() {
      if (!disposing) {
        disposed = true
        disposing = runtime.cancel('Code Mode disposed').then(()=>{cells.clear(); store.clear()})
      }
      return disposing
    },
  }
  return runtime
}
