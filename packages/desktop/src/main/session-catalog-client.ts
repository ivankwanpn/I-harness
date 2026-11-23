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
  function request<T>(request: CatalogRequest): Promise<T> {
    const id = ++nextId
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: value => resolve(value as T), reject })
      try { worker.postMessage({ id, request }) }
      catch (error) { pending.delete(id); reject(error) }
    })
  }
  return { request, exited }
}
