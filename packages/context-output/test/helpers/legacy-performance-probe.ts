import { AsyncLocalStorage } from 'node:async_hooks'
import type * as Fs from 'node:fs/promises'
import type { createHash } from 'node:crypto'

type Context = { scope: string; phase: string; bodyHash?: boolean; since: number }
type Counts = Record<string, number>
const context = new AsyncLocalStorage<Context>()

/** Test-only observers attach to, and return, the original promises. No observer
 * issues I/O, changes a result, replaces a handle, or converts a failure. */
export const probe = {
  enabled: false,
  counts: {} as Record<string, Counts>,
  spans: [] as { scope: string; phase: string; elapsedMs: number; failed: boolean }[],
  segments: [] as { scope: string; phase: string; elapsedMs: number }[],
  ceilings: [] as number[],
  activeIO: 0, peakIO: 0, activeHandles: 0, peakHandles: 0, counterMs: 0,
  reset() {
    this.counts = {}; this.spans = []; this.segments = []; this.ceilings = []
    this.activeIO = this.peakIO = this.activeHandles = this.peakHandles = this.counterMs = 0
    this.enabled = true
  },
  add(name: string, amount = 1, captured = context.getStore()) {
    if (!this.enabled || !captured) return
    const start = performance.now(), key = `${captured.scope}/${captured.phase}`
    const bucket = this.counts[key] ??= {}
    bucket[name] = (bucket[name] ?? 0) + amount
    this.counterMs += performance.now() - start
  },
  transition(phase: string) {
    const current = context.getStore()
    if (current?.scope === 'transfer-owner' && current.phase !== phase) {
      const now = performance.now()
      this.segments.push({ scope: current.scope, phase: current.phase, elapsedMs: now - current.since })
      current.phase = phase; current.since = now
    }
  },
  run<T>(scope: string, phase: string, work: () => Promise<T>, bodyHash = false): Promise<T> {
    const start = performance.now()
    const current: Context = { scope, phase, bodyHash, since: start }
    const settled = (failed: boolean) => {
      const now = performance.now()
      this.spans.push({ scope, phase, elapsedMs: now - start, failed })
      this.segments.push({ scope, phase: current.phase, elapsedMs: now - current.since })
    }
    return context.run(current, () => {
      let pending: Promise<T>
      try { pending = work() } catch (failure) { settled(true); throw failure }
      void pending.then(() => settled(false), () => settled(true))
      return pending
    })
  },
  phase<T>(phase: string, work: () => Promise<T>, bodyHash = false): Promise<T> {
    return this.run(context.getStore()?.scope ?? 'unscoped', phase, work, bodyHash)
  },
  sync<T>(name: string, work: () => T): T {
    const captured = context.getStore(), started = performance.now()
    try { return work() } finally {
      this.add(name, 1, captured)
      this.add(`${name}.elapsedMs`, performance.now() - started, captured)
    }
  },
  total(name: string, scope?: string) {
    return Object.entries(this.counts).reduce((sum, [key, values]) => sum + (!scope || key.startsWith(scope + '/') ? values[name] ?? 0 : 0), 0)
  },
  snapshot() { return { counts: this.counts, spans: this.spans, segments: this.segments, ceilings: this.ceilings, activeIO: this.activeIO, peakIO: this.peakIO, activeHandles: this.activeHandles, peakHandles: this.peakHandles, counterMs: this.counterMs } },
  current() { return context.getStore() },
}

function observe<T>(pending: Promise<T>, name: string, completed?: (result: T) => void): Promise<T> {
  const captured = context.getStore()
  if (!probe.enabled || !captured) return pending
  const started = performance.now()
  probe.add(name, 1, captured); probe.activeIO++; probe.peakIO = Math.max(probe.peakIO, probe.activeIO)
  void pending.then(result => { probe.add(`${name}.nativeElapsedMs`, performance.now() - started, captured); probe.activeIO--; completed?.(result) }, failure => {
    probe.add(`${name}.nativeElapsedMs`, performance.now() - started, captured)
    probe.activeIO--; probe.add('failures', 1, captured)
    probe.add(`failure.${(failure as NodeJS.ErrnoException)?.code ?? 'unknown'}`, 1, captured)
  })
  return pending
}
function kind(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /\/pages\//.test(normalized) ? 'page' : /\/(expiry|revoke)\.[01]$/.test(normalized) ? 'slot'
    : /\/owners\//.test(normalized) ? 'ledger' : /\/blobs\//.test(normalized) ? 'body' : 'other'
}
function bytes(value: unknown): number { return typeof value === 'string' ? Buffer.byteLength(value) : ArrayBuffer.isView(value) ? value.byteLength : 0 }

export function observeFs(native: typeof Fs): typeof Fs {
  return {
    ...native,
    readdir: ((...args: Parameters<typeof native.readdir>) => {
      const captured = context.getStore()
      if (/[/\\]context-output[/\\][a-f0-9]{64}$/.test(String(args[0])) && typeof args[1] === 'object' && args[1]?.withFileTypes) probe.add('inventories')
      // Inventory recursion is separately counted and is not an authority
      // namespace pass (its readdir uses withFileTypes).
      if (/[/\\]legacy-fork-v1$/.test(String(args[0])) && args[1] === undefined) probe.add('authorityNamespaces')
      return observe(native.readdir(...args), 'readdir', result => { probe.add('readdirEntries', result.length, captured) })
    }) as typeof native.readdir,
    lstat: ((...args: Parameters<typeof native.lstat>) => observe(native.lstat(...args), 'lstat')) as typeof native.lstat,
    realpath: ((...args: Parameters<typeof native.realpath>) => observe(native.realpath(...args), 'realpath')) as typeof native.realpath,
    readFile: ((...args: Parameters<typeof native.readFile>) => {
      const captured = context.getStore(), category = kind(String(args[0]))
      return observe(native.readFile(...args), `${category}.readFile`, result => { probe.add(`${category}.readBytes`, bytes(result), captured) })
    }) as typeof native.readFile,
    open: (...args: Parameters<typeof native.open>) => {
      const captured = context.getStore(), category = kind(String(args[0]))
      return observe(native.open(...args), `${category}.open`, handle => {
        if (category === 'body' && captured?.phase === 'body-verification') captured.bodyHash = true
        probe.activeHandles++; probe.peakHandles = Math.max(probe.peakHandles, probe.activeHandles)
        probe.add(`${category}.opened`, 1, captured)
        const read = handle.read.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle)
        // Preserve the exact handle, overload arguments, promise and native close.
        handle.read = ((...input: Parameters<typeof read>) => {
          const reading = context.getStore()
          return observe(Reflect.apply(read, handle, input), `${category}.read`, (result: { bytesRead: number }) => { probe.add(`${category}.readBytes`, result.bytesRead, reading) })
        }) as typeof handle.read
        handle.sync = () => observe(sync(), `${category}.sync`)
        let closed = false
        handle.close = () => observe(close(), `${category}.close`, () => {
          if (!closed) {
            closed = true; probe.activeHandles--; probe.add(`${category}.closed`, 1, captured)
            if (category === 'body' && captured) captured.bodyHash = false
          }
        })
      })
    },
  }
}

export function observeHash(native: typeof createHash): typeof createHash {
  return (...args: Parameters<typeof native>) => {
    const hash = native(...args), update = hash.update.bind(hash)
    hash.update = ((...input: [data: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding]) => {
      const result = Reflect.apply(update, hash, input)
      const size = typeof input[0] === 'string' ? Buffer.byteLength(input[0], input[1]) : input[0].byteLength
      probe.add('hashBytes', size)
      if (context.getStore()?.bodyHash) probe.add('bodyHashBytes', size)
      return result
    }) as typeof hash.update
    return hash
  }
}

/** The statement is still executed by the original DatabaseSync. */
export function observeSql(sql: string): void {
  const match = /^PRAGMA max_page_count=(\d+)$/.exec(sql)
  if (probe.enabled && context.getStore() && match) { probe.add('sqlitePageAdmissions'); probe.ceilings.push(Number(match[1])) }
}
