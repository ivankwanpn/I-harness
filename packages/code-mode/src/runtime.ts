import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { createUnifiedSpillStore } from '@i-harness/output-retention'
import { validateImage } from '@i-harness/image-validation'
import type { CodeModeConfig, CodeModeItem, CodeModeObservation, CodeModeOrigin, CodeModeRuntime, CodeModeRuntimeOptions, CodeModeStatus, CodeModeStoreEntries, CodeModeTextRetention } from './types.js'

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
function json(value: unknown, bytes: number, label: string, strict = false): string {
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
    if (strict && (omitted || typeof current === 'bigint' || typeof current === 'number' && !Number.isFinite(current))) throw new Error(`${label} must contain JSON values only`)
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
  finishing: boolean
  commitStop: AbortController
  retentionStop: AbortController
  textIncomplete: boolean
  admission: Promise<void>
  pendingBytes: number
  pendingItems: number
}

/** Each admission owns a fresh WASM worker. Only JSON crosses its boundary. */
export function createCodeModeRuntime(options: CodeModeRuntimeOptions): CodeModeRuntime {
  const config = limits(options.config)
  const errorCap = Math.min(4096,config.maxResultBytes)
  const cells = new Map<string, Cell>()
  const store = new Map<string, unknown>()
  const producers = new Set<Promise<void>>()
  const stopping = new Set<Promise<number>>()
  let commits: Promise<void> = Promise.resolve()
  let spillStore = options.spillStore
  let disposed = false
  let disposing: Promise<void> | undefined
  let cancelling: Promise<void> | undefined
  let admissions = 0, cancellationEpoch = 0

  function event(event: Parameters<NonNullable<CodeModeRuntimeOptions['onEvent']>>[0]) { return options.onEvent?.(event) }
  function entries(value: unknown): CodeModeStoreEntries {
    const encoded = json(value,config.maxStoreBytes,'Session store',true)
    const decoded: unknown = JSON.parse(encoded)
    if (!Array.isArray(decoded) || decoded.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) throw new Error('Invalid session store entries')
    return decoded as CodeModeStoreEntries
  }
  function currentStore(origin: CodeModeOrigin) {
    return options.restoreStore ? new Map(entries(options.restoreStore(origin))) : new Map(store)
  }
  function track(pending: Promise<void>, cell?: Cell) {
    producers.add(pending); cell?.producers.add(pending)
    void pending.finally(() => { producers.delete(pending); cell?.producers.delete(pending) })
  }
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
    cell.commitStop.abort(cell.error ?? 'Cell closed')
    if(status==='terminated') cell.retentionStop.abort(cell.error ?? 'Cell stopped')
    clearTimeout(cell.watchdog)
    cell.removeOwner?.()
    for (const controller of cell.calls.values()) controller.abort(cell.error ?? 'Cell completed')
    cell.calls.clear()
    void stop(cell)
    function failed(failure: unknown) {
      if (cell.status !== 'terminated') cell.status = 'failed'
      const failed = diagnostic(failure,errorCap)
      const combined = diagnostic(cell.error ? `${cell.error}; ${failed.text}` : failed.text,errorCap)
      cell.error = combined.text
      cell.truncated ||= failed.truncated || combined.truncated
    }
    try {
      const pending = event({type:'closed',cellId:cell.id,status,error:cell.error,policyRefusal,origin:cell.origin})
      if (pending) track(Promise.resolve(pending).catch(failed).finally(() => cell.wake?.()),cell)
    }
    catch (failure) {
      failed(failure)
    }
    finally { cell.wake?.() }
  }
  function output(cell: Cell, encoded: string) {
    if (cell.status !== 'running') return
    const item = JSON.parse(encoded) as CodeModeItem
    const bytes = Buffer.byteLength(encoded)
    if (cell.items.length + cell.pendingItems >= ITEM_CAP || cell.bytes + cell.pendingBytes + bytes > config.maxResultBytes) {
      cell.truncated = true
      cell.textIncomplete ||= item.type === 'text'
      return
    }
    // Reserve before asynchronous decoding. All following output shares the same
    // order, and completion waits for this barrier before committing any store.
    cell.pendingBytes += bytes; cell.pendingItems++
    cell.admission = cell.admission.then(async () => {
      if (cell.status !== 'running') return
      if (item.type === 'image') await validateImage(item.image, { signal: cell.commitStop.signal })
      if (cell.status !== 'running') return
      cell.items.push(item)
      cell.bytes += bytes
      if (item.type === 'text') cell.textBytes += Buffer.byteLength(item.text)
      await event({type:'output',cellId:cell.id,item,origin:cell.origin})
    }).catch(error => { if (cell.status === 'running') close(cell,'failed',message(error)) }).finally(() => {
      cell.pendingBytes -= bytes; cell.pendingItems--
    })
    track(cell.admission,cell)
  }
  function call(cell: Cell, id: string, name: string, encoded: string) {
    if (cell.status !== 'running' || cell.finishing) return
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
      if (cell.status !== 'running' || cell.finishing || controller.signal.aborted) return
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
  function complete(cell: Cell, encoded: string) {
    cell.finishing = true
    clearTimeout(cell.watchdog)
    // Executable lifetime ends when the guest module ends. Persistence retains
    // only JSON and never extends unawaited tools, timers or continuations.
    for (const controller of cell.calls.values()) controller.abort('Guest module completed')
    cell.calls.clear()
    void stop(cell)
    let writes: CodeModeStoreEntries
    try { writes = entries(JSON.parse(encoded)) }
    catch (error) { close(cell,'failed',message(error)); return }
    const finalize = async () => {
      try {
        await cell.admission
        if (cell.status !== 'running') return
        const merged = currentStore(cell.origin)
        for (const [key,value] of writes) merged.set(key,value)
        const bounded = entries([...merged])
        if (writes.length) await options.commitStore?.({cellId:cell.id,origin:cell.origin,writes,signal:cell.commitStop.signal})
        if (cell.status !== 'running') return
        const closing = event({type:'closed',cellId:cell.id,status:'completed',origin:cell.origin})
        if (closing) await closing
        if (cell.status !== 'running') return
        if (writes.length) {
          store.clear()
          for (const [key,value] of bounded) store.set(key,value)
        }
        cell.status = 'completed'
        cell.removeOwner?.()
        cell.wake?.()
      } catch (error) { close(cell,'failed',message(error)) }
    }
    // Read-only completions do not queue behind a held store write. Every write
    // merges and validates only when earlier durable commits have settled.
    const pending = writes.length ? commits.then(finalize) : finalize()
    if (writes.length) commits = pending.then(() => {}, () => {})
    track(pending,cell)
  }
  function receive(cell: Cell, data: {type:string; [key:string]: unknown}) {
    if (cell.status !== 'running' || cell.finishing) return
    try {
      switch (data.type) {
        case 'busy':
          clearTimeout(cell.watchdog)
          cell.watchdog = setTimeout(() => close(cell,'failed','CPU work limit exceeded (worker hard stop)'),config.cpuTimeMs + 250)
          break
        case 'idle': clearTimeout(cell.watchdog); break
        case 'output': output(cell,data.json as string); break
        case 'truncated': cell.truncated = true; cell.textIncomplete ||= data.text === true; break
        case 'yield': cell.yielded = true; cell.wake?.(); break
        case 'call': call(cell,data.id as string,data.name as string,data.json as string); break
        case 'closed': {
          cell.truncated ||= data.truncated === true
          if (data.status === 'completed') {
            complete(cell,data.writes as string)
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
      const admitted = cell.items
      const incomplete = cell.textIncomplete
      let truncated = cell.truncated
      // Detach the consumed window before awaiting disk I/O. Later guest output
      // stays queued for the next observer rather than disappearing on reset.
      cell.items = []; cell.bytes = 0; cell.textBytes = 0; cell.truncated = false; cell.textIncomplete = false; cell.yielded = false
      const fullText = admitted.filter((item): item is Extract<CodeModeItem,{type:'text'}> => item.type === 'text').map(item => item.text).join('\n')
      let textRetention: CodeModeTextRetention | undefined
      const previewBytes = Math.min(TEXT_CAP,tokens * 4)
      const diagnosticBytes = cell.error === undefined ? 0 : Buffer.byteLength(textSlice(cell.error,previewBytes))
      if (Buffer.byteLength(fullText) > previewBytes - diagnosticBytes || incomplete) {
        textRetention = {stored:false,cellId:cell.id,...(cell.origin.sessionId ? {sessionId:cell.origin.sessionId} : {}),admittedBytes:Buffer.byteLength(fullText),omittedBytes:0,complete:false,truncated:true}
        if (fullText) {
          try {
            const retaining = (async()=>{
              const retentionSignal=AbortSignal.any([cell.retentionStop.signal,...(cell.origin.abortSignal?[cell.origin.abortSignal]:[]),...(signal?[signal]:[])])
              retentionSignal.throwIfAborted()
              const ref=await options.retainText?.({text:fullText,cellId:cell.id,origin:{...cell.origin,abortSignal:retentionSignal},complete:!incomplete})
              retentionSignal.throwIfAborted()
              if(ref) return {ref}
              spillStore ??= createUnifiedSpillStore()
              return {path:await spillStore.saveText(fullText,`code-${cell.origin.sessionId ?? 'session'}-${cell.id}`)}
            })()
            track(retaining.then(() => {}, () => {}),cell)
            const stored = await retaining
            if(stored.ref){
              if(Buffer.byteLength(JSON.stringify(stored.ref))>Math.min(4096,config.maxResultBytes)) throw new Error('Native text reference limit exceeded')
              textRetention.contextRef=stored.ref; textRetention.stored=true; textRetention.complete=stored.ref.complete && !incomplete
            } else {
              const path=stored.path
              if (typeof path !== 'string' || !path || Buffer.byteLength(path) > Math.min(4096,config.maxResultBytes)) throw new Error('Text retention reference limit exceeded')
              textRetention.path = path; textRetention.stored = true; textRetention.complete = !incomplete
            }
          } catch (error) {
            const bounded = diagnostic(`Text retention failed: ${message(error)}`,errorCap)
            cell.error = bounded.text; truncated ||= bounded.truncated
            // Completion data may already be durable; a retention error remains
            // visible without claiming that disk persistence was rolled back.
            if (cell.status === 'running') close(cell,'failed',cell.error)
          }
        }
      }
      const items: CodeModeItem[] = []
      let remaining = Math.min(TEXT_CAP,tokens * 4)
      const error = cell.error === undefined ? undefined : textSlice(cell.error,remaining)
      if (error !== undefined) {
        truncated ||= error !== cell.error
        remaining -= Buffer.byteLength(error)
      }
      let textCount = 0
      for (const item of admitted) {
        if (item.type !== 'text') { items.push(item); continue }
        const separator = textCount ? 1 : 0
        const value = textSlice(item.text,Math.max(0,remaining - separator))
        if (value !== item.text) truncated = true
        if (value || (!item.text && remaining >= separator)) { items.push({type:'text',text:value}); remaining -= Buffer.byteLength(value) + separator; textCount++ }
        else if (!item.text) truncated = true
      }
      const text = items.filter((item): item is Extract<CodeModeItem,{type:'text'}> => item.type === 'text').map(item=>item.text).join('\n')
      if (textRetention) textRetention.omittedBytes = textRetention.admittedBytes - Buffer.byteLength(text)
      // A slow spill can overlap later output and guest completion. Keep the
      // observation cursor available until that later window is consumed.
      const status = cell.items.length || cell.truncated || cell.textIncomplete || cell.status === 'running' && cell.pendingItems ? 'running' : cell.status
      const out: CodeModeObservation = {cellId:cell.id,status,items,text,truncated,
        ...(textRetention ? {textRetention} : {}),
        ...(error === undefined ? {} : {error}), ...(cell.policyRefusal ? {policyRefusal:true} : {})}
      if (out.status !== 'running') cells.delete(cell.id)
      else if (cell.status === 'running' && !cell.finishing) cell.worker.postMessage({type:'observed'})
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
      if (admissions + [...cells.values()].filter(cell => cell.status === 'running').length >= config.maxActiveCells) throw new Error('Active cell limit exceeded')
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
      store.clear()
      for (const [key,value] of restored) store.set(key,value)
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
      const epoch = cancellationEpoch
      admissions++
      try {
        const started = event({type:'started',cellId:id,source:input.code,origin})
        if (started) {
          const pending = Promise.resolve(started)
          track(pending.catch(() => {}))
          await pending
        }
        if (disposed || epoch !== cancellationEpoch || origin.abortSignal?.aborted) throw new Error('Cell admission stopped by its owner')
      }
      catch (error) {
        const bounded = diagnostic(error,errorCap)
        throw Object.assign(new Error(bounded.text),{truncated:bounded.truncated})
      }
      finally { admissions-- }
      const worker = new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{code:input.code,cellId:id,catalog:catalogJson,store:initialStoreJson,config},execArgv:[]})
      const cell: Cell = {id,worker,origin,status:'running',items:[],bytes:0,textBytes:0,truncated:false,observer:false,yielded:false,calls:new Map(),producers:new Set(),knownTools:names,finishing:false,commitStop:new AbortController(),retentionStop:new AbortController(),textIncomplete:false,admission:Promise.resolve(),pendingBytes:0,pendingItems:0}
      cells.set(id,cell)
      worker.on('message',data => receive(cell,data))
      worker.on('error',error => close(cell,'failed',message(error)))
      worker.on('exit',code => { if (cell.status === 'running' && !cell.finishing) close(cell,'failed',`Worker exited unexpectedly (${code})`) })
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
      cancellationEpoch++
      for (const cell of cells.values()) { cell.retentionStop.abort(reason); close(cell,'terminated',reason) }
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
