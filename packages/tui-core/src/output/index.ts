// M36: writer pump — terminal backpressure NEVER blocks the input/event path.
// Coalescing: while the stream is backpressured only the LATEST submitted
// frame content is kept (merge, not queue); writes go out on "drain" events
// (timer-free, pure drain-driven). An empty submit is a no-op: zero-byte
// frames must not advance counters.

export interface WriterLike {
  write(s: string): boolean
  on(name: "drain", cb: () => void): void
}

export interface WriterStats {
  bytesWritten: number
  frames: number
  pending: boolean
}

export class WriterPump {
  private readonly stream: WriterLike
  private busy = false
  private pending: string | null = null
  private bytesWritten = 0
  private frames = 0
  private idleCallbacks: Array<() => void> = []
  private drainListening = false

  constructor(stream: WriterLike) {
    this.stream = stream
  }

  submit(s: string): void {
    if (s.length === 0) return // no-op: empty frames are zero-byte idles
    this.frames += 1
    if (this.busy) {
      this.pending = s // keep only the latest frame content
      return
    }
    this.bytesWritten += s.length
    if (this.stream.write(s)) {
      this.fireIdle()
    } else {
      this.busy = true // the string is in the stream buffer; nothing to re-write
      this.listenDrain()
    }
  }

  onIdle(cb: () => void): void {
    if (this.busy) this.idleCallbacks.push(cb)
    else cb()
  }

  stats(): WriterStats {
    return { bytesWritten: this.bytesWritten, frames: this.frames, pending: this.busy }
  }

  private listenDrain(): void {
    if (this.drainListening) return
    this.drainListening = true
    this.stream.on("drain", () => {
      this.drainListening = false
      this.onDrain()
    })
  }

  private onDrain(): void {
    const next = this.pending
    this.pending = null
    if (next !== null) {
      this.bytesWritten += next.length
      if (!this.stream.write(next)) {
        this.busy = true
        this.listenDrain()
        return
      }
    }
    this.busy = false
    this.fireIdle()
  }

  private fireIdle(): void {
    const cbs = this.idleCallbacks
    this.idleCallbacks = []
    for (const cb of cbs) cb()
  }
}
