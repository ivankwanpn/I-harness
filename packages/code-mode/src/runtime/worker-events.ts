import type { CodeModeRuntimeOptions } from '../types.js'
import type { RuntimeLimits } from './limits.js'
import type { Cell, CellState } from './cell-state.js'
import type { Retirement } from './retirement.js'
import type { Output } from './output.js'
import { diagnostic, json, message } from './limits.js'

/** Host-call producers and handlers over each registered cell's actual worker. */
export function createWorkerEvents(
  options: CodeModeRuntimeOptions,
  config: RuntimeLimits,
  errorCap: number,
  state: Pick<CellState, 'accept' | 'untrack'>,
  retirement: Pick<Retirement, 'close' | 'complete'>,
  outputOwner: Pick<Output, 'output'>,
) {
  const { close, complete } = retirement
  const { output } = outputOwner
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
    }).finally(() => { cell.calls.delete(id); state.untrack(producer,cell) })
    state.accept(producer,cell)
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
  function attach(cell: Cell) {
    const { worker, origin } = cell
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
  }
  return { attach }
}
