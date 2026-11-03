import type { FileHandle, open } from 'node:fs/promises'

export interface NativeRead { path: string; offset: number; requested: number; actual: number }
export const io = {
  enabled: false, opens: [] as string[], reads: [] as NativeRead[],
  afterRead: undefined as ((event: NativeRead) => Promise<void>) | undefined,
  beforeRead: undefined as ((path: string, position: number, length: number) => Promise<number | undefined>) | undefined,
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
  reset() { this.opens = []; this.reads = []; this.afterRead = undefined; this.beforeRead = undefined; this.beforeRename = undefined; this.enabled = true },
  stop() { this.enabled = false; this.afterRead = undefined; this.beforeRead = undefined; this.beforeRename = undefined },
}

/** Passthrough instrumentation: every opened handle and every successful byte is native. */
export function observeOpen(native: typeof open): typeof open {
  return async (...args: Parameters<typeof open>) => {
    const path = String(args[0]), handle = await native(...args)
    if (io.enabled) io.opens.push(path)
    const read = handle.read.bind(handle)
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (!io.enabled) return read(buffer, offset, length, position)
      const limited = await io.beforeRead?.(path, position, length)
      const result = await read(buffer, offset, limited ?? length, position)
      const event = { path, offset: position, requested: length, actual: result.bytesRead }
      io.reads.push(event); await io.afterRead?.(event)
      return result
    }) as FileHandle['read']
    return handle
  }
}
export const contentOpens = () => io.opens.filter(path => /[\\/](body|index)$/.test(path))
export const contentReads = () => io.reads.filter(event => /[\\/](body|index)$/.test(event.path))
