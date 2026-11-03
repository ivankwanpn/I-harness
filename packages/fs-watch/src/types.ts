export type FsWatchEvent = { path: string; kind: "add" | "change" | "unlink" }
export interface FsWatcherOptions { roots: string[]; ignore?: string[]; persistent?: boolean }
export interface FsWatcher {
  readonly ready: Promise<void>
  /** A competing queue, not a broadcast. Startup history is best effort. */
  readonly events: AsyncIterable<FsWatchEvent>
  close(): Promise<void>
}
export type FsWatchFailureCode = "FS_WATCH_BACKEND" | "FS_WATCH_GAP" | "FS_WATCH_POLLING" | "FS_WATCH_CLOSED" | "FS_WATCH_CAPACITY" | "FS_WATCH_CLOSE"
export class FsWatchError extends Error {
  constructor(readonly code: FsWatchFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "FsWatchError"
  }
}
export interface WatchCursor { readonly epoch: number; readonly revision: number }
export type WatchNotification =
  | { readonly kind: "changed"; readonly cursor: WatchCursor; readonly changes: readonly Readonly<FsWatchEvent>[] }
  | { readonly kind: "reset"; readonly cursor: WatchCursor; readonly reason: "initial" | "overflow" | "recovered" | "subscribe" }
  | { readonly kind: "unavailable"; readonly cursor: WatchCursor; readonly code: FsWatchFailureCode }
export interface WatchLease {
  readonly ready: Promise<WatchCursor>
  subscribe(listener: (event: WatchNotification) => void): () => void
  close(): Promise<void>
}
export interface FsWatchService { acquire(options: FsWatcherOptions): WatchLease; close(): Promise<void> }
