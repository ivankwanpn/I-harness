import { vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import type { FsWatchService, FsWatcherOptions, WatchCursor, WatchLease, WatchNotification } from '../../../fs-watch/src/index.ts'

export function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export function watchdog<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('observation watchdog expired')), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
export async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'ib-observation-'))
  return { root, async remove() {
    const child = relative(tmpdir(), root)
    if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('ib-observation-') || /[/\\]/.test(child)) throw new Error('Unsafe temporary cleanup')
    await rm(root, { recursive: true, force: true })
  } }
}
// Fully injected W1 contract fixture. It intentionally allows late/contradictory
// callbacks to exercise the adapter's own generation and cursor checks.
export class ControlledWatch implements FsWatchService {
  sources: ControlledLease[] = []
  acquired = gate<ControlledLease>()
  acquire = vi.fn((selection: FsWatcherOptions): WatchLease => {
    const source = new ControlledLease(selection); this.sources.push(source)
    this.acquired.resolve(source); this.acquired = gate<ControlledLease>()
    return source
  })
  close = vi.fn(async () => { await Promise.all(this.sources.map(source => source.close())) })
}
export class ControlledLease implements WatchLease {
  startup = gate<WatchCursor>()
  ready = this.startup.promise
  listeners = new Set<(event: WatchNotification) => void>()
  retired: Array<(event: WatchNotification) => void> = []
  epoch = 1; revision = 0
  constructor(readonly selection: FsWatcherOptions) { void this.ready.catch(() => {}) }
  subscribe = vi.fn((listener: (event: WatchNotification) => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener); this.retired.push(listener) }
  })
  close = vi.fn(async () => {})
  emit(event: WatchNotification) { for (const listener of [...this.listeners]) listener(event) }
  reset(reason: 'initial' | 'recovered' | 'overflow' = 'initial') {
    const cursor = { epoch: this.epoch, revision: ++this.revision }
    this.emit({ kind: 'reset', reason, cursor }); this.startup.resolve(cursor)
  }
  fail(code: 'FS_WATCH_BACKEND' | 'FS_WATCH_POLLING' | 'FS_WATCH_CAPACITY' = 'FS_WATCH_BACKEND') {
    this.startup.reject(new Error(code)); this.emit({ kind: 'unavailable', code, cursor: { epoch: this.epoch, revision: ++this.revision } })
  }
  change(path: string, kind: 'add' | 'change' | 'unlink' = 'change') {
    this.emit({ kind: 'changed', cursor: { epoch: this.epoch, revision: ++this.revision }, changes: [{ path, kind }] })
  }
}
