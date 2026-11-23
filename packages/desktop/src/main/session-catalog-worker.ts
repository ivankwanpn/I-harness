import { parentPort } from 'node:worker_threads'
import { createCommittedSessionCatalog } from '@i-harness/desktop-gateway'

export type CatalogRequest =
  | { method: 'navigation' | 'dashboard'; root: string }
  | { method: 'close' }

const port = parentPort
if (!port) throw Error('Session catalog needs a worker port')
const catalog = createCommittedSessionCatalog()
let previousScan: Promise<unknown> = Promise.resolve()

port.on('message', async ({ id, request }: { id: number; request: CatalogRequest }) => {
  try {
    if (request.method === 'close') {
      await catalog.close()
      port.postMessage({ id })
      port.close()
      return
    }
    // Only one history replay retains a full workspace scan at a time.
    // Lightweight navigation can proceed between its filesystem reads.
    let value
    if (request.method === 'dashboard') {
      const read = previousScan.then(() => catalog.dashboard(request.root))
      previousScan = read.then(() => undefined, () => undefined)
      value = await read
    } else {
      value = await catalog.navigation(request.root)
    }
    port.postMessage({ id, value })
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error : new Error(String(error)) })
  }
})
