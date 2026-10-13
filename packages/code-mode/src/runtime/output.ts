import type { CodeModeRuntimeOptions, CodeModeRuntimeEvent } from '../types.js'
import type { RuntimeLimits } from './limits.js'
import type { Cell, CellState } from './cell-state.js'
import { createUnifiedSpillStore } from '@i-harness/output-retention'
import { validateImage } from '@i-harness/image-validation'
import { waitForObservation } from '@i-harness/core-tools'
import type { CodeModeItem, CodeModeObservation, CodeModeObserveOptions, CodeModeTextRetention } from '../types.js'
import type { Retirement } from './retirement.js'
import { TEXT_CAP, ITEM_CAP, diagnostic, message, textSlice } from './limits.js'

/** Admission barrier and the sole observer/output-window and spill lifetime. */
export function createOutput(
  options: CodeModeRuntimeOptions,
  config: RuntimeLimits,
  errorCap: number,
  state: Pick<CellState, 'track' | 'retire'>,
  retirement: Pick<Retirement, 'close'>,
  event: (event: CodeModeRuntimeEvent) => void | Promise<void>,
) {
  let spillStore = options.spillStore
  const { track } = state
  const { close } = retirement
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
  async function observe(cell: Cell, duration: number, tokens: number, signal?: AbortSignal, terminate = false, observation?: CodeModeObserveOptions): Promise<CodeModeObservation> {
    if (cell.observer) throw new Error('Cell already has an active observer')
    cell.observer = true
    let removeAbort: (() => void) | undefined
    let steered = false
    try {
      if (terminate && cell.status === 'running') close(cell,'terminated','Cell terminated by observer')
      if (signal?.aborted) close(cell,'terminated',message(signal.reason ?? 'Observer aborted'))
      if (cell.status === 'running' && !cell.yielded) {
        if (signal) {
          const abort = () => close(cell,'terminated',message(signal.reason ?? 'Observer aborted'))
          signal.addEventListener('abort',abort,{once:true})
          removeAbort = () => signal.removeEventListener('abort',abort)
        }
        const reason = await waitForObservation({
          ready: () => cell.status !== 'running' || cell.yielded,
          changes: { subscribe: wake => { cell.wake = wake; return () => { if (cell.wake === wake) cell.wake = undefined } } },
          timeoutMs: duration, abortSignal: signal, userSteer: observation?.userSteer,
        })
        steered = reason === 'user-steer'
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
        ...(steered && cell.status === 'running' && !signal?.aborted ? {yielded:true as const,yieldReason:'user-steer' as const} : {}),
        ...(textRetention ? {textRetention} : {}),
        ...(error === undefined ? {} : {error}), ...(cell.policyRefusal ? {policyRefusal:true} : {})}
      if (out.status !== 'running') state.retire(cell.id)
      else if (cell.status === 'running' && !cell.finishing) cell.worker.postMessage({type:'observed'})
      return out
    } finally { removeAbort?.(); cell.observer = false }
  }
  return { output, observe }
}
export type Output = ReturnType<typeof createOutput>
