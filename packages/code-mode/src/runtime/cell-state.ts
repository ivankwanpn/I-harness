import type { Worker } from 'node:worker_threads'
import type { CodeModeOrigin, CodeModeStatus, CodeModeItem, CodeModeStoreEntries, CodeModeRuntimeOptions } from '../types.js'
import type { RuntimeLimits } from './limits.js'
import { json } from './limits.js'

export interface Cell {
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

/** Sole registry, session JSON store, and accepted producer membership. */
export function createCellState(options: CodeModeRuntimeOptions, config: RuntimeLimits) {
  const cells = new Map<string, Cell>()
  const store = new Map<string, unknown>()
  const producers = new Set<Promise<void>>()
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
  return {
    entries, currentStore, track,
    accept(pending: Promise<void>, cell: Cell) { producers.add(pending); cell.producers.add(pending) },
    untrack(pending: Promise<void>, cell: Cell) { producers.delete(pending); cell.producers.delete(pending) },
    get: (id: string) => cells.get(id),
    register: (cell: Cell) => { cells.set(cell.id,cell) },
    retire: (id: string) => { cells.delete(id) },
    values: () => cells.values(),
    installStore(value: Map<string, unknown> | CodeModeStoreEntries) {
      store.clear()
      for (const [key,item] of value) store.set(key,item)
    },
    prune(retention: number) {
      for (const [cellId,cell] of cells) {
        if (cells.size < retention) break
        if (cell.status !== 'running' && !cell.observer) cells.delete(cellId)
      }
    },
    drain: () => Promise.allSettled([...producers]),
    clear() { cells.clear(); store.clear() },
  }
}
export type CellState = ReturnType<typeof createCellState>
