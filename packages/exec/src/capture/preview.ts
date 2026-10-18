import type { CollectResult } from '../spill.ts'

/** Presentation bytes only. Exact raw bytes belong to the injected frame sink. */
export class CapturePreview {
  private parts: Buffer[] = []
  private retained = 0
  private total = 0
  constructor(private readonly cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('Invalid execution preview budget')
  }
  push(bytes: Buffer): void {
    this.total += bytes.length
    const part = Buffer.from(bytes.subarray(0, Math.max(0, this.cap - this.retained)))
    if (part.length) { this.parts.push(part); this.retained += part.length }
  }
  snapshot(): CollectResult {
    return { text: new TextDecoder().decode(Buffer.concat(this.parts), { stream: this.total > this.retained }), truncated: this.total > this.retained, lossy: this.total > this.retained }
  }
  finalize(): CollectResult { return this.snapshot() }
}
