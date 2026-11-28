import { parentPort } from 'node:worker_threads'
import { createCommittedSessionCatalog } from '@i-harness/desktop-gateway'

export type CatalogRequest =
  | { method: 'navigation' | 'navigationSnapshot' | 'dashboard'; root: string; sessionId?: string }
  | { method: 'cancel'; target: number }
  | { method: 'close' }

const port = parentPort
if (!port) throw Error('Session catalog needs a worker port')
const catalog = createCommittedSessionCatalog()
let previousScan: Promise<unknown> = Promise.resolve()
type Scan = { controller: AbortController; readers: Set<number>; result: ReturnType<typeof catalog.dashboard> }
const scans = new Map<string, Scan>(), requests = new Map<number, Scan>()

function scanFor(root: string): Scan {
  const existing = scans.get(root)
  if (existing && !existing.controller.signal.aborted) return existing
  const controller = new AbortController()
  const result = previousScan.then(() => { controller.signal.throwIfAborted(); return catalog.dashboard(root, controller.signal) })
  const scan: Scan = { controller, readers: new Set(), result }
  scans.set(root, scan)
  const finished = () => { if (scans.get(root) === scan) scans.delete(root) }
  previousScan = result.then(finished, finished)
  return scan
}

port.on('message', async ({ id, request }: { id: number; request: CatalogRequest }) => {
  try {
    if (request.method === 'cancel') {
      const scan = requests.get(request.target)
      if (scan) {
        requests.delete(request.target); scan.readers.delete(request.target)
        if (!scan.readers.size) scan.controller.abort()
      }
      return
    }
    if (request.method === 'close') {
      await previousScan
      await catalog.close()
      port.postMessage({ id })
      port.close()
      return
    }
    // Only one history replay retains a full workspace scan at a time.
    // Lightweight navigation can proceed between its filesystem reads.
    let value
    if (request.method === 'dashboard') {
      const scan = scanFor(request.root)
      scan.readers.add(id); requests.set(id, scan)
      try {
        value = await scan.result
        if (!scan.readers.has(id)) return
      } catch (error) {
        if (!scan.readers.has(id)) return
        throw error
      } finally { requests.delete(id); scan.readers.delete(id) }
    } else {
      value = await catalog[request.method](request.root, request.sessionId)
    }
    port.postMessage({ id, value })
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error : new Error(String(error)) })
  }
})
