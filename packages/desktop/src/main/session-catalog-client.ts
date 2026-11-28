import { Worker } from 'node:worker_threads'
import type { CatalogRequest } from './session-catalog-worker.ts'

/** One reader per desktop process. A failed thread rejects its callers; the
 * next request can open a fresh read-only catalog. */
export function startCatalogReader(entry: string | URL, onExit: () => void) {
  const worker = new Worker(entry, { execArgv: [] })
  let nextId = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  worker.on('message', ({ id, value, error }: { id: number; value?: unknown; error?: Error }) => {
    const call = pending.get(id)
    if (!call) return
    pending.delete(id)
    if (error) call.reject(error)
    else call.resolve(value)
  })
  let failure: Error | undefined
  worker.on('error', error => { failure = error })
  const exited = new Promise<void>(resolve => worker.once('exit', code => {
    const reason = failure ?? Error(`Session catalog worker exited (${code})`)
    for (const call of pending.values()) call.reject(reason)
    pending.clear()
    onExit()
    resolve()
  }))
  function request<T>(request: CatalogRequest, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const id = ++nextId
    const abort = () => {
      const call = pending.get(id)
      if (!call) return
      pending.delete(id)
      try { worker.postMessage({ id, request: { method: 'cancel', target: id } satisfies CatalogRequest }) }
      catch (error) { call.reject(error instanceof Error ? error : new Error(String(error))); return }
      call.reject(signal!.reason)
    }
    const result = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: value => resolve(value as T), reject })
      try { worker.postMessage({ id, request }) }
      catch (error) { pending.delete(id); reject(error) }
    })
    if (!signal) return result
    signal.addEventListener('abort', abort, { once: true })
    return result.finally(() => signal.removeEventListener('abort', abort))
  }
  return { request, exited, terminate: () => worker.terminate() }
}
